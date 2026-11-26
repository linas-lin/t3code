import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  toThreadGroupTag,
  type ModelSelection,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg, useGT } from "gt-react";
import { useEffect, useEffectEvent, type RefObject } from "react";

import { useDiffPanelStore } from "~/diffPanelStore";
import { editorLabelForPlatform } from "~/editorLabels";
import { useOpenInPreferredEditor, usePreferredEditor } from "~/editorPreferences";
import { getRenderedAppearance, useTheme } from "~/hooks/useTheme";
import { m } from "~/i18n/messages";
import { newMessageId, newProjectId, newThreadId } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjects, useThreadShells, waitForProject } from "~/state/entities";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { projectEnvironment } from "~/state/projects";
import { primaryServerConfigAtom, primaryServerProvidersAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { vcsEnvironment } from "~/state/vcs";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { createPluginApiFetch } from "./pluginClient";
import {
  CT_PLUGIN_API_VERSION,
  type CtPluginHostSdk,
  type PluginHeaderInset,
  type PluginHostModel,
  type PluginHostModelOption,
  type PluginHostProject,
  type PluginHostProvider,
  type PluginHostThread,
  type PluginHostThreadStatus,
  type PluginHostWorkspaceSnapshot,
  type PluginNavigationEvent,
  type PluginOpenDiffRequest,
  type PluginOpenDiffResult,
  type PluginOpenInEditorResult,
  type PluginPrepareWorktreeRequest,
  type PluginPrepareWorktreeResult,
  type PluginSendThreadRequest,
  type PluginSendThreadResult,
  type PluginStartThreadRequest,
  type PluginStartThreadResult,
  type PluginToastInput,
} from "./pluginTypes";

const DRIVER_LABELS: Readonly<Record<string, string>> = {
  antigravity: "Antigravity",
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
};

function normalizePath(path: string | null | undefined): string {
  return path ? path.replaceAll("\\", "/").replace(/\/+$/, "") : "";
}

function baseLabelForProvider(provider: ServerProvider): string {
  if (provider.displayName?.trim()) return provider.displayName.trim();
  return DRIVER_LABELS[provider.driver] ?? provider.instanceId;
}

function runtimeModeForProvider(provider: ServerProvider | undefined): RuntimeMode {
  const supported = provider?.supportedRuntimeModes;
  if (!supported || supported.length === 0) return DEFAULT_RUNTIME_MODE;
  for (const preferred of [
    "full-access",
    "auto",
    "auto-accept-edits",
    "approval-required",
  ] as const) {
    if (supported.includes(preferred)) return preferred;
  }
  return supported[0] ?? DEFAULT_RUNTIME_MODE;
}

function mapHostThreadStatus(thread: EnvironmentThreadShell): PluginHostThreadStatus {
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.blockedOnThreadWait === true ||
    thread.hasActionableProposedPlan ||
    thread.runtime?.status === "waiting" ||
    thread.latestRun?.status === "waiting"
  ) {
    return "blocked";
  }
  const runStatus = thread.latestRun?.status;
  if (
    thread.runtime?.status === "running" ||
    runStatus === "preparing" ||
    runStatus === "starting" ||
    runStatus === "running" ||
    runStatus === "queued"
  ) {
    return "working";
  }
  if (runStatus === "completed") return "done";
  return "idle";
}

function buildPluginHostWorkspaceSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  projects: ReadonlyArray<EnvironmentProject>,
  editor: { readonly available: boolean; readonly label?: string | undefined },
): PluginHostWorkspaceSnapshot {
  const visibleProviders = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.status !== "disabled" &&
      provider.driver !== "replay" &&
      provider.instanceId !== "devReplay",
  );
  const labelCounts = new Map<string, number>();
  for (const provider of visibleProviders) {
    const base = baseLabelForProvider(provider);
    labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1);
  }

  const mappedProviders: PluginHostProvider[] = visibleProviders.map((provider) => {
    const base = baseLabelForProvider(provider);
    const badge = provider.badgeLabel?.trim();
    const name =
      (labelCounts.get(base) ?? 0) > 1 && badge && !base.includes(badge)
        ? `${base} (${badge})`
        : base;
    const activeModels = provider.models.filter((model) => !model.isLegacy);
    const sourceModels = activeModels.length > 0 ? activeModels : provider.models;
    const models: PluginHostModel[] = sourceModels.map((model) => {
      const descriptors = model.capabilities?.optionDescriptors ?? [];
      const options: PluginHostModelOption[] = [];
      for (const descriptor of descriptors) {
        if (descriptor.type === "select") {
          if (descriptor.options.length === 0) continue;
          const defaultChoice = descriptor.options.find((opt) => opt.isDefault);
          options.push({
            id: descriptor.id,
            label: descriptor.label,
            type: "select",
            options: descriptor.options.map((opt) => ({
              id: opt.id,
              label: opt.label,
              ...(opt.isDefault ? { isDefault: true } : {}),
            })),
            ...(descriptor.currentValue !== undefined
              ? { defaultValue: descriptor.currentValue }
              : defaultChoice
                ? { defaultValue: defaultChoice.id }
                : {}),
          });
        } else if (descriptor.type === "boolean") {
          options.push({
            id: descriptor.id,
            label: descriptor.label,
            type: "boolean",
            ...(descriptor.currentValue !== undefined
              ? { defaultValue: descriptor.currentValue }
              : {}),
          });
        }
      }
      return {
        slug: model.slug,
        name: model.name,
        ...(model.isDefault ? { isDefault: true } : {}),
        ...(options.length > 0 ? { options } : {}),
      };
    });
    const available =
      provider.installed &&
      (provider.availability ?? "available") === "available" &&
      provider.status !== "error" &&
      models.length > 0;
    return {
      id: provider.instanceId,
      driver: provider.driver,
      name,
      available,
      models,
    };
  });

  const mappedProjects: PluginHostProject[] = projects
    .filter((project) => !project.archivedAt && !project.isScratch)
    .map((project) => ({
      id: project.id,
      title: project.title,
      cwd: project.workspaceRoot,
    }));

  const defaultProject = mappedProjects[0];
  return {
    ...(defaultProject ? { defaultProjectId: defaultProject.id } : {}),
    projects: mappedProjects,
    providers: mappedProviders,
    editor: {
      available: editor.available,
      ...(editor.available && editor.label ? { label: editor.label } : {}),
    },
  };
}

function buildPluginHostThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<PluginHostThread> {
  const result: PluginHostThread[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const isSettled =
      thread.settledOverride === "settled" ||
      (thread.settledOverride !== "active" && thread.settledAt !== null);
    if (isSettled) continue;

    const rootId = thread.lineage?.rootThreadId ?? thread.id;
    const parentThreadId = thread.lineage?.parentThreadId ?? undefined;
    const relationshipToParent = thread.lineage?.relationshipToParent ?? undefined;
    const model = thread.modelSelection?.model?.trim() || undefined;

    result.push({
      threadId: thread.id,
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      title: thread.title,
      status: mapHostThreadStatus(thread),
      providerId: thread.providerInstanceId,
      ...(model ? { model } : {}),
      ...(thread.branch ? { branch: thread.branch } : {}),
      ...(thread.worktreePath ? { worktreePath: thread.worktreePath } : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(rootId !== thread.id || parentThreadId ? { rootThreadId: rootId } : {}),
      ...(relationshipToParent ? { relationshipToParent } : {}),
      ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
      ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
    });
  }
  return result;
}

function pickBestThreadForPluginDiff(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: {
    readonly environmentId: string;
    readonly threadId?: string | undefined;
    readonly worktreePath?: string | undefined;
  },
): EnvironmentThreadShell | null {
  const active = threads.filter(
    (thread) => thread.environmentId === options.environmentId && thread.archivedAt === null,
  );
  const targetWt = normalizePath(options.worktreePath);

  if (options.threadId) {
    const explicit = active.find((thread) => thread.id === options.threadId);
    if (explicit) {
      if (!targetWt || normalizePath(explicit.worktreePath) === targetWt) {
        return explicit;
      }
      const matchingChildren = active.filter(
        (thread) =>
          (thread.lineage?.parentThreadId === explicit.id ||
            thread.lineage?.rootThreadId === explicit.id) &&
          normalizePath(thread.worktreePath) === targetWt,
      );
      if (matchingChildren.length > 0) {
        return [...matchingChildren].toSorted((a, b) => {
          const ta = a.updatedAt ?? a.createdAt ?? "";
          const tb = b.updatedAt ?? b.createdAt ?? "";
          return tb.localeCompare(ta);
        })[0]!;
      }
    }
  }

  if (targetWt) {
    const byWorktree = active.filter((thread) => normalizePath(thread.worktreePath) === targetWt);
    if (byWorktree.length > 0) {
      return [...byWorktree].toSorted((a, b) => {
        const aTop = a.lineage?.parentThreadId ? 1 : 0;
        const bTop = b.lineage?.parentThreadId ? 1 : 0;
        if (aTop !== bTop) return aTop - bTop;
        const ta = a.updatedAt ?? a.createdAt ?? "";
        const tb = b.updatedAt ?? b.createdAt ?? "";
        return tb.localeCompare(ta);
      })[0]!;
    }
  }

  if (options.threadId) {
    return active.find((thread) => thread.id === options.threadId) ?? null;
  }
  return null;
}

interface HostBridgeActions {
  startThread: (req: PluginStartThreadRequest) => Promise<PluginStartThreadResult>;
  sendThread: (req: PluginSendThreadRequest) => Promise<PluginSendThreadResult>;
  focusThread: (threadId: string, environmentId?: string) => boolean;
  prepareWorktree: (req: PluginPrepareWorktreeRequest) => Promise<PluginPrepareWorktreeResult>;
  openDiff: (req: PluginOpenDiffRequest) => Promise<PluginOpenDiffResult>;
  openInEditor: (path: string) => Promise<PluginOpenInEditorResult>;
  navigateToPlugin: (pluginId: string, subpath?: string, search?: Record<string, string>) => void;
  navigateToMainApp: () => void;
}

const DEFAULT_WORKSPACE_SNAPSHOT: PluginHostWorkspaceSnapshot = {
  projects: [],
  providers: [],
  editor: { available: false },
};

const DEFAULT_HEADER_INSET: PluginHeaderInset = { left: 0, right: 0 };

const HOST_BRIDGE_NOT_READY_MESSAGE = msg("Host bridge is not ready.");

const DEFAULT_ACTIONS: HostBridgeActions = {
  startThread: async () => ({ ok: false, error: m(HOST_BRIDGE_NOT_READY_MESSAGE) }),
  sendThread: async () => ({ ok: false, error: m(HOST_BRIDGE_NOT_READY_MESSAGE) }),
  focusThread: () => false,
  prepareWorktree: async () => ({ ok: false, error: m(HOST_BRIDGE_NOT_READY_MESSAGE) }),
  openDiff: async () => ({ ok: false, error: m(HOST_BRIDGE_NOT_READY_MESSAGE) }),
  openInEditor: async () => ({ ok: false, error: m(HOST_BRIDGE_NOT_READY_MESSAGE) }),
  navigateToPlugin: () => {},
  navigateToMainApp: () => {},
};

class PluginHostBridgeState {
  private threads: ReadonlyArray<PluginHostThread> = [];
  private threadsDigest = "[]";
  private readonly threadListeners = new Set<() => void>();

  private workspace: PluginHostWorkspaceSnapshot = DEFAULT_WORKSPACE_SNAPSHOT;
  private workspaceDigest = JSON.stringify(DEFAULT_WORKSPACE_SNAPSHOT);
  private readonly workspaceListeners = new Set<() => void>();

  private theme: "light" | "dark" =
    typeof window !== "undefined" ? getRenderedAppearance() : "light";
  private readonly themeListeners = new Set<() => void>();

  private headerInset: PluginHeaderInset = DEFAULT_HEADER_INSET;
  private headerInsetDigest = "0:0:";
  private readonly headerInsetListeners = new Set<() => void>();

  actions: HostBridgeActions = DEFAULT_ACTIONS;

  getThreads(): ReadonlyArray<PluginHostThread> {
    return this.threads;
  }

  setThreads(next: ReadonlyArray<PluginHostThread>): void {
    const digest = JSON.stringify(next);
    if (digest === this.threadsDigest) return;
    this.threads = next;
    this.threadsDigest = digest;
    for (const listener of this.threadListeners) listener();
  }

  subscribeThreads(listener: () => void): () => void {
    this.threadListeners.add(listener);
    return () => {
      this.threadListeners.delete(listener);
    };
  }

  getWorkspace(): PluginHostWorkspaceSnapshot {
    return this.workspace;
  }

  setWorkspace(next: PluginHostWorkspaceSnapshot): void {
    const digest = JSON.stringify(next);
    if (digest === this.workspaceDigest) return;
    this.workspace = next;
    this.workspaceDigest = digest;
    for (const listener of this.workspaceListeners) listener();
  }

  subscribeWorkspace(listener: () => void): () => void {
    this.workspaceListeners.add(listener);
    return () => {
      this.workspaceListeners.delete(listener);
    };
  }

  getTheme(): "light" | "dark" {
    return this.theme;
  }

  setTheme(next: "light" | "dark"): void {
    if (next === this.theme) return;
    this.theme = next;
    for (const listener of this.themeListeners) listener();
  }

  subscribeTheme(listener: () => void): () => void {
    this.themeListeners.add(listener);
    return () => {
      this.themeListeners.delete(listener);
    };
  }

  getHeaderInset(): PluginHeaderInset {
    return this.headerInset;
  }

  setHeaderInset(next: PluginHeaderInset): void {
    const digest = `${next.left}:${next.right}:${next.height ?? ""}`;
    if (digest === this.headerInsetDigest) return;
    this.headerInset = next;
    this.headerInsetDigest = digest;
    for (const listener of this.headerInsetListeners) listener();
  }

  subscribeHeaderInset(listener: () => void): () => void {
    this.headerInsetListeners.add(listener);
    return () => {
      this.headerInsetListeners.delete(listener);
    };
  }
}

const pluginHostBridge = new PluginHostBridgeState();

export interface CreatePluginHostSdkHooks {
  readonly setBadge: (count: number) => void;
  readonly subscribeNavigate: (handler: (nav: PluginNavigationEvent) => void) => () => void;
  readonly showToast?: (input: PluginToastInput) => void;
}

export function createPluginHostSdk(
  pluginId: string,
  hooks: CreatePluginHostSdkHooks,
): { readonly host: CtPluginHostSdk; readonly dispose: () => void } {
  const disposers = new Set<() => void>();

  const track = (unsubscribe: () => void): (() => void) => {
    disposers.add(unsubscribe);
    return () => {
      disposers.delete(unsubscribe);
      unsubscribe();
    };
  };

  const apiFetch = createPluginApiFetch(pluginId);

  const host: CtPluginHostSdk = {
    apiVersion: CT_PLUGIN_API_VERSION,
    hostInfo: {
      id: "t3-code",
      name: "T3 Code",
    },
    threads: {
      getSnapshot: () => pluginHostBridge.getThreads(),
      subscribe: (listener) => track(pluginHostBridge.subscribeThreads(listener)),
      start: (req) => pluginHostBridge.actions.startThread(req),
      send: (req) => pluginHostBridge.actions.sendThread(req),
      focus: (threadId, environmentId) =>
        pluginHostBridge.actions.focusThread(threadId, environmentId),
    },
    workspace: {
      getSnapshot: () => pluginHostBridge.getWorkspace(),
      subscribe: (listener) => track(pluginHostBridge.subscribeWorkspace(listener)),
      prepareWorktree: (req) => pluginHostBridge.actions.prepareWorktree(req),
      openDiff: (req) => pluginHostBridge.actions.openDiff(req),
      openInEditor: (path) => pluginHostBridge.actions.openInEditor(path),
    },
    ui: {
      getTheme: () => pluginHostBridge.getTheme(),
      subscribeTheme: (listener) => track(pluginHostBridge.subscribeTheme(listener)),
      getHeaderInset: () => pluginHostBridge.getHeaderInset(),
      subscribeHeaderInset: (listener) => track(pluginHostBridge.subscribeHeaderInset(listener)),
      setBadge: (count) => hooks.setBadge(count),
      navigateToPlugin: (subpath, search) =>
        pluginHostBridge.actions.navigateToPlugin(pluginId, subpath, search),
      navigateToMainApp: () => pluginHostBridge.actions.navigateToMainApp(),
      toast: (input) => {
        if (hooks.showToast) {
          hooks.showToast(input);
          return;
        }
        toastManager.add({
          type: input.type ?? "info",
          title: input.title,
          ...(input.description ? { description: input.description } : {}),
        });
      },
    },
    api: {
      fetch: apiFetch,
    },
    events: {
      onNavigate: (handler) => track(hooks.subscribeNavigate(handler)),
    },
  };

  const dispose = () => {
    for (const unsubscribe of Array.from(disposers)) {
      disposers.delete(unsubscribe);
      try {
        unsubscribe();
      } catch {
        // Ignore listener teardown errors on plugin unload.
      }
    }
    hooks.setBadge(0);
  };

  return { host, dispose };
}

/**
 * Synchronizes CT Code's live reactive state and command handlers into the shared
 * `pluginHostBridge` while `PluginHostLayer` is mounted inside `_chat.tsx`.
 */
export function useSyncPluginHostBridge(options: {
  readonly enabled: boolean;
  readonly headerInsetProbeRef: RefObject<HTMLDivElement | null>;
  readonly isAnyPluginMainViewActive: boolean;
}): void {
  const { enabled, headerInsetProbeRef, isAnyPluginMainViewActive } = options;
  const gt = useGT();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { resolvedTheme } = useTheme();
  const { state: sidebarState, isMobile: isSidebarMobile } = useSidebar();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const availableEditors = primaryServerConfig?.availableEditors ?? [];
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const openInPreferredEditor = useOpenInPreferredEditor(primaryEnvironmentId, availableEditors);
  const editorAvailable = availableEditors.length > 0 && preferredEditor !== null;
  const editorLabel = preferredEditor
    ? editorLabelForPlatform(preferredEditor, navigator.platform)
    : undefined;

  const allProjects = useProjects();
  const environmentProjects = allProjects.filter(
    (project) =>
      project.environmentId === primaryEnvironmentId && !project.archivedAt && !project.isScratch,
  );
  const allThreadShells = useThreadShells(enabled);

  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadTag = useOrchestrationCommand(threadEnvironment.setTag, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });

  const ensureProjectForCwd = useEffectEvent(
    async (
      cwd: string,
    ): Promise<{
      projectId: (typeof environmentProjects)[number]["id"];
      workspaceRoot: string;
      defaultModelSelection: ModelSelection | null;
    }> => {
      if (primaryEnvironmentId === null) {
        throw new Error(gt("No active T3 Code environment is connected."));
      }
      const normalizedCwd = normalizePath(cwd);
      const active = environmentProjects.find(
        (project) => normalizePath(project.workspaceRoot) === normalizedCwd,
      );
      if (active) {
        return {
          projectId: active.id,
          workspaceRoot: active.workspaceRoot,
          defaultModelSelection: active.defaultModelSelection,
        };
      }
      const archivedProject = allProjects.find(
        (project) =>
          project.environmentId === primaryEnvironmentId &&
          normalizePath(project.workspaceRoot) === normalizedCwd,
      );
      if (archivedProject) {
        if (archivedProject.archivedAt !== null) {
          await updateProject({
            environmentId: primaryEnvironmentId,
            input: { projectId: archivedProject.id, archived: false },
          });
        }
        return {
          projectId: archivedProject.id,
          workspaceRoot: archivedProject.workspaceRoot,
          defaultModelSelection: archivedProject.defaultModelSelection,
        };
      }
      const projectId = newProjectId();
      const created = await createProject({
        environmentId: primaryEnvironmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(cwd),
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (created._tag === "Failure") {
        throw squashAtomCommandFailure(created);
      }
      await waitForProject({ environmentId: primaryEnvironmentId, projectId });
      return {
        projectId,
        workspaceRoot: cwd,
        defaultModelSelection: null,
      };
    },
  );

  const handleStartThread = useEffectEvent(
    async (req: PluginStartThreadRequest): Promise<PluginStartThreadResult> => {
      try {
        if (primaryEnvironmentId === null) {
          throw new Error(gt("No active T3 Code environment is connected."));
        }
        const workspace = buildPluginHostWorkspaceSnapshot(providers, environmentProjects, {
          available: editorAvailable,
          ...(editorLabel ? { label: editorLabel } : {}),
        });
        const normalizedCwd = req.cwd ? normalizePath(req.cwd) : null;
        let targetProjectId: (typeof environmentProjects)[number]["id"] | null = null;
        let targetWorkspaceRoot: string | null = null;
        let targetDefaultModelSelection: ModelSelection | null = null;

        const existingProject =
          (req.projectId
            ? environmentProjects.find((project) => project.id === req.projectId)
            : undefined) ??
          (normalizedCwd
            ? environmentProjects.find(
                (project) => normalizePath(project.workspaceRoot) === normalizedCwd,
              )
            : undefined);

        if (existingProject) {
          targetProjectId = existingProject.id;
          targetWorkspaceRoot = existingProject.workspaceRoot;
          targetDefaultModelSelection = existingProject.defaultModelSelection;
        } else if (req.cwd && normalizedCwd) {
          const ensured = await ensureProjectForCwd(req.cwd);
          targetProjectId = ensured.projectId;
          targetWorkspaceRoot = ensured.workspaceRoot;
          targetDefaultModelSelection = ensured.defaultModelSelection;
        } else {
          const fallbackProject =
            (workspace.defaultProjectId
              ? environmentProjects.find((project) => project.id === workspace.defaultProjectId)
              : undefined) ?? environmentProjects[0];
          if (fallbackProject) {
            targetProjectId = fallbackProject.id;
            targetWorkspaceRoot = fallbackProject.workspaceRoot;
            targetDefaultModelSelection = fallbackProject.defaultModelSelection;
          }
        }

        if (!targetProjectId || !targetWorkspaceRoot) {
          throw new Error(gt("No project is registered in T3 Code yet."));
        }

        let modelSelection: ModelSelection | null = null;
        if (req.modelSelection) {
          modelSelection = {
            instanceId: ProviderInstanceId.make(req.modelSelection.providerId),
            model: req.modelSelection.modelSlug,
            ...(req.modelSelection.options?.length ? { options: req.modelSelection.options } : {}),
          };
        } else if (targetDefaultModelSelection) {
          modelSelection = targetDefaultModelSelection;
        } else {
          const fallbackProvider = workspace.providers.find(
            (provider) => provider.available && provider.models.length > 0,
          );
          const fallbackModel =
            fallbackProvider?.models.find((model) => model.isDefault) ??
            fallbackProvider?.models[0];
          if (fallbackProvider && fallbackModel) {
            modelSelection = {
              instanceId: ProviderInstanceId.make(fallbackProvider.id),
              model: fallbackModel.slug,
            };
          }
        }
        if (!modelSelection) {
          throw new Error(gt("No available provider or model is configured in T3 Code."));
        }

        const matchedProvider = providers.find(
          (provider) => provider.instanceId === modelSelection.instanceId,
        );
        const runtimeMode = runtimeModeForProvider(matchedProvider);
        const interactionMode = req.interactionMode ?? "default";
        const threadId = newThreadId();
        const createdAt = new Date().toISOString();

        const result = await startTurn({
          environmentId: primaryEnvironmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: req.prompt,
              attachments: [],
            },
            modelSelection,
            runtimeMode,
            interactionMode,
            bootstrap: {
              createThread: {
                projectId: targetProjectId,
                title: req.title,
                modelSelection,
                runtimeMode,
                interactionMode,
                branch: req.prepareWorktree ? null : (req.branch ?? null),
                worktreePath: req.prepareWorktree ? null : (req.worktreePath ?? null),
                createdAt,
              },
              ...(req.prepareWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: targetWorkspaceRoot,
                      baseBranch: req.prepareWorktree.baseBranch,
                      ...(req.prepareWorktree.branch ? { branch: req.prepareWorktree.branch } : {}),
                      startFromOrigin: req.prepareWorktree.startFromOrigin ?? true,
                      requireWorktree: true,
                    },
                    runSetupScript: true,
                  }
                : {}),
            },
            createdAt,
          },
        });
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }

        const groupTag = req.group?.trim() ? toThreadGroupTag(req.group.trim()) : null;
        if (groupTag !== null) {
          void setThreadTag({
            environmentId: primaryEnvironmentId,
            input: {
              threadId,
              tag: groupTag,
              tagged: true,
            },
          });
        }

        if (req.focus === true) {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(primaryEnvironmentId, threadId)),
          });
        }
        return { ok: true, threadId, environmentId: primaryEnvironmentId };
      } catch (error) {
        return { ok: false, error: thrownErrorMessage(error, m) ?? String(error) };
      }
    },
  );

  const handleSendThread = useEffectEvent(
    async (req: PluginSendThreadRequest): Promise<PluginSendThreadResult> => {
      try {
        const envId = req.environmentId
          ? EnvironmentId.make(req.environmentId)
          : primaryEnvironmentId;
        if (envId === null) {
          throw new Error(gt("No active T3 Code environment is connected."));
        }
        const threadId = ThreadId.make(req.threadId);
        const existing = allThreadShells.find(
          (thread) => thread.id === threadId && thread.environmentId === envId,
        );
        if (!existing) {
          throw new Error(gt("Target thread was not found."));
        }
        const createdAt = new Date().toISOString();
        const result = await startTurn({
          environmentId: envId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: req.prompt,
              attachments: [],
            },
            modelSelection: existing.modelSelection,
            runtimeMode: existing.runtimeMode,
            interactionMode: existing.interactionMode,
            createdAt,
          },
        });
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }
        const nextTitle = req.title?.trim();
        if (nextTitle && nextTitle !== existing.title) {
          void updateThreadMetadata({
            environmentId: envId,
            input: { threadId, title: nextTitle },
          });
        }
        if (req.focus === true) {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(envId, threadId)),
          });
        }
        return { ok: true, threadId, environmentId: envId };
      } catch (error) {
        return { ok: false, error: thrownErrorMessage(error, m) ?? String(error) };
      }
    },
  );

  const handleFocusThread = useEffectEvent((threadId: string, environmentId?: string): boolean => {
    const envId = environmentId ? EnvironmentId.make(environmentId) : primaryEnvironmentId;
    if (envId === null) return false;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(envId, ThreadId.make(threadId))),
    });
    return true;
  });

  const handlePrepareWorktree = useEffectEvent(
    async (req: PluginPrepareWorktreeRequest): Promise<PluginPrepareWorktreeResult> => {
      try {
        if (primaryEnvironmentId === null) {
          throw new Error(gt("No active T3 Code environment is connected."));
        }
        const ensured = await ensureProjectForCwd(req.cwd);
        if (req.existingWorktreePath) {
          return {
            ok: true,
            projectId: ensured.projectId,
            worktreePath: req.existingWorktreePath,
            branch: req.branch ?? "",
          };
        }
        if (!req.baseBranch) {
          throw new Error(gt("Base branch is required to create a worktree."));
        }
        const rawBase = req.baseBranch.trim();
        const preferOrigin = !rawBase.startsWith("origin/") && !rawBase.startsWith("refs/");
        const attemptCreate = (refName: string, baseRefName: string) =>
          createWorktree({
            environmentId: primaryEnvironmentId,
            input: {
              cwd: ensured.workspaceRoot,
              refName,
              ...(req.branch ? { newRefName: req.branch } : {}),
              baseRefName,
              path: null,
            },
          });

        let created = preferOrigin
          ? await attemptCreate(`origin/${rawBase}`, `refs/remotes/origin/${rawBase}`)
          : await attemptCreate(rawBase, rawBase);
        if (created._tag === "Failure" && preferOrigin) {
          const initialError = thrownErrorMessage(squashAtomCommandFailure(created), m) ?? "";
          if (initialError.includes("ref_not_found")) {
            created = await attemptCreate(rawBase, rawBase);
          }
        }
        if (created._tag === "Failure") {
          throw squashAtomCommandFailure(created);
        }
        return {
          ok: true,
          projectId: ensured.projectId,
          worktreePath: created.value.worktree.path,
          branch: created.value.worktree.refName,
        };
      } catch (error) {
        return { ok: false, error: thrownErrorMessage(error, m) ?? String(error) };
      }
    },
  );

  const handleOpenDiff = useEffectEvent(
    async (req: PluginOpenDiffRequest): Promise<PluginOpenDiffResult> => {
      try {
        const envId = req.environmentId
          ? EnvironmentId.make(req.environmentId)
          : primaryEnvironmentId;
        if (envId === null) {
          throw new Error(gt("No active T3 Code environment is connected."));
        }

        const matched = pickBestThreadForPluginDiff(allThreadShells, {
          environmentId: envId,
          threadId: req.threadId,
          worktreePath: req.worktreePath,
        });

        let targetThreadId: ThreadId;
        if (matched) {
          targetThreadId = matched.id;
        } else if (req.worktreePath) {
          const workspace = buildPluginHostWorkspaceSnapshot(providers, environmentProjects, {
            available: editorAvailable,
            ...(editorLabel ? { label: editorLabel } : {}),
          });
          const ensured = await ensureProjectForCwd(req.cwd ?? req.worktreePath);
          let modelSelection: ModelSelection | null = ensured.defaultModelSelection;
          if (!modelSelection) {
            const fallbackProvider = workspace.providers.find(
              (provider) => provider.available && provider.models.length > 0,
            );
            const fallbackModel =
              fallbackProvider?.models.find((model) => model.isDefault) ??
              fallbackProvider?.models[0];
            if (fallbackProvider && fallbackModel) {
              modelSelection = {
                instanceId: ProviderInstanceId.make(fallbackProvider.id),
                model: fallbackModel.slug,
              };
            }
          }
          if (!modelSelection) {
            throw new Error(gt("No available provider or model is configured in T3 Code."));
          }
          const matchedProvider = providers.find(
            (provider) => provider.instanceId === modelSelection.instanceId,
          );
          const runtimeMode = runtimeModeForProvider(matchedProvider);
          const threadId = newThreadId();
          const created = await createThread({
            environmentId: envId,
            input: {
              threadId,
              projectId: ensured.projectId,
              title: req.title ?? inferProjectTitleFromPath(req.worktreePath),
              modelSelection,
              runtimeMode,
              interactionMode: "default",
              branch: req.branch ?? null,
              worktreePath: req.worktreePath,
            },
          });
          if (created._tag === "Failure") {
            throw squashAtomCommandFailure(created);
          }
          targetThreadId = threadId;
        } else {
          throw new Error(gt("Target thread was not found."));
        }

        const threadRef = scopeThreadRef(envId, targetThreadId);
        if (req.commit) {
          useDiffPanelStore.getState().selectCommit(threadRef, req.commit);
        } else if (req.scope) {
          useDiffPanelStore.getState().selectGitScope(threadRef, req.scope);
        }
        useRightPanelStore.getState().open(threadRef, "diff");
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
        return { ok: true, threadId: targetThreadId, environmentId: envId };
      } catch (error) {
        return { ok: false, error: thrownErrorMessage(error, m) ?? String(error) };
      }
    },
  );

  const handleOpenInEditor = useEffectEvent(
    async (path: string): Promise<PluginOpenInEditorResult> => {
      try {
        const result = await openInPreferredEditor(path);
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }
        return {
          ok: true,
          editor: editorLabelForPlatform(result.value, navigator.platform),
        };
      } catch (error) {
        return { ok: false, error: thrownErrorMessage(error, m) ?? String(error) };
      }
    },
  );

  const handleNavigateToPlugin = useEffectEvent(
    (pluginId: string, subpath?: string, search?: Record<string, string>) => {
      const params = new URLSearchParams();
      if (subpath) {
        params.set("subpath", subpath);
      }
      if (search) {
        for (const [key, value] of Object.entries(search)) {
          params.set(key, value);
        }
      }
      const query = params.toString();
      const href = `/plugins/${encodeURIComponent(pluginId)}${query ? `?${query}` : ""}`;
      void navigate({ href });
    },
  );

  const handleNavigateToMainApp = useEffectEvent(() => {
    void navigateToMainApp();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds live React router/command handlers onto the plugin host bridge singleton
  useEffect(() => {
    pluginHostBridge.actions = {
      startThread: handleStartThread,
      sendThread: handleSendThread,
      focusThread: handleFocusThread,
      prepareWorktree: handlePrepareWorktree,
      openDiff: handleOpenDiff,
      openInEditor: handleOpenInEditor,
      navigateToPlugin: handleNavigateToPlugin,
      navigateToMainApp: handleNavigateToMainApp,
    };
    return () => {
      pluginHostBridge.actions = DEFAULT_ACTIONS;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes live workspace catalog snapshot to subscribed plugins
  useEffect(() => {
    if (!enabled) return;
    const activeEnvProjects = allProjects.filter(
      (project) =>
        project.environmentId === primaryEnvironmentId && !project.archivedAt && !project.isScratch,
    );
    pluginHostBridge.setWorkspace(
      buildPluginHostWorkspaceSnapshot(providers, activeEnvProjects, {
        available: editorAvailable,
        ...(editorLabel ? { label: editorLabel } : {}),
      }),
    );
  }, [enabled, providers, allProjects, primaryEnvironmentId, editorAvailable, editorLabel]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes active thread summaries to subscribed plugins
  useEffect(() => {
    if (!enabled) return;
    pluginHostBridge.setThreads(
      buildPluginHostThreads(
        allThreadShells.filter((thread) => thread.environmentId === primaryEnvironmentId),
      ),
    );
  }, [enabled, allThreadShells, primaryEnvironmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes theme appearance updates to subscribed plugins
  useEffect(() => {
    pluginHostBridge.setTheme(resolvedTheme);
  }, [resolvedTheme]);

  const measureHeaderInset = useEffectEvent((_sidebarState?: string, _isMobile?: boolean) => {
    if (!isAnyPluginMainViewActive) {
      pluginHostBridge.setHeaderInset(DEFAULT_HEADER_INSET);
      return;
    }
    const probe = headerInsetProbeRef.current;
    if (!probe) {
      pluginHostBridge.setHeaderInset(DEFAULT_HEADER_INSET);
      return;
    }
    const computed = window.getComputedStyle(probe);
    const left = Math.max(0, Math.round(Number.parseFloat(computed.paddingLeft) || 0));
    const right = Math.max(0, Math.round(Number.parseFloat(computed.paddingRight) || 0));
    const rawHeight = Math.round(Number.parseFloat(computed.height) || 0);
    pluginHostBridge.setHeaderInset(
      rawHeight > 0 ? { left, right, height: rawHeight } : { left, right },
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks host titlebar safe-area insets (collapsed sidebar, macOS traffic lights, Windows WCO) for active plugin main views
  useEffect(() => {
    measureHeaderInset(sidebarState, isSidebarMobile);
    if (!isAnyPluginMainViewActive) return;

    const onResize = () => measureHeaderInset(sidebarState, isSidebarMobile);
    window.addEventListener("resize", onResize);

    const wrapper = headerInsetProbeRef.current?.closest('[data-slot="sidebar-wrapper"]');
    const observer =
      wrapper && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => measureHeaderInset(sidebarState, isSidebarMobile))
        : null;
    observer?.observe(wrapper!, {
      attributes: true,
      attributeFilter: ["data-sidebar-state", "data-sidebar-drag-state", "style"],
    });

    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [headerInsetProbeRef, isAnyPluginMainViewActive, sidebarState, isSidebarMobile]);
}
