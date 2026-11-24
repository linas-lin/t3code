import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ArrowUpRightIcon, LayoutGridIcon, XIcon } from "lucide-react";
import { memo, useEffect, useEffectEvent, useRef, useState } from "react";

import { useDiffPanelStore } from "~/diffPanelStore";
import { editorLabelForPlatform } from "~/editorLabels";
import { useOpenInPreferredEditor, usePreferredEditor } from "~/editorPreferences";
import { useTheme } from "~/hooks/useTheme";
import { m } from "~/i18n/messages";
import { cn, newMessageId, newProjectId, newThreadId } from "~/lib/utils";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildCtStudioHostCatalog,
  buildCtStudioHostThreads,
  parseCtStudioInboundMessage,
  pickBestThreadForDiff,
  type CtStudioInboundMessage,
  type CtStudioOutboundMessage,
} from "./ctStudioBridge";
import { isTrustedCtStudioOrigin } from "./ctStudioConfig";
import { CtStudioOnboardingView } from "./CtStudioOnboardingView";
import { useCtStudioStore } from "./ctStudioStore";

export const CT_STUDIO_ROUTE_PATH = "/ct-studio";

function postToCtStudioFrame(
  iframe: HTMLIFrameElement | null,
  baseUrl: string,
  message: CtStudioOutboundMessage,
): boolean {
  const targetWindow = iframe?.contentWindow;
  if (!targetWindow) return false;
  try {
    const targetOrigin = new URL(baseUrl).origin;
    targetWindow.postMessage(message, targetOrigin);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
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

export const CtStudioKeepAliveLayer = memo(function CtStudioKeepAliveLayer() {
  const gt = useGT();
  const pathname = useLocation({
    select: (location) => location.pathname,
  });
  const isActive = pathname === CT_STUDIO_ROUTE_PATH;
  const mounted = useCtStudioStore((state) => state.mounted);
  const connected = useCtStudioStore((state) => state.connected);
  const modalOpen = useCtStudioStore((state) => state.modalOpen);
  const badgeCount = useCtStudioStore((state) => state.badgeCount);
  const baseUrl = useCtStudioStore((state) => state.baseUrl);
  const iframeSrc = useCtStudioStore((state) => state.iframeSrc);
  const reloadNonce = useCtStudioStore((state) => state.reloadNonce);
  const pendingNav = useCtStudioStore((state) => state.pendingNav);
  const markBackgroundMounted = useCtStudioStore((state) => state.markBackgroundMounted);
  const closeModal = useCtStudioStore((state) => state.closeModal);
  const setConnected = useCtStudioStore((state) => state.setConnected);
  const setBadgeCount = useCtStudioStore((state) => state.setBadgeCount);
  const setWorkspaceContext = useCtStudioStore((state) => state.setWorkspaceContext);
  const clearPendingNav = useCtStudioStore((state) => state.clearPendingNav);
  const [offlineFallbackKey, setOfflineFallbackKey] = useState<string | null>(null);

  const isModal = modalOpen && !isActive;
  const isVisible = isActive || isModal;
  const presentationMode: "page" | "modal" | "hidden" = isActive
    ? "page"
    : isModal
      ? "modal"
      : "hidden";

  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { resolvedTheme } = useTheme();
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
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastCatalogDigestRef = useRef<string | null>(null);
  const lastThreadsDigestRef = useRef<string | null>(null);
  const prevPathnameRef = useRef(pathname);

  const shouldRender = mounted || isVisible;
  const allThreadShells = useThreadShells(shouldRender);

  const getCurrentHostCatalog = useEffectEvent(() =>
    buildCtStudioHostCatalog(providers, environmentProjects, resolvedTheme, {
      available: editorAvailable,
      ...(editorLabel ? { label: editorLabel } : {}),
    }),
  );
  const getCurrentHostThreads = useEffectEvent(() =>
    buildCtStudioHostThreads(
      allThreadShells.filter((thread) => thread.environmentId === primaryEnvironmentId),
    ),
  );

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

  const handlePrepareWorktree = useEffectEvent(
    async (message: Extract<CtStudioInboundMessage, { type: "ct-studio:prepare-worktree" }>) => {
      const reply = (payload: CtStudioOutboundMessage) => {
        postToCtStudioFrame(iframeRef.current, baseUrl, payload);
      };
      try {
        if (primaryEnvironmentId === null) {
          throw new Error(gt("No active T3 Code environment is connected."));
        }
        const ensured = await ensureProjectForCwd(message.cwd);
        if (message.existingWorktreePath) {
          reply({
            type: "t3-ct-studio:prepare-worktree-result",
            requestId: message.requestId,
            ok: true,
            projectId: ensured.projectId,
            worktreePath: message.existingWorktreePath,
            branch: message.branch ?? "",
          });
          return;
        }
        if (!message.baseBranch) {
          throw new Error(gt("Base branch is required to create a worktree."));
        }
        const rawBase = message.baseBranch.trim();
        const preferOrigin = !rawBase.startsWith("origin/") && !rawBase.startsWith("refs/");
        const attemptCreate = (refName: string, baseRefName: string) =>
          createWorktree({
            environmentId: primaryEnvironmentId,
            input: {
              cwd: ensured.workspaceRoot,
              refName,
              ...(message.branch ? { newRefName: message.branch } : {}),
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
        reply({
          type: "t3-ct-studio:prepare-worktree-result",
          requestId: message.requestId,
          ok: true,
          projectId: ensured.projectId,
          worktreePath: created.value.worktree.path,
          branch: created.value.worktree.refName,
        });
      } catch (error) {
        reply({
          type: "t3-ct-studio:prepare-worktree-result",
          requestId: message.requestId,
          ok: false,
          error: thrownErrorMessage(error, m) ?? String(error),
        });
      }
    },
  );

  const handleStartThread = useEffectEvent(
    async (message: Extract<CtStudioInboundMessage, { type: "ct-studio:start-thread" }>) => {
      const reply = (payload: CtStudioOutboundMessage) => {
        postToCtStudioFrame(iframeRef.current, baseUrl, payload);
      };
      try {
        if (primaryEnvironmentId === null) {
          throw new Error(gt("No active T3 Code environment is connected."));
        }
        const catalog = buildCtStudioHostCatalog(providers, environmentProjects);
        const normalizedCwd = message.cwd ? normalizePath(message.cwd) : null;
        let targetProjectId: (typeof environmentProjects)[number]["id"] | null = null;
        let targetWorkspaceRoot: string | null = null;
        let targetDefaultModelSelection: ModelSelection | null = null;

        const existingProject =
          (message.projectId
            ? environmentProjects.find((project) => project.id === message.projectId)
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
        } else if (message.cwd && normalizedCwd) {
          // If the target repository/folder (e.g. business repo or ct-studio root) is not yet an active project in T3 Code,
          // register/unarchive it natively so the thread always runs in the exact requested workspace.
          const ensured = await ensureProjectForCwd(message.cwd);
          targetProjectId = ensured.projectId;
          targetWorkspaceRoot = ensured.workspaceRoot;
          targetDefaultModelSelection = ensured.defaultModelSelection;
        } else {
          const fallbackProject =
            (catalog.defaultProjectId
              ? environmentProjects.find((project) => project.id === catalog.defaultProjectId)
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
        if (message.modelSelection) {
          modelSelection = {
            instanceId: ProviderInstanceId.make(message.modelSelection.providerId),
            model: message.modelSelection.modelSlug,
            ...(message.modelSelection.options?.length
              ? { options: message.modelSelection.options }
              : {}),
          };
        } else if (targetDefaultModelSelection) {
          modelSelection = targetDefaultModelSelection;
        } else {
          const fallbackProvider = catalog.providers.find(
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
        const interactionMode = message.interactionMode ?? "default";
        const threadId = newThreadId();
        const createdAt = new Date().toISOString();

        const result = await startTurn({
          environmentId: primaryEnvironmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: message.prompt,
              attachments: [],
            },
            modelSelection,
            runtimeMode,
            interactionMode,
            bootstrap: {
              createThread: {
                projectId: targetProjectId,
                title: message.title,
                modelSelection,
                runtimeMode,
                interactionMode,
                branch: message.prepareWorktree ? null : (message.branch ?? null),
                worktreePath: message.prepareWorktree ? null : (message.worktreePath ?? null),
                createdAt,
              },
              ...(message.prepareWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: targetWorkspaceRoot,
                      baseBranch: message.prepareWorktree.baseBranch,
                      ...(message.prepareWorktree.branch
                        ? { branch: message.prepareWorktree.branch }
                        : {}),
                      startFromOrigin: message.prepareWorktree.startFromOrigin ?? true,
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

        reply({
          type: "t3-ct-studio:start-thread-result",
          requestId: message.requestId,
          ok: true,
          threadId,
          environmentId: primaryEnvironmentId,
        });
        if (message.focus === true) {
          closeModal();
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(primaryEnvironmentId, threadId)),
          });
        }
      } catch (error) {
        reply({
          type: "t3-ct-studio:start-thread-result",
          requestId: message.requestId,
          ok: false,
          error: thrownErrorMessage(error, m) ?? String(error),
        });
      }
    },
  );

  const handleSendThread = useEffectEvent(
    async (message: Extract<CtStudioInboundMessage, { type: "ct-studio:send-thread" }>) => {
      const reply = (payload: CtStudioOutboundMessage) => {
        postToCtStudioFrame(iframeRef.current, baseUrl, payload);
      };
      try {
        const envId = message.environmentId
          ? EnvironmentId.make(message.environmentId)
          : primaryEnvironmentId;
        if (envId === null) {
          throw new Error(gt("No active T3 Code environment is connected."));
        }
        const threadId = ThreadId.make(message.threadId);
        const existing = allThreadShells.find(
          (t) => t.id === threadId && t.environmentId === envId,
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
              text: message.prompt,
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
        const nextTitle = message.title?.trim();
        if (nextTitle && nextTitle !== existing.title) {
          void updateThreadMetadata({
            environmentId: envId,
            input: { threadId, title: nextTitle },
          });
        }
        reply({
          type: "t3-ct-studio:send-thread-result",
          requestId: message.requestId,
          ok: true,
          threadId,
          environmentId: envId,
        });
        if (message.focus === true) {
          closeModal();
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(envId, threadId)),
          });
        }
      } catch (error) {
        reply({
          type: "t3-ct-studio:send-thread-result",
          requestId: message.requestId,
          ok: false,
          error: thrownErrorMessage(error, m) ?? String(error),
        });
      }
    },
  );

  const handleOpenInEditor = useEffectEvent(
    async (message: Extract<CtStudioInboundMessage, { type: "ct-studio:open-in-editor" }>) => {
      const reply = (payload: CtStudioOutboundMessage) => {
        postToCtStudioFrame(iframeRef.current, baseUrl, payload);
      };
      try {
        const result = await openInPreferredEditor(message.path);
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }
        reply({
          type: "t3-ct-studio:open-in-editor-result",
          requestId: message.requestId,
          ok: true,
          editor: editorLabelForPlatform(result.value, navigator.platform),
        });
      } catch (error) {
        reply({
          type: "t3-ct-studio:open-in-editor-result",
          requestId: message.requestId,
          ok: false,
          error: thrownErrorMessage(error, m) ?? String(error),
        });
      }
    },
  );

  const handleOpenDiff = useEffectEvent(
    async (message: Extract<CtStudioInboundMessage, { type: "ct-studio:open-diff" }>) => {
      const reply = (payload: CtStudioOutboundMessage) => {
        postToCtStudioFrame(iframeRef.current, baseUrl, payload);
      };
      try {
        const envId = message.environmentId
          ? EnvironmentId.make(message.environmentId)
          : primaryEnvironmentId;
        if (envId === null) {
          throw new Error(gt("No active T3 Code environment is connected."));
        }

        const matched = pickBestThreadForDiff(allThreadShells, {
          environmentId: envId,
          threadId: message.threadId,
          worktreePath: message.worktreePath,
        });

        let targetThreadId: ThreadId;
        if (matched) {
          targetThreadId = matched.id;
        } else if (message.worktreePath) {
          const catalog = buildCtStudioHostCatalog(providers, environmentProjects);
          const ensured = await ensureProjectForCwd(message.cwd ?? message.worktreePath);
          let modelSelection: ModelSelection | null = ensured.defaultModelSelection;
          if (!modelSelection) {
            const fallbackProvider = catalog.providers.find(
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
              title: message.title ?? inferProjectTitleFromPath(message.worktreePath),
              modelSelection,
              runtimeMode,
              interactionMode: "default",
              branch: message.branch ?? null,
              worktreePath: message.worktreePath,
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
        if (message.commit) {
          useDiffPanelStore.getState().selectCommit(threadRef, message.commit);
        } else if (message.scope) {
          useDiffPanelStore.getState().selectGitScope(threadRef, message.scope);
        }
        useRightPanelStore.getState().open(threadRef, "diff");
        reply({
          type: "t3-ct-studio:open-diff-result",
          requestId: message.requestId,
          ok: true,
          threadId: targetThreadId,
          environmentId: envId,
        });
        closeModal();
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      } catch (error) {
        reply({
          type: "t3-ct-studio:open-diff-result",
          requestId: message.requestId,
          ok: false,
          error: thrownErrorMessage(error, m) ?? String(error),
        });
      }
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes live T3 provider/project/theme/editor catalog updates to the embedded iframe over postMessage
  useEffect(() => {
    if (!shouldRender || !connected) return;
    const host = buildCtStudioHostCatalog(
      providers,
      allProjects.filter(
        (project) =>
          project.environmentId === primaryEnvironmentId &&
          !project.archivedAt &&
          !project.isScratch,
      ),
      resolvedTheme,
      { available: editorAvailable, ...(editorLabel ? { label: editorLabel } : {}) },
    );
    const digest = JSON.stringify(host);
    if (digest === lastCatalogDigestRef.current) return;
    if (
      postToCtStudioFrame(iframeRef.current, baseUrl, {
        type: "t3-ct-studio:catalog",
        host,
      })
    ) {
      lastCatalogDigestRef.current = digest;
    }
  }, [
    shouldRender,
    connected,
    baseUrl,
    providers,
    allProjects,
    primaryEnvironmentId,
    resolvedTheme,
    editorAvailable,
    editorLabel,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes active T3 thread summaries to the embedded iframe so Inbox/Jira cards reflect live status without CLI polling
  useEffect(() => {
    if (!shouldRender || !connected) return;
    const threads = buildCtStudioHostThreads(
      allThreadShells.filter((thread) => thread.environmentId === primaryEnvironmentId),
    );
    const digest = JSON.stringify(threads);
    if (digest === lastThreadsDigestRef.current) return;
    if (
      postToCtStudioFrame(iframeRef.current, baseUrl, {
        type: "t3-ct-studio:threads",
        threads,
      })
    ) {
      lastThreadsDigestRef.current = digest;
    }
  }, [shouldRender, connected, baseUrl, allThreadShells, primaryEnvironmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes local ct-studio service lazily with bounded retries so users without ct-studio incur no background polling noise
  useEffect(() => {
    if (mounted || isVisible || primaryEnvironmentId === null) return;
    let cancelled = false;
    let attempts = 0;
    let lastProbeAt = 0;
    const maxAutoAttempts = 2;
    const maxTotalAttempts = 5;

    const probe = async () => {
      const now = Date.now();
      if (cancelled || attempts >= maxTotalAttempts || now - lastProbeAt < 10_000) return;
      attempts += 1;
      lastProbeAt = now;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(baseUrl, { mode: "no-cors", cache: "no-store", signal: controller.signal });
        if (!cancelled) markBackgroundMounted();
      } catch {
        // Local ct-studio service is not running; stay unmounted cleanly without error UI.
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const initialTimer = window.setTimeout(() => {
      void probe();
    }, 1200);
    const secondTimer = window.setTimeout(() => {
      if (attempts < maxAutoAttempts) void probe();
    }, 15_000);
    const onFocus = () => {
      if (Date.now() - lastProbeAt >= 60_000) {
        void probe();
      }
    };
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearTimeout(secondTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, [mounted, isVisible, primaryEnvironmentId, baseUrl, markBackgroundMounted]);

  const connectionAttemptKey = `${baseUrl}:${reloadNonce}`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals a friendly offline fallback if the active CT Studio iframe fails to handshake within the grace window
  useEffect(() => {
    if (!isVisible || connected) return;
    const timer = window.setTimeout(() => {
      setOfflineFallbackKey(connectionAttemptKey);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [isVisible, connected, connectionAttemptKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismisses the CT Studio quick-view modal when navigating to another route
  useEffect(() => {
    if (prevPathnameRef.current !== pathname) {
      prevPathnameRef.current = pathname;
      if (useCtStudioStore.getState().modalOpen) {
        closeModal();
      }
    }
  }, [pathname, closeModal]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- notifies the embedded iframe of page/modal/hidden presentation mode so Escape closes the modal directly
  useEffect(() => {
    if (!shouldRender || !connected) return;
    postToCtStudioFrame(iframeRef.current, baseUrl, {
      type: "t3-ct-studio:presentation",
      mode: presentationMode,
    });
  }, [shouldRender, connected, baseUrl, presentationMode]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds Escape shortcut to close the CT Studio quick-view modal
  useEffect(() => {
    if (!isModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeModal();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isModal, closeModal]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dispatches postMessage navigation to the persistent iframe without reloading it
  useEffect(() => {
    if (!shouldRender || !connected || !pendingNav) return;
    if (
      postToCtStudioFrame(iframeRef.current, baseUrl, {
        type: "t3-ct-studio:navigate",
        ticket: pendingNav.ticket,
        stage: pendingNav.stage,
        itemId: pendingNav.itemId,
        view: pendingNav.view,
      })
    ) {
      clearPendingNav(pendingNav.nonce);
    }
  }, [shouldRender, connected, pendingNav, baseUrl, clearPendingNav]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to cross-window postMessage events from the embedded CT Studio iframe
  useEffect(() => {
    if (!shouldRender) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isTrustedCtStudioOrigin(event.origin, baseUrl)) return;
      const message = parseCtStudioInboundMessage(event.data);
      if (!message) return;

      switch (message.type) {
        case "ct-studio:ready": {
          setConnected(true);
          const host = getCurrentHostCatalog();
          lastCatalogDigestRef.current = JSON.stringify(host);
          postToCtStudioFrame(iframeRef.current, baseUrl, {
            type: "t3-ct-studio:hello",
            version: 1,
            host,
          });
          const threads = getCurrentHostThreads();
          lastThreadsDigestRef.current = JSON.stringify(threads);
          postToCtStudioFrame(iframeRef.current, baseUrl, {
            type: "t3-ct-studio:threads",
            threads,
          });
          break;
        }
        case "ct-studio:badge":
          setBadgeCount(message.count);
          break;
        case "ct-studio:focus-thread": {
          const envId = message.environmentId
            ? EnvironmentId.make(message.environmentId)
            : primaryEnvironmentId;
          if (!envId) return;
          closeModal();
          void navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId: envId,
              threadId: ThreadId.make(message.threadId),
            },
          });
          break;
        }
        case "ct-studio:start-thread":
          void handleStartThread(message);
          break;
        case "ct-studio:prepare-worktree":
          void handlePrepareWorktree(message);
          break;
        case "ct-studio:send-thread":
          void handleSendThread(message);
          break;
        case "ct-studio:open-in-editor":
          void handleOpenInEditor(message);
          break;
        case "ct-studio:open-diff":
          void handleOpenDiff(message);
          break;
        case "ct-studio:workspace-context":
          setWorkspaceContext(message.context);
          break;
        case "ct-studio:toggle-back":
          if (useCtStudioStore.getState().modalOpen) {
            closeModal();
          } else {
            void navigateToMainApp();
          }
          break;
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    shouldRender,
    baseUrl,
    primaryEnvironmentId,
    navigate,
    navigateToMainApp,
    closeModal,
    setConnected,
    setBadgeCount,
    setWorkspaceContext,
  ]);

  if (!shouldRender) return null;

  const showOfflineOverlay = isVisible && !connected && offlineFallbackKey === connectionAttemptKey;

  return (
    <main
      data-slot="ct-studio-layer"
      data-mode={isActive ? "page" : isModal ? "modal" : "hidden"}
      aria-hidden={!isVisible}
      role={isModal ? "dialog" : undefined}
      aria-modal={isModal ? true : undefined}
      aria-label={isModal ? gt("CT Studio") : undefined}
      onClick={
        isModal
          ? (event) => {
              if (event.target === event.currentTarget) {
                closeModal();
              }
            }
          : undefined
      }
      className={cn(
        isActive &&
          "relative flex h-dvh min-h-0 w-full min-w-0 flex-1 flex-col bg-background surface-grain md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm/5 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2",
        isModal &&
          "fixed inset-0 z-50 flex h-dvh w-screen items-center justify-center bg-black/55 p-4 backdrop-blur-xs sm:p-6",
        !isVisible && "hidden",
      )}
    >
      <div
        className={cn(
          "flex min-h-0 flex-col overflow-hidden",
          isModal
            ? "h-[min(88vh,920px)] w-[min(92vw,1360px)] rounded-2xl border border-border/80 bg-background shadow-2xl"
            : "h-full w-full flex-1",
        )}
      >
        {isModal ? (
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-muted/30 px-3">
            <div className="flex min-w-0 items-center gap-2">
              <LayoutGridIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate text-xs font-medium text-foreground">
                {gt("CT Studio")}
              </span>
              {badgeCount > 0 ? (
                <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-md border border-warning/30 bg-warning/15 px-1 text-3xs font-medium tabular-nums text-warning">
                  {badgeCount > 99 ? "99+" : badgeCount}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={gt("Open CT Studio in full view")}
                      onClick={() => {
                        closeModal();
                        void navigate({ to: "/ct-studio", search: {} });
                      }}
                      className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <ArrowUpRightIcon className="size-3.5" aria-hidden />
                      <span>{gt("Full view")}</span>
                    </button>
                  }
                />
                <TooltipPopup side="bottom">{gt("Open CT Studio in full view")}</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={gt("Close CT Studio modal")}
                      onClick={closeModal}
                      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <XIcon className="size-4" aria-hidden />
                    </button>
                  }
                />
                <TooltipPopup side="bottom">{gt("Close (Esc)")}</TooltipPopup>
              </Tooltip>
            </div>
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1">
          {/* oxlint-disable-next-line react/iframe-missing-sandbox -- embeds the user's own local ct-studio app which needs scripts and same-origin API access */}
          <iframe
            key={connectionAttemptKey}
            ref={iframeRef}
            title={gt("CT Studio")}
            src={iframeSrc}
            onLoad={() => {
              const host = getCurrentHostCatalog();
              lastCatalogDigestRef.current = JSON.stringify(host);
              postToCtStudioFrame(iframeRef.current, baseUrl, {
                type: "t3-ct-studio:hello",
                version: 1,
                host,
              });
            }}
            className={cn("h-full w-full border-0", showOfflineOverlay && "invisible")}
            allow="clipboard-read; clipboard-write"
          />
          {showOfflineOverlay ? <CtStudioOnboardingView /> : null}
        </div>
      </div>
    </main>
  );
});
