import { useSyncExternalStore } from "react";
import { create } from "zustand";

import type { IdeDiffFileEntry, IdeDiffTreeViewMode, IdeDiffViewMode } from "./types";

export const DEFAULT_IDE_DIFF_ENABLED = true;
export const NARROW_DIFF_BREAKPOINT_PX = 720;

const IDE_DIFF_ENABLED_STORAGE_KEY = "t3code:ct-studio:ide-diff-enabled";
const IDE_DIFF_PREFS_STORAGE_KEY = "t3code:ct-studio:ide-diff-prefs";
const IDE_DIFF_VIEWED_STORAGE_KEY = "t3code:ct-studio:ide-diff-viewed";
const MAX_VIEWED_SCOPES = 60;
const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 480;

export interface IdeDiffPreferences {
  readonly treeViewMode: IdeDiffTreeViewMode;
  readonly collapseUnchanged: boolean;
  readonly hideViewed: boolean;
  readonly treeOpen: boolean;
  readonly treeWidth: number;
}

const DEFAULT_IDE_DIFF_PREFERENCES: IdeDiffPreferences = {
  treeViewMode: "tree",
  collapseUnchanged: true,
  hideViewed: false,
  treeOpen: true,
  treeWidth: 260,
};

function clampTreeWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_IDE_DIFF_PREFERENCES.treeWidth;
  return Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, Math.round(width)));
}

function safeReadStorage(key: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWriteStorage(key: string, value: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota / restricted context errors.
  }
}

