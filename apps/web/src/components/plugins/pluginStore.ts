import { msg } from "gt-react";
import { create } from "zustand";

import { m } from "~/i18n/messages";

import {
  installPlugin as installPluginApi,
  listPlugins as listPluginsApi,
  reloadPluginRemote as reloadPluginRemoteApi,
  setPluginEnabled as setPluginEnabledApi,
  uninstallPlugin as uninstallPluginApi,
  updatePlugin as updatePluginApi,
} from "./pluginClient";
import { createPluginHostSdk } from "./pluginHostBridge";
import {
  activatePluginRecord,
  ensurePluginRuntimeGlobal,
  type ActivatePluginOptions,
  type LoadedPluginInstance,
} from "./pluginRuntime";
import type {
  CtPluginHostSdk,
  CtPluginRegistration,
  PluginInstallRequest,
  PluginNavigationEvent,
  PluginRecordView,
  PluginUpdateResponse,
} from "./pluginTypes";

export type PluginLoadStatus = "idle" | "loading" | "loaded" | "error";

export interface PluginRuntimeEntry {
  readonly status: PluginLoadStatus;
  readonly error: string | null;
  readonly loadedNonce: number | null;
  readonly registration: CtPluginRegistration | null;
  readonly host: CtPluginHostSdk | null;
  readonly badgeCount: number;
  readonly lastLoadedAt: string | null;
}

export interface PluginNavigationRecord {
  readonly subpath?: string | undefined;
  readonly search: Record<string, string>;
  readonly nonce: number;
}

export interface PluginStoreDeps {
  readonly listPlugins: typeof listPluginsApi;
  readonly installPlugin: typeof installPluginApi;
  readonly setPluginEnabled: typeof setPluginEnabledApi;
  readonly updatePlugin: typeof updatePluginApi;
  readonly reloadPluginRemote: typeof reloadPluginRemoteApi;
  readonly uninstallPlugin: typeof uninstallPluginApi;
  readonly activatePluginRecord: (options: ActivatePluginOptions) => Promise<LoadedPluginInstance>;
}

const DEFAULT_DEPS: PluginStoreDeps = {
  listPlugins: listPluginsApi,
  installPlugin: installPluginApi,
  setPluginEnabled: setPluginEnabledApi,
  updatePlugin: updatePluginApi,
  reloadPluginRemote: reloadPluginRemoteApi,
  uninstallPlugin: uninstallPluginApi,
  activatePluginRecord,
};

let storeDeps: PluginStoreDeps = DEFAULT_DEPS;

export function __setPluginStoreDepsForTests(overrides: Partial<PluginStoreDeps> | null): void {
  storeDeps = overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;
}

const activeInstances = new Map<string, LoadedPluginInstance>();
const inFlightLoads = new Map<string, Promise<void>>();
const loadGenerationById = new Map<string, number>();
const navigateListenersById = new Map<string, Set<(nav: PluginNavigationEvent) => void>>();
const pendingNavigationById = new Map<string, PluginNavigationEvent>();
let navSequence = 0;

function nextLoadGeneration(pluginId: string): number {
  const next = (loadGenerationById.get(pluginId) ?? 0) + 1;
  loadGenerationById.set(pluginId, next);
  return next;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}

function upsertPluginRecord(
  list: ReadonlyArray<PluginRecordView>,
  next: PluginRecordView,
): ReadonlyArray<PluginRecordView> {
  const index = list.findIndex((item) => item.id === next.id);
  if (index === -1) return [...list, next];
  const copy = [...list];
  copy[index] = next;
  return copy;
}

function shouldActivateRecord(record: PluginRecordView): boolean {
  if (!record.enabled) return false;
  if (!record.manifest || record.manifestError) return false;
  return true;
}

