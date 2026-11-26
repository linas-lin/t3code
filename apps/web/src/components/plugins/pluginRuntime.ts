// oxlint-disable-next-line eslint/no-restricted-imports -- plugin runtime exposes full lucide-react icon namespace to externalized plugins per spec 4.1
import * as LucideIcons from "lucide-react";
import * as React from "react";
import type { ComponentType } from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";

import { fetchPluginAssetText } from "./pluginClient";
import {
  CT_PLUGIN_API_VERSION,
  type CtPluginContext,
  type CtPluginHostSdk,
  type CtPluginManifest,
  type CtPluginModule,
  type CtPluginRegistration,
  type CtPluginRuntimeGlobal,
  type PluginRecordView,
} from "./pluginTypes";
import { PLUGIN_UI_KIT } from "./pluginUiKit";

const PLUGIN_CSS_ATTR = "data-ct-plugin-css";

let cachedRuntimeGlobal: CtPluginRuntimeGlobal | null = null;

export function ensurePluginRuntimeGlobal(): CtPluginRuntimeGlobal {
  if (!cachedRuntimeGlobal) {
    cachedRuntimeGlobal = Object.freeze({
      apiVersion: CT_PLUGIN_API_VERSION,
      React,
      ReactDOM,
      jsxRuntime,
      lucide: LucideIcons,
      uiKit: PLUGIN_UI_KIT,
    });
  }

  const targets: Array<Record<string, unknown>> = [
    globalThis as unknown as Record<string, unknown>,
  ];
  if (typeof window !== "undefined" && (window as unknown) !== (globalThis as unknown)) {
    targets.push(window as unknown as Record<string, unknown>);
  }

  for (const target of targets) {
    if (target.__CT_PLUGIN_RUNTIME__ !== cachedRuntimeGlobal) {
      Object.defineProperty(target, "__CT_PLUGIN_RUNTIME__", {
        value: cachedRuntimeGlobal,
        configurable: true,
        writable: false,
        enumerable: true,
      });
    }
  }

  return cachedRuntimeGlobal;
}

function findPluginStyleElements(pluginId: string): HTMLStyleElement[] {
  if (typeof document === "undefined" || !document.head) return [];
  const matches: HTMLStyleElement[] = [];
  const styles = document.head.querySelectorAll<HTMLStyleElement>(`style[${PLUGIN_CSS_ATTR}]`);
  for (const element of styles) {
    if (element.getAttribute(PLUGIN_CSS_ATTR) === pluginId) {
      matches.push(element);
    }
  }
  return matches;
}

export function injectPluginCss(pluginId: string, cssText: string): void {
  if (typeof document === "undefined" || !document.head) return;
  const existing = findPluginStyleElements(pluginId);
  if (existing.length > 0) {
    const [primary, ...duplicates] = existing;
    if (primary) {
      primary.textContent = cssText;
    }
    for (const duplicate of duplicates) {
      duplicate.remove();
    }
    return;
  }
  const style = document.createElement("style");
  style.setAttribute(PLUGIN_CSS_ATTR, pluginId);
  style.textContent = cssText;
  document.head.appendChild(style);
}

export function removePluginCss(pluginId: string): void {
  for (const element of findPluginStyleElements(pluginId)) {
    element.remove();
  }
}

type LucideIconComponent = ComponentType<{
  readonly className?: string | undefined;
  readonly "aria-hidden"?: boolean | undefined;
}>;

function isRenderableIconComponent(value: unknown): value is LucideIconComponent {
  if (typeof value === "function") return true;
  return (
    typeof value === "object" &&
    value !== null &&
    "$$typeof" in value &&
    typeof (value as { $$typeof?: unknown }).$$typeof === "symbol"
  );
}

function toPascalCase(raw: string): string {
  return raw
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join("");
}

