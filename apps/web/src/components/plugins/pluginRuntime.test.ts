import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { __resetDesktopPrimaryAuthForTests } from "../../environments/primary/desktopAuth";
import { createPluginApiFetch } from "./pluginClient";
import { createPluginHostSdk } from "./pluginHostBridge";
import {
  activatePluginRecord,
  ensurePluginRuntimeGlobal,
  formatPluginShortcutLabel,
  injectPluginCss,
  matchesPluginShortcut,
  removePluginCss,
  resolveLucideIcon,
  resolvePluginModuleExport,
} from "./pluginRuntime";
import type { PluginRecordView } from "./pluginTypes";

function makeFakeHeadDocument() {
  const elements: Array<{
    tagName: string;
    attrs: Map<string, string>;
    textContent: string;
    setAttribute: (k: string, v: string) => void;
    getAttribute: (k: string) => string | null;
    remove: () => void;
  }> = [];

  const head = {
    appendChild: (el: (typeof elements)[number]) => {
      elements.push(el);
      return el;
    },
    querySelectorAll: () =>
      elements.filter((el) => el.tagName === "STYLE" && el.attrs.has("data-ct-plugin-css")),
  };

  const doc = {
    head,
    createElement: (tag: string) => {
      const attrs = new Map<string, string>();
      const el = {
        tagName: tag.toUpperCase(),
        attrs,
        textContent: "",
        setAttribute: (k: string, v: string) => {
          attrs.set(k, v);
        },
        getAttribute: (k: string) => attrs.get(k) ?? null,
        remove: () => {
          const idx = elements.indexOf(el);
          if (idx !== -1) elements.splice(idx, 1);
        },
      };
      return el;
    },
  };

  return { doc, elements };
}

function makeSampleRecord(overrides: Partial<PluginRecordView> = {}): PluginRecordView {
  return {
    id: "demo-plugin",
    source: { kind: "local", path: "/tmp/demo-plugin" },
    rootDir: "/tmp/demo-plugin",
    enabled: true,
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    reloadNonce: 1,
    manifest: {
      id: "demo-plugin",
      name: "Demo Plugin",
      version: "1.0.0",
      apiVersion: 1,
      ui: {
        entry: "dist/ui.mjs",
        css: "dist/ui.css",
      },
      permissions: ["threads", "workspace"],
    },
    manifestError: null,
    uiReady: true,
    backend: {
      configured: false,
      activation: null,
      status: "none",
      error: null,
      startedAt: null,
    },
    ...overrides,
  };
}

