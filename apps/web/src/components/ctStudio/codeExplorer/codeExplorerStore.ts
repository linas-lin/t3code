import { create } from "zustand";

import type { CustomRepoRecord } from "./repoScope.logic";
import { normalizeRepoCwd } from "./repoScope.logic";
import type {
  ExplorerDrawerState,
  ExplorerFileTarget,
  ExplorerNavHistoryEntry,
  ExplorerSearchMode,
} from "./types";

const SELECTED_SCOPES_KEY = "t3code:ct-studio:code-explorer:selected-scopes";
const CUSTOM_REPOS_KEY = "t3code:ct-studio:code-explorer:custom-repos";
const MAX_HISTORY_ENTRIES = 60;

function safeReadJson<T>(key: string, fallback: T): T {
  try {
    if (typeof window === "undefined" || !window.localStorage) return fallback;
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeWriteJson(key: string, value: unknown): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota or restricted context errors.
  }
}

export function buildExplorerFileKey(repoId: string, relativePath: string): string {
  return `${repoId}::${relativePath}`;
}

interface CodeExplorerStoreState {
  open: boolean;
  mode: ExplorerSearchMode;
  focusSearchToken: number;
  selectedScopeIds: ReadonlyArray<string>;
  hasExplicitScopeSelection: boolean;
  customRepos: ReadonlyArray<CustomRepoRecord>;
  activeTarget: ExplorerFileTarget | null;
  revealCounter: number;
  history: ReadonlyArray<ExplorerNavHistoryEntry>;
  historyIndex: number;
  drawer: ExplorerDrawerState | null;

  openExplorer: (mode?: ExplorerSearchMode) => void;
  closeExplorer: () => void;
  setMode: (mode: ExplorerSearchMode) => void;
  toggleScopeId: (scopeId: string) => void;
  setSelectedScopeIds: (scopeIds: ReadonlyArray<string>) => void;
  addCustomRepo: (repo: CustomRepoRecord) => void;
  removeCustomRepo: (cwd: string) => void;
  openFileTarget: (
    target: ExplorerFileTarget,
    options?: { readonly recordHistory?: boolean },
  ) => void;
  navigateBack: () => ExplorerNavHistoryEntry | null;
  navigateForward: () => ExplorerNavHistoryEntry | null;
  setDrawer: (drawer: ExplorerDrawerState | null) => void;
  resetForTest: () => void;
}

const storedSelectedScopes = safeReadJson<string[] | null>(SELECTED_SCOPES_KEY, null);
const storedCustomRepos = safeReadJson<CustomRepoRecord[]>(CUSTOM_REPOS_KEY, []);