export function resolveLucideIcon(iconName?: string | null): LucideIconComponent {
  const trimmed = iconName?.trim();
  if (!trimmed) return LucideIcons.PuzzleIcon;

  const lookup = LucideIcons as unknown as Record<string, unknown>;
  const pascal = toPascalCase(trimmed);
  const candidates = [
    `${pascal}Icon`,
    pascal,
    trimmed,
    trimmed.endsWith("Icon") ? trimmed : `${trimmed}Icon`,
  ];

  for (const key of candidates) {
    const candidate = lookup[key];
    if (isRenderableIconComponent(candidate)) {
      return candidate;
    }
  }
  return LucideIcons.PuzzleIcon;
}

export function PluginIcon({
  name,
  className,
}: {
  readonly name?: string | null | undefined;
  readonly className?: string | undefined;
}): React.ReactElement {
  const Icon = resolveLucideIcon(name);
  return React.createElement(Icon, { className, "aria-hidden": true });
}

export function resolvePluginModuleExport(rawModule: unknown): CtPluginModule {
  if (!rawModule || typeof rawModule !== "object") {
    throw new Error("Plugin entry did not evaluate to a module object.");
  }
  const record = rawModule as Record<string, unknown>;
  const candidate = record.default ?? record.plugin ?? record;
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as { activate?: unknown }).activate === "function"
  ) {
    return candidate as CtPluginModule;
  }
  throw new Error(
    "Plugin UI entry must export a default or named `plugin` object with an `activate(ctx)` method.",
  );
}

export type PluginModuleImporter = (sourceText: string, pluginId: string) => Promise<unknown>;

async function importPluginModuleFromBlob(sourceText: string): Promise<unknown> {
  if (
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    throw new Error("Blob URL dynamic import is unavailable in this environment.");
  }
  const blob = new Blob([sourceText], { type: "text/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    return await import(/* @vite-ignore */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export interface LoadedPluginInstance {
  readonly pluginId: string;
  readonly manifest: CtPluginManifest;
  readonly reloadNonce: number;
  readonly registration: CtPluginRegistration;
  readonly host: CtPluginHostSdk;
  readonly deactivate: () => Promise<void>;
}

export interface ActivatePluginOptions {
  readonly record: PluginRecordView;
  readonly host: CtPluginHostSdk;
  readonly onCleanup?: () => void;
  readonly fetchAssetText?: typeof fetchPluginAssetText;
  readonly importModule?: PluginModuleImporter;
}

export async function activatePluginRecord(
  options: ActivatePluginOptions,
): Promise<LoadedPluginInstance> {
  const { record, host, onCleanup } = options;
  const manifest = record.manifest;
  if (!manifest) {
    throw new Error(record.manifestError || `Plugin "${record.id}" has no valid manifest.`);
  }
  if (manifest.apiVersion !== CT_PLUGIN_API_VERSION) {
    throw new Error(
      `Plugin "${record.id}" targets unsupported apiVersion ${manifest.apiVersion} (host supports ${CT_PLUGIN_API_VERSION}).`,
    );
  }

  ensurePluginRuntimeGlobal();

  const fetchAsset = options.fetchAssetText ?? fetchPluginAssetText;
  const importModule = options.importModule ?? importPluginModuleFromBlob;
  const cacheBust = `${record.reloadNonce}-${record.updatedAt}`;

  let cssInjected = false;
  let pluginModule: CtPluginModule | null = null;

  try {
    if (manifest.ui?.css) {
      const cssText = await fetchAsset(record.id, manifest.ui.css, cacheBust);
      injectPluginCss(record.id, cssText);
      cssInjected = true;
    } else {
      removePluginCss(record.id);
    }

    let registration: CtPluginRegistration = {};

    if (manifest.ui?.entry) {
      if (!record.uiReady) {
        throw new Error(
          `Plugin "${record.id}" UI entry "${manifest.ui.entry}" is not built or missing.`,
        );
      }
      const jsSource = await fetchAsset(record.id, manifest.ui.entry, cacheBust);
      const rawModule = await importModule(jsSource, record.id);
      pluginModule = resolvePluginModuleExport(rawModule);

      const ctx: CtPluginContext = {
        pluginId: record.id,
        manifest,
        host,
        uiKit: PLUGIN_UI_KIT,
      };
      const result = await pluginModule.activate(ctx);
      registration = result ?? {};
    }

    let deactivated = false;
    const deactivate = async () => {
      if (deactivated) return;
      deactivated = true;
      try {
        await pluginModule?.deactivate?.();
      } catch (error) {
        console.error(`[ct-plugin] Error deactivating plugin "${record.id}":`, error);
      } finally {
        removePluginCss(record.id);
        try {
          onCleanup?.();
        } catch (error) {
          console.error(`[ct-plugin] Error running cleanup for plugin "${record.id}":`, error);
        }
      }
    };

    return {
      pluginId: record.id,
      manifest,
      reloadNonce: record.reloadNonce,
      registration,
      host,
      deactivate,
    };
  } catch (error) {
    if (cssInjected) {
      removePluginCss(record.id);
    }
    try {
      onCleanup?.();
    } catch {
      // Ignore secondary cleanup error when reporting activation failure.
    }
    throw error;
  }
}

export interface ParsedPluginShortcut {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly key: string;
}

function parsePluginShortcut(shortcut: string | undefined): ParsedPluginShortcut | null {
  if (!shortcut?.trim()) return null;
  const tokens = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (tokens.length === 0) return null;

  let mod = false;
  let ctrl = false;
  let meta = false;
  let shift = false;
  let alt = false;
  let key = "";

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "mod" || lower === "cmdorctrl" || lower === "commandorcontrol") {
      mod = true;
    } else if (lower === "ctrl" || lower === "control") {
      ctrl = true;
    } else if (lower === "meta" || lower === "cmd" || lower === "command") {
      meta = true;
    } else if (lower === "shift") {
      shift = true;
    } else if (lower === "alt" || lower === "option") {
      alt = true;
    } else {
      key = lower;
    }
  }

  if (!key) return null;
  return { mod, ctrl, meta, shift, alt, key };
}