describe("pluginRuntime", () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    vi.unstubAllGlobals();
  });

  it("mounts frozen window.__CT_PLUGIN_RUNTIME__ with apiVersion 1, React, ReactDOM, jsxRuntime, lucide, and uiKit", () => {
    const runtime = ensurePluginRuntimeGlobal();
    expect(runtime.apiVersion).toBe(1);
    expect(runtime.React).toBeDefined();
    expect(runtime.ReactDOM).toBeDefined();
    expect(runtime.jsxRuntime).toBeDefined();
    expect(runtime.lucide).toBeDefined();
    expect(runtime.uiKit.Button).toBeDefined();
    expect(runtime.uiKit.Dialog).toBeDefined();
    expect(runtime.uiKit.DropdownMenu).toBeDefined();
    expect(runtime.uiKit.ScrollArea).toBeDefined();
    expect(Object.isFrozen(runtime)).toBe(true);
    expect((globalThis as { __CT_PLUGIN_RUNTIME__?: unknown }).__CT_PLUGIN_RUNTIME__).toBe(runtime);
  });

  it("injects, updates, and cleans up plugin <style data-ct-plugin-css> elements", () => {
    const { doc, elements } = makeFakeHeadDocument();
    vi.stubGlobal("document", doc);

    injectPluginCss("alpha", ".a { color: red; }");
    expect(elements).toHaveLength(1);
    expect(elements[0]?.getAttribute("data-ct-plugin-css")).toBe("alpha");
    expect(elements[0]?.textContent).toBe(".a { color: red; }");

    injectPluginCss("alpha", ".a { color: blue; }");
    expect(elements).toHaveLength(1);
    expect(elements[0]?.textContent).toBe(".a { color: blue; }");

    injectPluginCss("beta", ".b { color: green; }");
    expect(elements).toHaveLength(2);

    removePluginCss("alpha");
    expect(elements).toHaveLength(1);
    expect(elements[0]?.getAttribute("data-ct-plugin-css")).toBe("beta");
  });

  it("resolves lucide icons by kebab-case or PascalCase with fallback", () => {
    const grid = resolveLucideIcon("layout-grid");
    const gridPascal = resolveLucideIcon("LayoutGrid");
    const fallback = resolveLucideIcon("non-existent-icon-xyz-999");

    expect(grid).toBe(gridPascal);
    expect(fallback).toBe(resolveLucideIcon(undefined));
  });

  it("resolves default and named plugin exports and rejects invalid modules", () => {
    const activate = () => ({});
    expect(resolvePluginModuleExport({ default: { activate } }).activate).toBe(activate);
    expect(resolvePluginModuleExport({ plugin: { activate } }).activate).toBe(activate);
    expect(() => resolvePluginModuleExport({ foo: 123 })).toThrow(/activate/);
  });

  it("activates a plugin, injects CSS, and cleanly deactivates + removes CSS", async () => {
    const { doc, elements } = makeFakeHeadDocument();
    vi.stubGlobal("document", doc);

    const deactivateSpy = vi.fn();
    const cleanupSpy = vi.fn();
    const fetchAssetText = vi.fn(async (_id: string, assetPath: string) => {
      if (assetPath.endsWith(".css")) return ".demo { opacity: 1; }";
      return "export default {}";
    });
    const importModule = vi.fn(async () => ({
      default: {
        activate: () => ({
          commands: [{ id: "hello", title: "Hello", run: () => {} }],
        }),
        deactivate: deactivateSpy,
      },
    }));

    const { host, dispose } = createPluginHostSdk("demo-plugin", {
      setBadge: () => {},
      subscribeNavigate: () => () => {},
    });

    const instance = await activatePluginRecord({
      record: makeSampleRecord(),
      host,
      onCleanup: () => {
        dispose();
        cleanupSpy();
      },
      fetchAssetText,
      importModule,
    });

    expect(elements).toHaveLength(1);
    expect(elements[0]?.textContent).toBe(".demo { opacity: 1; }");
    expect(instance.registration.commands).toHaveLength(1);

    await instance.deactivate();
    await instance.deactivate();
    expect(deactivateSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(elements).toHaveLength(0);
  });

  it("rejects unsupported apiVersion and cleans up CSS if activate throws", async () => {
    const { doc, elements } = makeFakeHeadDocument();
    vi.stubGlobal("document", doc);

    const { host } = createPluginHostSdk("demo-plugin", {
      setBadge: () => {},
      subscribeNavigate: () => () => {},
    });

    await expect(
      activatePluginRecord({
        record: makeSampleRecord({
          manifest: {
            id: "demo-plugin",
            name: "Demo",
            version: "2.0.0",
            apiVersion: 99,
          },
        }),
        host,
      }),
    ).rejects.toThrow(/unsupported apiVersion 99/);

    const cleanupSpy = vi.fn();
    await expect(
      activatePluginRecord({
        record: makeSampleRecord(),
        host,
        onCleanup: cleanupSpy,
        fetchAssetText: async (_id, path) => (path.endsWith(".css") ? ".x{}" : "export default {}"),
        importModule: async () => ({
          default: {
            activate: () => {
              throw new Error("boom in activate");
            },
          },
        }),
      }),
    ).rejects.toThrow("boom in activate");

    expect(elements).toHaveLength(0);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("tunnels non-GET/POST methods via POST + _ct_method with desktop bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("window", {
      location: {
        origin: "t3code-dev://app",
        href: "t3code-dev://app/plugins/ct-studio",
      },
      desktopBridge: {
        getLocalEnvironmentEnabled: () => true,
        getLocalEnvironmentBootstraps: () => [
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
          },
        ],
        getLocalEnvironmentBearerToken: async () => "desktop-secret-token",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const pluginFetch = createPluginApiFetch("ct-studio");

    await pluginFetch("/api/items?status=open");
    const [getUrl, getInit] = fetchMock.mock.calls[0]!;
    expect(getUrl).toBe("http://127.0.0.1:3773/api/plugins/ct-studio/api/api/items?status=open");
    expect(getInit?.method).toBe("GET");
    expect(getInit?.credentials).toBe("omit");
    expect(new Headers(getInit?.headers).get("Authorization")).toBe("Bearer desktop-secret-token");

    await pluginFetch("/api/items/42?force=1", {
      method: "DELETE",
      body: JSON.stringify({ reason: "cleanup" }),
      headers: { "Content-Type": "application/json" },
    });
    const [delUrl, delInit] = fetchMock.mock.calls[1]!;
    expect(delUrl).toBe(
      "http://127.0.0.1:3773/api/plugins/ct-studio/api/api/items/42?force=1&_ct_method=DELETE",
    );
    expect(delInit?.method).toBe("POST");
    expect(delInit?.body).toBe(JSON.stringify({ reason: "cleanup" }));
  });

  it("matches and formats plugin sidebar shortcuts per platform", () => {
    expect(formatPluginShortcutLabel("Mod+Shift+J", true)).toBe("⇧⌘J");
    expect(formatPluginShortcutLabel("Mod+Shift+J", false)).toBe("Ctrl+Shift+J");

    expect(
      matchesPluginShortcut(
        "Mod+Shift+J",
        {
          key: "J",
          code: "KeyJ",
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
          defaultPrevented: false,
          isComposing: false,
        },
        true,
      ),
    ).toBe(true);

    expect(
      matchesPluginShortcut(
        "Mod+Shift+J",
        {
          key: "j",
          code: "KeyJ",
          metaKey: false,
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
          defaultPrevented: false,
          isComposing: false,
        },
        false,
      ),
    ).toBe(true);
  });
});