function readIdeDiffEnabled(): boolean {
  const raw = safeReadStorage(IDE_DIFF_ENABLED_STORAGE_KEY);
  if (raw === null) return DEFAULT_IDE_DIFF_ENABLED;
  if (raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  return DEFAULT_IDE_DIFF_ENABLED;
}

const enabledListeners = new Set<() => void>();

export function writeIdeDiffEnabled(enabled: boolean): void {
  safeWriteStorage(IDE_DIFF_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
  for (const listener of enabledListeners) listener();
}

function subscribeIdeDiffEnabled(listener: () => void): () => void {
  enabledListeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === IDE_DIFF_ENABLED_STORAGE_KEY || event.key === null) {
      listener();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    enabledListeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

export function useIdeDiffEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(
    subscribeIdeDiffEnabled,
    readIdeDiffEnabled,
    () => DEFAULT_IDE_DIFF_ENABLED,
  );
  return [enabled, writeIdeDiffEnabled] as const;
}

function readStoredPreferences(): IdeDiffPreferences {
  const raw = safeReadStorage(IDE_DIFF_PREFS_STORAGE_KEY);
  if (!raw) return DEFAULT_IDE_DIFF_PREFERENCES;
  try {
    const parsed = JSON.parse(raw) as Partial<IdeDiffPreferences>;
    return {
      treeViewMode: parsed.treeViewMode === "flat" ? "flat" : "tree",
      collapseUnchanged:
        typeof parsed.collapseUnchanged === "boolean"
          ? parsed.collapseUnchanged
          : DEFAULT_IDE_DIFF_PREFERENCES.collapseUnchanged,
      hideViewed:
        typeof parsed.hideViewed === "boolean"
          ? parsed.hideViewed
          : DEFAULT_IDE_DIFF_PREFERENCES.hideViewed,
      treeOpen:
        typeof parsed.treeOpen === "boolean"
          ? parsed.treeOpen
          : DEFAULT_IDE_DIFF_PREFERENCES.treeOpen,
      treeWidth:
        typeof parsed.treeWidth === "number"
          ? clampTreeWidth(parsed.treeWidth)
          : DEFAULT_IDE_DIFF_PREFERENCES.treeWidth,
    };
  } catch {
    return DEFAULT_IDE_DIFF_PREFERENCES;
  }
}

interface IdeDiffPreferencesStoreState {
  preferences: IdeDiffPreferences;
  updatePreferences: (patch: Partial<IdeDiffPreferences>) => void;
}

const useIdeDiffPreferencesStore = create<IdeDiffPreferencesStoreState>((set) => ({
  preferences: readStoredPreferences(),
  updatePreferences: (patch) =>
    set((state) => {
      const next: IdeDiffPreferences = {
        ...state.preferences,
        ...patch,
        treeWidth:
          patch.treeWidth !== undefined
            ? clampTreeWidth(patch.treeWidth)
            : state.preferences.treeWidth,
      };
      safeWriteStorage(IDE_DIFF_PREFS_STORAGE_KEY, JSON.stringify(next));
      return { preferences: next };
    }),
}));

export function useIdeDiffPreferences() {
  const preferences = useIdeDiffPreferencesStore((state) => state.preferences);
  const updatePreferences = useIdeDiffPreferencesStore((state) => state.updatePreferences);
  return {
    preferences,
    setTreeViewMode: (treeViewMode: IdeDiffTreeViewMode) => updatePreferences({ treeViewMode }),
    setCollapseUnchanged: (collapseUnchanged: boolean) => updatePreferences({ collapseUnchanged }),
    setHideViewed: (hideViewed: boolean) => updatePreferences({ hideViewed }),
    setTreeOpen: (treeOpen: boolean) => updatePreferences({ treeOpen }),
    setTreeWidth: (treeWidth: number) => updatePreferences({ treeWidth }),
  } as const;
}

export function buildViewedFileFingerprint(entry: IdeDiffFileEntry): string {
  return [
    entry.status,
    entry.additions,
    entry.deletions,
    entry.previousPath ?? "",
    entry.fileDiff?.cacheKey ?? "",
  ].join("|");
}

interface StoredViewedScopes {
  /** Scope keys in LRU order (most recently touched last). */
  order: string[];
  /** scopeKey -> { [filePath]: fingerprint } */
  scopes: Record<string, Record<string, string>>;
}

function readStoredViewedScopes(): StoredViewedScopes {
  const raw = safeReadStorage(IDE_DIFF_VIEWED_STORAGE_KEY);
  if (!raw) return { order: [], scopes: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredViewedScopes>;
    if (!parsed || typeof parsed.scopes !== "object" || parsed.scopes === null) {
      return { order: [], scopes: {} };
    }
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((key): key is string => typeof key === "string")
      : Object.keys(parsed.scopes);
    return { order, scopes: parsed.scopes };
  } catch {
    return { order: [], scopes: {} };
  }
}

function persistViewedScopes(data: StoredViewedScopes): void {
  const trimmedOrder = data.order.slice(-MAX_VIEWED_SCOPES);
  const keep = new Set(trimmedOrder);
  const trimmedScopes: Record<string, Record<string, string>> = {};
  for (const key of trimmedOrder) {
    const scope = data.scopes[key];
    if (scope && keep.has(key) && Object.keys(scope).length > 0) {
      trimmedScopes[key] = scope;
    }
  }
  safeWriteStorage(
    IDE_DIFF_VIEWED_STORAGE_KEY,
    JSON.stringify({ order: Object.keys(trimmedScopes), scopes: trimmedScopes }),
  );
}

interface IdeDiffViewedStoreState {
  data: StoredViewedScopes;
  setViewed: (scopeKey: string, entry: IdeDiffFileEntry, viewed: boolean) => void;
  clearScope: (scopeKey: string) => void;
  resetAllForTest: () => void;
}

export const useIdeDiffViewedStore = create<IdeDiffViewedStoreState>((set) => ({
  data: readStoredViewedScopes(),
  setViewed: (scopeKey, entry, viewed) =>
    set((state) => {
      const existingScope = state.data.scopes[scopeKey] ?? {};
      const nextScope = { ...existingScope };
      if (viewed) {
        nextScope[entry.path] = buildViewedFileFingerprint(entry);
      } else {
        delete nextScope[entry.path];
      }
      const nextScopes = { ...state.data.scopes };
      if (Object.keys(nextScope).length === 0) {
        delete nextScopes[scopeKey];
      } else {
        nextScopes[scopeKey] = nextScope;
      }
      const nextOrder = state.data.order.filter((key) => key !== scopeKey);
      if (nextScopes[scopeKey]) nextOrder.push(scopeKey);
      const trimmedOrder = nextOrder.slice(-MAX_VIEWED_SCOPES);
      const trimmedScopes: Record<string, Record<string, string>> = {};
      for (const key of trimmedOrder) {
        const value = nextScopes[key];
        if (value) trimmedScopes[key] = value;
      }
      const nextData: StoredViewedScopes = { order: trimmedOrder, scopes: trimmedScopes };
      persistViewedScopes(nextData);
      return { data: nextData };
    }),
  clearScope: (scopeKey) =>
    set((state) => {
      if (!(scopeKey in state.data.scopes)) return state;
      const nextScopes = { ...state.data.scopes };
      delete nextScopes[scopeKey];
      const nextData: StoredViewedScopes = {
        order: state.data.order.filter((key) => key !== scopeKey),
        scopes: nextScopes,
      };
      persistViewedScopes(nextData);
      return { data: nextData };
    }),
  resetAllForTest: () => set({ data: { order: [], scopes: {} } }),
}));

export function isEntryViewedInRecord(
  scopeRecord: Readonly<Record<string, string>> | undefined,
  entry: IdeDiffFileEntry,
): boolean {
  if (!scopeRecord) return false;
  const savedFingerprint = scopeRecord[entry.path];
  return savedFingerprint !== undefined && savedFingerprint === buildViewedFileFingerprint(entry);
}

export function useIdeDiffViewedFiles(scopeKey: string) {
  const scopeRecord = useIdeDiffViewedStore((state) => state.data.scopes[scopeKey]);
  const setViewedRaw = useIdeDiffViewedStore((state) => state.setViewed);
  const clearScopeRaw = useIdeDiffViewedStore((state) => state.clearScope);

  const isViewed = (entry: IdeDiffFileEntry): boolean => isEntryViewedInRecord(scopeRecord, entry);
  const setViewed = (entry: IdeDiffFileEntry, viewed: boolean) => {
    setViewedRaw(scopeKey, entry, viewed);
  };
  const toggleViewed = (entry: IdeDiffFileEntry): boolean => {
    const next = !isViewed(entry);
    setViewedRaw(scopeKey, entry, next);
    return next;
  };
  const clearScope = () => clearScopeRaw(scopeKey);
  const viewedCountFor = (entries: ReadonlyArray<IdeDiffFileEntry>): number => {
    let count = 0;
    for (const entry of entries) {
      if (isViewed(entry)) count += 1;
    }
    return count;
  };

  return {
    isViewed,
    setViewed,
    toggleViewed,
    clearScope,
    viewedCountFor,
  } as const;
}

export function resolveEffectiveDiffLayout(input: {
  readonly containerWidth: number;
  readonly fullscreen: boolean;
  readonly userLayout: IdeDiffViewMode;
  readonly userTreeOpen: boolean;
}): {
  readonly effectiveLayout: IdeDiffViewMode;
  readonly effectiveTreeOpen: boolean;
  readonly isNarrow: boolean;
} {
  const isNarrow =
    !input.fullscreen &&
    input.containerWidth > 0 &&
    input.containerWidth < NARROW_DIFF_BREAKPOINT_PX;
  if (isNarrow) {
    return {
      effectiveLayout: "unified",
      effectiveTreeOpen: false,
      isNarrow: true,
    };
  }
  return {
    effectiveLayout: input.userLayout,
    effectiveTreeOpen: input.userTreeOpen,
    isNarrow: false,
  };
}