export function matchesPluginShortcut(
  shortcut: string | undefined,
  event: Pick<
    KeyboardEvent,
    | "key"
    | "code"
    | "metaKey"
    | "ctrlKey"
    | "shiftKey"
    | "altKey"
    | "defaultPrevented"
    | "isComposing"
  >,
  isMac: boolean,
): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  const parsed = parsePluginShortcut(shortcut);
  if (!parsed) return false;

  const expectMeta = parsed.meta || (parsed.mod && isMac);
  const expectCtrl = parsed.ctrl || (parsed.mod && !isMac);
  if (event.metaKey !== expectMeta) return false;
  if (event.ctrlKey !== expectCtrl) return false;
  if (event.shiftKey !== parsed.shift) return false;
  if (event.altKey !== parsed.alt) return false;

  const eventKey = event.key.toLowerCase();
  if (eventKey === parsed.key) return true;
  if (parsed.key.length === 1 && /^[a-z]$/.test(parsed.key)) {
    return event.code === `Key${parsed.key.toUpperCase()}`;
  }
  if (parsed.key.length === 1 && /^[0-9]$/.test(parsed.key)) {
    return event.code === `Digit${parsed.key}`;
  }
  return false;
}

export function formatPluginShortcutLabel(
  shortcut: string | undefined,
  isMac: boolean,
): string | null {
  const parsed = parsePluginShortcut(shortcut);
  if (!parsed) return null;

  const keyLabel = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key;
  if (isMac) {
    const parts: string[] = [];
    if (parsed.ctrl) parts.push("⌃");
    if (parsed.alt) parts.push("⌥");
    if (parsed.shift) parts.push("⇧");
    if (parsed.meta || parsed.mod) parts.push("⌘");
    parts.push(keyLabel);
    return parts.join("");
  }

  const parts: string[] = [];
  if (parsed.ctrl || parsed.mod) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  if (parsed.meta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}