export interface PluginStoreState {
  readonly plugins: ReadonlyArray<PluginRecordView>;
  readonly initialized: boolean;
  readonly loadingList: boolean;
  readonly listError: string | null;
  readonly runtimeById: Readonly<Record<string, PluginRuntimeEntry>>;
  readonly navigationById: Readonly<Record<string, PluginNavigationRecord>>;
  readonly refreshPlugins: () => Promise<ReadonlyArray<PluginRecordView>>;
  readonly syncLoadedPlugins: (
    records?: ReadonlyArray<PluginRecordView>,
    options?: { readonly forceReloadIds?: ReadonlySet<string> },
  ) => Promise<void>;
  readonly reloadPlugin: (pluginId: string) => Promise<void>;
  readonly enablePlugin: (pluginId: string, enabled: boolean) => Promise<PluginRecordView>;
  readonly installPlugin: (request: PluginInstallRequest) => Promise<PluginRecordView>;
  readonly updatePlugin: (
    pluginId: string,
    options?: { readonly runBuild?: boolean },
  ) => Promise<PluginUpdateResponse>;
  readonly uninstallPlugin: (
    pluginId: string,
    options?: { readonly removeData?: boolean },
  ) => Promise<void>;
  readonly setPluginBadge: (pluginId: string, count: number) => void;
  readonly dispatchPluginNavigation: (pluginId: string, nav: PluginNavigationEvent) => void;
  readonly subscribePluginNavigation: (
    pluginId: string,
    handler: (nav: PluginNavigationEvent) => void,
  ) => () => void;
  readonly resetForTests: () => Promise<void>;
}

async function deactivateLocalPlugin(pluginId: string): Promise<void> {
  nextLoadGeneration(pluginId);
  const existing = activeInstances.get(pluginId);
  if (existing) {
    activeInstances.delete(pluginId);
    await existing.deactivate();
  }
}