export const useCodeExplorerStore = create<CodeExplorerStoreState>((set, get) => ({
  open: false,
  mode: "code",
  focusSearchToken: 0,
  selectedScopeIds: Array.isArray(storedSelectedScopes) ? storedSelectedScopes : [],
  hasExplicitScopeSelection: Array.isArray(storedSelectedScopes),
  customRepos: Array.isArray(storedCustomRepos) ? storedCustomRepos : [],
  activeTarget: null,
  revealCounter: 0,
  history: [],
  historyIndex: -1,
  drawer: null,

  openExplorer: (mode) =>
    set((state) => ({
      open: true,
      mode: mode ?? state.mode,
      focusSearchToken: state.focusSearchToken + 1,
    })),

  closeExplorer: () => set({ open: false }),

  setMode: (mode) => set({ mode }),

  toggleScopeId: (scopeId) =>
    set((state) => {
      const exists = state.selectedScopeIds.includes(scopeId);
      const next = exists
        ? state.selectedScopeIds.filter((id) => id !== scopeId)
        : [...state.selectedScopeIds, scopeId];
      safeWriteJson(SELECTED_SCOPES_KEY, next);
      return { selectedScopeIds: next, hasExplicitScopeSelection: true };
    }),

  setSelectedScopeIds: (scopeIds) =>
    set(() => {
      const unique = Array.from(new Set(scopeIds));
      safeWriteJson(SELECTED_SCOPES_KEY, unique);
      return { selectedScopeIds: unique, hasExplicitScopeSelection: true };
    }),

  addCustomRepo: (repo) =>
    set((state) => {
      const normalized = normalizeRepoCwd(repo.cwd);
      if (!normalized) return state;
      if (state.customRepos.some((item) => normalizeRepoCwd(item.cwd) === normalized)) {
        return state;
      }
      const next = [...state.customRepos, { ...repo, cwd: normalized }];
      safeWriteJson(CUSTOM_REPOS_KEY, next);
      return { customRepos: next };
    }),

  removeCustomRepo: (cwd) =>
    set((state) => {
      const normalized = normalizeRepoCwd(cwd);
      const next = state.customRepos.filter((item) => normalizeRepoCwd(item.cwd) !== normalized);
      safeWriteJson(CUSTOM_REPOS_KEY, next);
      return { customRepos: next };
    }),

  openFileTarget: (target, options) =>
    set((state) => {
      const nextReveal = state.revealCounter + 1;
      const nextTarget: ExplorerFileTarget = {
        ...target,
        revealToken: nextReveal,
      };

      let nextHistory = state.history;
      let nextHistoryIndex = state.historyIndex;
      if (options?.recordHistory !== false) {
        const entry: ExplorerNavHistoryEntry = {
          repoId: target.repoId,
          repoName: target.repoName,
          cwd: target.cwd,
          environmentId: target.environmentId,
          relativePath: target.relativePath,
          lineNumber: target.lineNumber ?? 1,
          column: target.column ?? 1,
        };
        const current = state.history[state.historyIndex];
        const isDuplicate =
          current &&
          current.repoId === entry.repoId &&
          current.relativePath === entry.relativePath &&
          current.lineNumber === entry.lineNumber;
        if (!isDuplicate) {
          const truncated = state.history.slice(0, state.historyIndex + 1);
          const appended = [...truncated, entry].slice(-MAX_HISTORY_ENTRIES);
          nextHistory = appended;
          nextHistoryIndex = appended.length - 1;
        }
      }

      return {
        activeTarget: nextTarget,
        revealCounter: nextReveal,
        history: nextHistory,
        historyIndex: nextHistoryIndex,
      };
    }),

  navigateBack: () => {
    const state = get();
    if (state.historyIndex <= 0) return null;
    const nextIndex = state.historyIndex - 1;
    const entry = state.history[nextIndex];
    if (!entry) return null;
    set({ historyIndex: nextIndex });
    get().openFileTarget(
      {
        repoId: entry.repoId,
        repoName: entry.repoName,
        cwd: entry.cwd,
        environmentId: entry.environmentId,
        relativePath: entry.relativePath,
        lineNumber: entry.lineNumber,
        column: entry.column,
      },
      { recordHistory: false },
    );
    return entry;
  },

  navigateForward: () => {
    const state = get();
    if (state.historyIndex < 0 || state.historyIndex >= state.history.length - 1) return null;
    const nextIndex = state.historyIndex + 1;
    const entry = state.history[nextIndex];
    if (!entry) return null;
    set({ historyIndex: nextIndex });
    get().openFileTarget(
      {
        repoId: entry.repoId,
        repoName: entry.repoName,
        cwd: entry.cwd,
        environmentId: entry.environmentId,
        relativePath: entry.relativePath,
        lineNumber: entry.lineNumber,
        column: entry.column,
      },
      { recordHistory: false },
    );
    return entry;
  },

  setDrawer: (drawer) => set({ drawer }),

  resetForTest: () =>
    set({
      open: false,
      mode: "code",
      focusSearchToken: 0,
      selectedScopeIds: [],
      hasExplicitScopeSelection: false,
      customRepos: [],
      activeTarget: null,
      revealCounter: 0,
      history: [],
      historyIndex: -1,
      drawer: null,
    }),
}));
