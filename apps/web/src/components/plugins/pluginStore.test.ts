import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ActivatePluginOptions, LoadedPluginInstance } from "./pluginRuntime";
import { __setPluginStoreDepsForTests, usePluginStore } from "./pluginStore";
import type { PluginNavigationEvent, PluginRecordView } from "./pluginTypes";

function makePlugin(id: string, overrides: Partial<PluginRecordView> = {}): PluginRecordView {
  return {
    id,
    source: {
      kind: "git",
      url: `https://example.com/${id}.git`,
      ref: "main",
      commit: "abcdef1234",
    },
    rootDir: `/state/plugins/installed/${id}`,
    enabled: true,
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    reloadNonce: 1,
    manifest: {
      id,
      name: `Plugin ${id}`,
      version: "1.0.0",
      apiVersion: 1,
      ui: { entry: "ui.mjs" },
      contributes: {
        sidebar: { label: `Plugin ${id}`, icon: "layout-grid" },
        slots: ["mainView", "commands"],
      },
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

describe("pluginStore", () => {
  beforeEach(async () => {
    __setPluginStoreDepsForTests(null);
    await usePluginStore.getState().resetForTests();
  });

  afterEach(async () => {
    __setPluginStoreDepsForTests(null);
    await usePluginStore.getState().resetForTests();
  });

  it("loads enabled plugins on refreshPlugins and isolates activation errors", async () => {
    const goodPlugin = makePlugin("good");
    const brokenPlugin = makePlugin("broken");
    const disabledPlugin = makePlugin("disabled", { enabled: false });

    const activateMock = vi.fn(
      async (options: ActivatePluginOptions): Promise<LoadedPluginInstance> => {
        if (options.record.id === "broken") {
          throw new Error("syntax error in broken plugin");
        }
        options.host.ui.setBadge(3);
        return {
          pluginId: options.record.id,
          manifest: options.record.manifest!,
          reloadNonce: options.record.reloadNonce,
          registration: {
            commands: [{ id: "open", title: "Open Good", run: () => {} }],
          },
          host: options.host,
          deactivate: async () => {
            options.onCleanup?.();
          },
        };
      },
    );

    __setPluginStoreDepsForTests({
      listPlugins: async () => ({
        apiVersion: 1,
        plugins: [goodPlugin, brokenPlugin, disabledPlugin],
      }),
      activatePluginRecord: activateMock,
    });

    await usePluginStore.getState().refreshPlugins();

    const state = usePluginStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.plugins).toHaveLength(3);
    expect(state.runtimeById.good?.status).toBe("loaded");
    expect(state.runtimeById.good?.badgeCount).toBe(3);
    expect(state.runtimeById.good?.registration?.commands).toHaveLength(1);
    expect(state.runtimeById.broken?.status).toBe("error");
    expect(state.runtimeById.broken?.error).toContain("syntax error");
    expect(state.runtimeById.disabled).toBeUndefined();
    expect(activateMock).toHaveBeenCalledTimes(2);
  });

  it("deactivates previous instance on reloadPlugin and activates the updated nonce", async () => {
    const initial = makePlugin("alpha", { reloadNonce: 1 });
    const reloaded = makePlugin("alpha", { reloadNonce: 2 });
    const deactivateSpies: Array<ReturnType<typeof vi.fn>> = [];

    const activateMock = vi.fn(
      async (options: ActivatePluginOptions): Promise<LoadedPluginInstance> => {
        const deactivateSpy = vi.fn(async () => {
          options.onCleanup?.();
        });
        deactivateSpies.push(deactivateSpy);
        return {
          pluginId: options.record.id,
          manifest: options.record.manifest!,
          reloadNonce: options.record.reloadNonce,
          registration: {},
          host: options.host,
          deactivate: deactivateSpy,
        };
      },
    );

    __setPluginStoreDepsForTests({
      listPlugins: async () => ({ apiVersion: 1, plugins: [initial] }),
      reloadPluginRemote: async () => ({ plugin: reloaded }),
      activatePluginRecord: activateMock,
    });

    await usePluginStore.getState().refreshPlugins();
    expect(usePluginStore.getState().runtimeById.alpha?.loadedNonce).toBe(1);

    await usePluginStore.getState().reloadPlugin("alpha");
    expect(deactivateSpies).toHaveLength(2);
    expect(deactivateSpies[0]).toHaveBeenCalledTimes(1);
    expect(usePluginStore.getState().runtimeById.alpha?.loadedNonce).toBe(2);
    expect(usePluginStore.getState().runtimeById.alpha?.status).toBe("loaded");
  });

  it("deactivates on disable and cleans up state on uninstall", async () => {
    const plugin = makePlugin("beta");
    const deactivateSpy = vi.fn();

    __setPluginStoreDepsForTests({
      listPlugins: async () => ({ apiVersion: 1, plugins: [plugin] }),
      setPluginEnabled: async (_id, enabled) => ({ plugin: { ...plugin, enabled } }),
      uninstallPlugin: async (id) => ({ uninstalled: id }),
      activatePluginRecord: async (options) => ({
        pluginId: options.record.id,
        manifest: options.record.manifest!,
        reloadNonce: options.record.reloadNonce,
        registration: {},
        host: options.host,
        deactivate: async () => {
          deactivateSpy();
          options.onCleanup?.();
        },
      }),
    });

    await usePluginStore.getState().refreshPlugins();
    expect(usePluginStore.getState().runtimeById.beta?.status).toBe("loaded");

    await usePluginStore.getState().enablePlugin("beta", false);
    expect(deactivateSpy).toHaveBeenCalledTimes(1);
    expect(usePluginStore.getState().runtimeById.beta?.status).toBe("idle");

    await usePluginStore.getState().uninstallPlugin("beta", { removeData: true });
    expect(usePluginStore.getState().plugins).toHaveLength(0);
    expect(usePluginStore.getState().runtimeById.beta).toBeUndefined();
  });

  it("buffers navigation events before listener mounts and delivers live events afterwards", async () => {
    const received: PluginNavigationEvent[] = [];

    usePluginStore.getState().dispatchPluginNavigation("ct-studio", {
      subpath: "jira/BLUE-123",
      search: { stage: "design" },
    });

    const unsubscribe = usePluginStore.getState().subscribePluginNavigation("ct-studio", (nav) => {
      received.push(nav);
    });

    // Buffered event flushes asynchronously via queueMicrotask.
    await Promise.resolve();
    expect(received).toEqual([{ subpath: "jira/BLUE-123", search: { stage: "design" } }]);

    usePluginStore.getState().dispatchPluginNavigation("ct-studio", {
      search: { itemId: "inbox-9" },
    });
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual({ search: { itemId: "inbox-9" } });

    unsubscribe();
    usePluginStore.getState().dispatchPluginNavigation("ct-studio", {
      search: { itemId: "inbox-10" },
    });
    expect(received).toHaveLength(2);
  });
});