export const usePluginStore = create<PluginStoreState>((set, get) => {
  const setRuntimeEntry = (pluginId: string, entry: PluginRuntimeEntry) => {
    set((state) => ({
      runtimeById: {
        ...state.runtimeById,
        [pluginId]: entry,
      },
    }));
  };

  const removeRuntimeEntry = (pluginId: string) => {
    set((state) => {
      if (!(pluginId in state.runtimeById)) return state;
      const next = { ...state.runtimeById };
      delete next[pluginId];
      return { runtimeById: next };
    });
  };

  const loadSinglePlugin = async (record: PluginRecordView, forceReload = false): Promise<void> => {
    const existingRuntime = get().runtimeById[record.id];
    const existingInstance = activeInstances.get(record.id);

    if (
      !forceReload &&
      existingInstance &&
      existingRuntime?.status === "loaded" &&
      existingRuntime.loadedNonce === record.reloadNonce
    ) {
      return;
    }

    const inFlight = inFlightLoads.get(record.id);
    if (inFlight && !forceReload) {
      await inFlight;
      return;
    }

    const generation = nextLoadGeneration(record.id);

    const task = (async () => {
      if (existingInstance) {
        activeInstances.delete(record.id);
        await existingInstance.deactivate();
      }

      if (loadGenerationById.get(record.id) !== generation) return;

      ensurePluginRuntimeGlobal();
      setRuntimeEntry(record.id, {
        status: "loading",
        error: null,
        loadedNonce: record.reloadNonce,
        registration: null,
        host: null,
        badgeCount: 0,
        lastLoadedAt: existingRuntime?.lastLoadedAt ?? null,
      });

      const { host, dispose } = createPluginHostSdk(record.id, {
        setBadge: (count) => {
          if (loadGenerationById.get(record.id) !== generation) return;
          get().setPluginBadge(record.id, count);
        },
        subscribeNavigate: (handler) => get().subscribePluginNavigation(record.id, handler),
      });

      try {
        const instance = await storeDeps.activatePluginRecord({
          record,
          host,
          onCleanup: dispose,
        });

        if (loadGenerationById.get(record.id) !== generation) {
          await instance.deactivate();
          return;
        }

        activeInstances.set(record.id, instance);
        const currentBadge = get().runtimeById[record.id]?.badgeCount ?? 0;
        setRuntimeEntry(record.id, {
          status: "loaded",
          error: null,
          loadedNonce: record.reloadNonce,
          registration: instance.registration,
          host: instance.host,
          badgeCount: currentBadge,
          lastLoadedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (loadGenerationById.get(record.id) !== generation) return;
        setRuntimeEntry(record.id, {
          status: "error",
          error: errorToMessage(error),
          loadedNonce: record.reloadNonce,
          registration: null,
          host: null,
          badgeCount: 0,
          lastLoadedAt: existingRuntime?.lastLoadedAt ?? null,
        });
      }
    })();

    inFlightLoads.set(record.id, task);
    try {
      await task;
    } finally {
      if (inFlightLoads.get(record.id) === task) {
        inFlightLoads.delete(record.id);
      }
    }
  };

  return {
    plugins: [],
    initialized: false,
    loadingList: false,
    listError: null,
    runtimeById: {},
    navigationById: {},

    refreshPlugins: async () => {
      set({ loadingList: true, listError: null });
      try {
        const response = await storeDeps.listPlugins();
        const plugins = response.plugins;
        set({
          plugins,
          initialized: true,
          loadingList: false,
          listError: null,
        });
        await get().syncLoadedPlugins(plugins);
        return plugins;
      } catch (error) {
        set({
          initialized: true,
          loadingList: false,
          listError: errorToMessage(error),
        });
        return get().plugins;
      }
    },

    syncLoadedPlugins: async (records, options) => {
      const targetRecords = records ?? get().plugins;
      const byId = new Map(targetRecords.map((record) => [record.id, record] as const));
      const forceReloadIds = options?.forceReloadIds;

      const unloadPromises: Promise<void>[] = [];
      for (const loadedId of Array.from(activeInstances.keys())) {
        const record = byId.get(loadedId);
        if (!record || !shouldActivateRecord(record)) {
          unloadPromises.push(
            deactivateLocalPlugin(loadedId).then(() => {
              if (!record) {
                removeRuntimeEntry(loadedId);
              } else {
                setRuntimeEntry(loadedId, {
                  status: record.manifestError ? "error" : "idle",
                  error: record.manifestError,
                  loadedNonce: null,
                  registration: null,
                  host: null,
                  badgeCount: 0,
                  lastLoadedAt: null,
                });
              }
            }),
          );
        }
      }

      // Prune runtime entries for plugins that no longer exist in the registry.
      const existingRuntimeIds = Object.keys(get().runtimeById);
      for (const id of existingRuntimeIds) {
        if (!byId.has(id) && !activeInstances.has(id)) {
          removeRuntimeEntry(id);
        }
      }

      if (unloadPromises.length > 0) {
        await Promise.allSettled(unloadPromises);
      }

      const loadPromises: Promise<void>[] = [];
      for (const record of targetRecords) {
        if (!record.enabled) {
          const current = get().runtimeById[record.id];
          if (current && current.status !== "idle") {
            setRuntimeEntry(record.id, {
              status: "idle",
              error: null,
              loadedNonce: null,
              registration: null,
              host: null,
              badgeCount: 0,
              lastLoadedAt: current.lastLoadedAt,
            });
          }
          continue;
        }

        if (!record.manifest || record.manifestError) {
          setRuntimeEntry(record.id, {
            status: "error",
            error: record.manifestError || m(msg("Plugin manifest is invalid.")),
            loadedNonce: record.reloadNonce,
            registration: null,
            host: null,
            badgeCount: 0,
            lastLoadedAt: get().runtimeById[record.id]?.lastLoadedAt ?? null,
          });
          continue;
        }

        const forceReload = forceReloadIds?.has(record.id) === true;
        loadPromises.push(loadSinglePlugin(record, forceReload));
      }

      if (loadPromises.length > 0) {
        await Promise.allSettled(loadPromises);
      }
    },

    reloadPlugin: async (pluginId) => {
      const response = await storeDeps.reloadPluginRemote(pluginId);
      const nextPlugins = upsertPluginRecord(get().plugins, response.plugin);
      set({ plugins: nextPlugins });
      if (response.plugin.enabled) {
        await get().syncLoadedPlugins(nextPlugins, {
          forceReloadIds: new Set([pluginId]),
        });
      } else {
        await deactivateLocalPlugin(pluginId);
        await get().syncLoadedPlugins(nextPlugins);
      }
    },

    enablePlugin: async (pluginId, enabled) => {
      const response = await storeDeps.setPluginEnabled(pluginId, enabled);
      const nextPlugins = upsertPluginRecord(get().plugins, response.plugin);
      set({ plugins: nextPlugins });
      if (!enabled) {
        await deactivateLocalPlugin(pluginId);
      }
      await get().syncLoadedPlugins(nextPlugins);
      return response.plugin;
    },

    installPlugin: async (request) => {
      const response = await storeDeps.installPlugin(request);
      const nextPlugins = upsertPluginRecord(get().plugins, response.plugin);
      set({ plugins: nextPlugins, initialized: true, listError: null });
      await get().syncLoadedPlugins(nextPlugins, {
        forceReloadIds: new Set([response.plugin.id]),
      });
      return response.plugin;
    },

    updatePlugin: async (pluginId, options) => {
      const response = await storeDeps.updatePlugin(pluginId, options);
      const nextPlugins = upsertPluginRecord(get().plugins, response.plugin);
      set({ plugins: nextPlugins });
      await get().syncLoadedPlugins(
        nextPlugins,
        response.plugin.enabled ? { forceReloadIds: new Set([pluginId]) } : undefined,
      );
      return response;
    },

    uninstallPlugin: async (pluginId, options) => {
      await deactivateLocalPlugin(pluginId);
      await storeDeps.uninstallPlugin(pluginId, options);
      navigateListenersById.delete(pluginId);
      pendingNavigationById.delete(pluginId);
      set((state) => {
        const nextRuntime = { ...state.runtimeById };
        delete nextRuntime[pluginId];
        const nextNav = { ...state.navigationById };
        delete nextNav[pluginId];
        return {
          plugins: state.plugins.filter((item) => item.id !== pluginId),
          runtimeById: nextRuntime,
          navigationById: nextNav,
        };
      });
    },

    setPluginBadge: (pluginId, count) => {
      const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
      set((state) => {
        const existing = state.runtimeById[pluginId];
        if (!existing || existing.badgeCount === normalized) return state;
        return {
          runtimeById: {
            ...state.runtimeById,
            [pluginId]: { ...existing, badgeCount: normalized },
          },
        };
      });
    },

    dispatchPluginNavigation: (pluginId, nav) => {
      const nextRecord: PluginNavigationRecord = {
        ...(nav.subpath ? { subpath: nav.subpath } : {}),
        search: { ...nav.search },
        nonce: ++navSequence,
      };
      set((state) => ({
        navigationById: {
          ...state.navigationById,
          [pluginId]: nextRecord,
        },
      }));

      const listeners = navigateListenersById.get(pluginId);
      if (!listeners || listeners.size === 0) {
        pendingNavigationById.set(pluginId, {
          ...(nav.subpath ? { subpath: nav.subpath } : {}),
          search: { ...nav.search },
        });
        return;
      }

      pendingNavigationById.delete(pluginId);
      for (const listener of Array.from(listeners)) {
        try {
          listener(nav);
        } catch (error) {
          console.error(`[ct-plugin] Navigation handler failed for "${pluginId}":`, error);
        }
      }
    },

    subscribePluginNavigation: (pluginId, handler) => {
      let listeners = navigateListenersById.get(pluginId);
      if (!listeners) {
        listeners = new Set();
        navigateListenersById.set(pluginId, listeners);
      }
      listeners.add(handler);

      const pending = pendingNavigationById.get(pluginId);
      if (pending) {
        pendingNavigationById.delete(pluginId);
        queueMicrotask(() => {
          if (navigateListenersById.get(pluginId)?.has(handler)) {
            try {
              handler(pending);
            } catch (error) {
              console.error(
                `[ct-plugin] Buffered navigation handler failed for "${pluginId}":`,
                error,
              );
            }
          }
        });
      }

      return () => {
        const current = navigateListenersById.get(pluginId);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          navigateListenersById.delete(pluginId);
        }
      };
    },

    resetForTests: async () => {
      const ids = Array.from(activeInstances.keys());
      await Promise.allSettled(ids.map((id) => deactivateLocalPlugin(id)));
      activeInstances.clear();
      inFlightLoads.clear();
      loadGenerationById.clear();
      navigateListenersById.clear();
      pendingNavigationById.clear();
      navSequence = 0;
      set({
        plugins: [],
        initialized: false,
        loadingList: false,
        listError: null,
        runtimeById: {},
        navigationById: {},
      });
    },
  };
});
