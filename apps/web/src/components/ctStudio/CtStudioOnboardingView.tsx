import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_RUNTIME_MODE,
  ProviderInstanceId,
  projectCloneProgressSummary,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FolderOpenIcon,
  LayoutGridIcon,
  Loader2Icon,
  RefreshCwIcon,
  Settings2Icon,
  TerminalIcon,
} from "lucide-react";
import { memo, useEffect, useState } from "react";

import { newMessageId, newProjectId, newThreadId } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useProjects, waitForProject } from "~/state/entities";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useProjectClone } from "~/state/projectClones";
import { projectEnvironment } from "~/state/projects";
import { primaryServerConfigAtom, primaryServerProvidersAtom } from "~/state/server";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { buildCtStudioHostCatalog } from "./ctStudioBridge";
import {
  DEFAULT_CT_STUDIO_URL,
  detectClientPlatform,
  isCtStudioWorkspace,
  joinCtStudioClonePath,
  normalizeCtStudioUrl,
  normalizeGitRepoUrl,
  readCtStudioRepoUrl,
  toggleGitRepoProtocol,
  writeCtStudioRepoUrl,
} from "./ctStudioConfig";
import { useCtStudioStore } from "./ctStudioStore";

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

function CopyCommandRow({ label, command }: { label: string; command: string }) {
  const gt = useGT();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-3xs text-muted-foreground">{label}</div>
        <code className="block truncate font-mono text-xs text-foreground">{command}</code>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={gt("Copy command")}
        className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/70 bg-background/80 px-2 text-3xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {copied ? (
          <>
            <CheckIcon className="size-3 text-success" aria-hidden />
            <span>
              <T>Copied</T>
            </span>
          </>
        ) : (
          <>
            <CopyIcon className="size-3" aria-hidden />
            <span>
              <T>Copy</T>
            </span>
          </>
        )}
      </button>
    </div>
  );
}

export const CtStudioOnboardingView = memo(function CtStudioOnboardingView() {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const allProjects = useProjects();
  const baseUrl = useCtStudioStore((state) => state.baseUrl);
  const setBaseUrl = useCtStudioStore((state) => state.setBaseUrl);
  const triggerReload = useCtStudioStore((state) => state.triggerReload);

  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });

  const environmentProjects = allProjects.filter(
    (project) =>
      project.environmentId === primaryEnvironmentId && !project.archivedAt && !project.isScratch,
  );
  const ctStudioProject = environmentProjects.find(isCtStudioWorkspace) ?? null;

  const clientPlatform = detectClientPlatform();
  const [repoUrl, setRepoUrl] = useState<string>(() => readCtStudioRepoUrl());
  const [destinationPath, setDestinationPath] = useState<string>(() =>
    joinCtStudioClonePath(primaryServerConfig?.newProjectsRoot),
  );
  const [showManualFolder, setShowManualFolder] = useState(false);
  const [manualFolderPath, setManualFolderPath] = useState("");
  const [cloningProjectId, setCloningProjectId] = useState<ProjectId | null>(null);
  const [cloneSubmitting, setCloneSubmitting] = useState(false);
  const [linkingFolder, setLinkingFolder] = useState(false);
  const [startingAgent, setStartingAgent] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [showUrlEditor, setShowUrlEditor] = useState(false);
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [urlError, setUrlError] = useState<string | null>(null);

  const cloneSnapshot = useProjectClone(
    primaryEnvironmentId && cloningProjectId
      ? scopeProjectRef(primaryEnvironmentId, cloningProjectId)
      : null,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls local ct-studio service every 3s while onboarding is visible so the view transitions seamlessly once started
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 2000);
      try {
        await fetch(baseUrl, { mode: "no-cors", cache: "no-store", signal: controller.signal });
        if (!cancelled) triggerReload();
      } catch {
        // Still offline; retry on next tick.
      } finally {
        window.clearTimeout(timeout);
      }
    };
    const interval = window.setInterval(() => {
      void probe();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [baseUrl, triggerReload]);

  const toggledProtocolUrl = toggleGitRepoProtocol(repoUrl);
  const normalizedRepoUrl = normalizeGitRepoUrl(repoUrl);
  const canClone =
    primaryEnvironmentId !== null &&
    normalizedRepoUrl !== null &&
    destinationPath.trim().length > 0 &&
    !cloneSubmitting &&
    cloneSnapshot?.phase !== "running";

  const handleClone = async () => {
    if (!primaryEnvironmentId || !normalizedRepoUrl || !destinationPath.trim()) return;
    setActionError(null);
    setCloneSubmitting(true);
    writeCtStudioRepoUrl(normalizedRepoUrl);
    const projectId = newProjectId();
    try {
      const result = await startProjectClone({
        environmentId: primaryEnvironmentId,
        input: {
          projectId,
          title: "ct-studio",
          createdAt: new Date().toISOString(),
          remoteUrl: normalizedRepoUrl,
          destinationPath: destinationPath.trim(),
        },
      });
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      setCloningProjectId(result.value.projectId);
      await waitForProject(
        scopeProjectRef(primaryEnvironmentId, result.value.projectId),
        5000,
      ).catch(() => null);
    } catch (error) {
      setActionError(thrownErrorMessage(error, m) ?? String(error));
    } finally {
      setCloneSubmitting(false);
    }
  };

  const registerLocalFolder = async (folderPath: string) => {
    const trimmed = folderPath.trim();
    if (!primaryEnvironmentId || !trimmed) return;
    setActionError(null);
    setLinkingFolder(true);
    try {
      const projectId = newProjectId();
      const result = await createProject({
        environmentId: primaryEnvironmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(trimmed),
          workspaceRoot: trimmed,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      await waitForProject(scopeProjectRef(primaryEnvironmentId, projectId), 5000).catch(
        () => null,
      );
      setShowManualFolder(false);
      setManualFolderPath("");
    } catch (error) {
      setActionError(thrownErrorMessage(error, m) ?? String(error));
    } finally {
      setLinkingFolder(false);
    }
  };

  const handlePickExistingFolder = async () => {
    const localApi = readLocalApi();
    if (!localApi) {
      setShowManualFolder(true);
      return;
    }
    try {
      const picked = await localApi.dialogs.pickFolder({
        initialPath: primaryServerConfig?.newProjectsRoot ?? null,
      });
      if (picked) {
        await registerLocalFolder(picked);
      }
    } catch {
      setShowManualFolder(true);
    }
  };

  const handleStartWithAgent = async () => {
    if (!primaryEnvironmentId || !ctStudioProject) return;
    setActionError(null);
    setStartingAgent(true);
    try {
      const catalog = buildCtStudioHostCatalog(providers, environmentProjects);
      let modelSelection: ModelSelection | null = ctStudioProject.defaultModelSelection;
      if (!modelSelection) {
        const provider = catalog.providers.find((p) => p.available && p.models.length > 0);
        const model = provider?.models.find((item) => item.isDefault) ?? provider?.models[0];
        if (provider && model) {
          modelSelection = {
            instanceId: ProviderInstanceId.make(provider.id),
            model: model.slug,
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
      const createdAt = new Date().toISOString();
      const prompt = [
        `请按 app/AGENTS.md 的「启动 app」与「后台运行」流程帮我检查并配置本机 ct-studio 服务（目标地址：${baseUrl}）：`,
        "1. 检查本机 Node.js 版本（要求 >= 24.22.0），版本不足时明确提示如何升级；",
        "2. 检查是否已有 ct-studio 常驻服务或前台进程在运行，以及目标端口是否被占用（若已有旧的前台进程占用端口，先告诉我并征得同意后再处理）；",
        "3. 如果 app/node_modules 不存在，先运行 `npm --prefix app ci`；",
        "4. 优先推荐以系统后台常驻服务方式运行（macOS launchd / Windows Task Scheduler，开机自启、崩溃自动恢复、支持页内平滑更新）：先运行 `node app/bin/ct-studio.ts service install` 预览，并向我明确说明它会随登录自启、已配置的 AI 汇总会在后台运行并消耗额度；等我确认后再执行 `node app/bin/ct-studio.ts service install --yes`（如果是 Linux 则改用 tmux 运行 `serve --supervised`；如果我只想要临时试跑，则改用 `node app/bin/ct-studio.ts serve`）；",
        "5. 确认服务返回 HTTP 200 后，如果 `.config/app/config.json` 还未配置，引导我完成首次配置。",
      ].join("\n");

      const result = await startTurn({
        environmentId: primaryEnvironmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: prompt,
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: ctStudioProject.id,
              title: gt("Setup & start CT Studio"),
              modelSelection,
              runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(primaryEnvironmentId, threadId)),
      });
    } catch (error) {
      setActionError(thrownErrorMessage(error, m) ?? String(error));
    } finally {
      setStartingAgent(false);
    }
  };

  const handleSaveUrl = () => {
    const normalized = normalizeCtStudioUrl(urlDraft);
    if (!normalized) {
      setUrlError(gt("Enter a valid http:// or https:// URL."));
      return;
    }
    setUrlError(null);
    setBaseUrl(normalized);
    setShowUrlEditor(false);
  };

  const isCloning = cloneSnapshot?.phase === "running";

  return (
    <div
      data-ct-studio-onboarding
      className="scrollbar-gutter-both absolute inset-0 overflow-y-auto bg-background px-6 py-8"
    >
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-muted/40 text-foreground">
              <LayoutGridIcon className="size-5" aria-hidden />
            </div>
            <div className="space-y-1">
              <h1 className="text-base font-semibold text-foreground">
                <T>Connect CT Studio</T>
              </h1>
              <p className="text-xs leading-relaxed text-muted-foreground">
                <T>
                  Waiting for a local CT Studio service at{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                    <Var>{baseUrl}</Var>
                  </code>
                  . Once started, this page connects automatically.
                </T>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void navigateToMainApp()}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <ArrowLeftIcon className="size-3.5" aria-hidden />
            <span>
              <T>Back</T>
            </span>
          </button>
        </div>

        {actionError ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
            {actionError}
          </div>
        ) : null}

        {/* Step 1: Repository download / link */}
        <section className="rounded-2xl border border-border bg-card p-4 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {ctStudioProject ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-hidden />
              ) : (
                <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-3xs font-semibold text-primary">
                  1
                </span>
              )}
              <h2 className="text-sm font-medium text-foreground">
                <T>Get the ct-studio repository</T>
              </h2>
            </div>
            {ctStudioProject ? (
              <span className="truncate font-mono text-3xs text-muted-foreground">
                {ctStudioProject.workspaceRoot}
              </span>
            ) : null}
          </div>

          {!ctStudioProject ? (
            <div className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="ct-studio-repo-url"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    <T>Git repository URL</T>
                  </label>
                  {toggledProtocolUrl ? (
                    <button
                      type="button"
                      onClick={() => setRepoUrl(toggledProtocolUrl)}
                      className="cursor-pointer text-3xs font-medium text-primary hover:underline"
                    >
                      {repoUrl.trim().startsWith("http")
                        ? gt("Switch to SSH")
                        : gt("Switch to HTTPS")}
                    </button>
                  ) : null}
                </div>
                <input
                  id="ct-studio-repo-url"
                  type="text"
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  placeholder="https://github.com/<org>/ct-studio.git"
                  className="h-8 w-full rounded-lg border border-input bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="ct-studio-dest-path"
                  className="text-xs font-medium text-muted-foreground"
                >
                  <T>Destination folder</T>
                </label>
                <input
                  id="ct-studio-dest-path"
                  type="text"
                  value={destinationPath}
                  onChange={(event) => setDestinationPath(event.target.value)}
                  placeholder="~/projects/ct-studio"
                  className="h-8 w-full rounded-lg border border-input bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              </div>

              {cloneSnapshot ? (
                <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs">
                  {cloneSnapshot.phase === "running" ? (
                    <div className="flex items-center gap-2 text-foreground">
                      <Loader2Icon className="size-3.5 animate-spin text-primary" aria-hidden />
                      <span className="truncate">{projectCloneProgressSummary(cloneSnapshot)}</span>
                    </div>
                  ) : cloneSnapshot.phase === "failed" ? (
                    <p className="text-destructive">
                      {cloneSnapshot.error ?? gt("Repository clone failed.")}
                    </p>
                  ) : (
                    <p className="text-success">
                      <T>Repository cloned and registered.</T>
                    </p>
                  )}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canClone}
                  onClick={() => void handleClone()}
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {cloneSubmitting || isCloning ? (
                    <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <DownloadIcon className="size-3.5" aria-hidden />
                  )}
                  <span>
                    <T>Clone &amp; add project</T>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={linkingFolder}
                  onClick={() => void handlePickExistingFolder()}
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                >
                  <FolderOpenIcon className="size-3.5" aria-hidden />
                  <span>
                    <T>Use existing folder</T>
                  </span>
                </button>
              </div>

              {showManualFolder ? (
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    value={manualFolderPath}
                    onChange={(event) => setManualFolderPath(event.target.value)}
                    placeholder="/path/to/ct-studio"
                    aria-label={gt("Local ct-studio path")}
                    className="h-8 flex-1 rounded-lg border border-input bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                  <button
                    type="button"
                    disabled={linkingFolder || !manualFolderPath.trim()}
                    onClick={() => void registerLocalFolder(manualFolderPath)}
                    className="inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg border border-border bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    <T>Link folder</T>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* Step 2: Install deps & start service */}
        <section className="rounded-2xl border border-border bg-card p-4 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-3xs font-semibold text-primary">
                2
              </span>
              <h2 className="text-sm font-medium text-foreground">
                <T>Install dependencies &amp; start service</T>
              </h2>
            </div>
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
              <T>Node &gt;= 24.22.0</T>
            </span>
          </div>

          <div className="mt-3 space-y-3">
            {ctStudioProject ? (
              <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <BotIcon className="size-3.5 text-primary" aria-hidden />
                    <span>
                      <T>Recommended: Let T3 Agent set up &amp; start it</T>
                    </span>
                  </div>
                  <p className="text-3xs text-muted-foreground">
                    <T>
                      Checks Node version, runs npm ci, starts CT Studio, and helps fix any local
                      issues.
                    </T>
                  </p>
                </div>
                <button
                  type="button"
                  disabled={startingAgent}
                  onClick={() => void handleStartWithAgent()}
                  className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {startingAgent ? (
                    <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <BotIcon className="size-3.5" aria-hidden />
                  )}
                  <span>
                    <T>Start with Agent</T>
                  </span>
                </button>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <TerminalIcon className="size-3.5" aria-hidden />
                <span>
                  <T>Or run manually in the ct-studio folder</T>
                </span>
              </div>
              <CopyCommandRow label={gt("First-time install")} command="npm --prefix app ci" />
              {clientPlatform === "other" ? (
                <CopyCommandRow
                  label={gt("Recommended: background run in tmux (supports in-app updates)")}
                  command="tmux new-session -d -s ct-studio 'node app/bin/ct-studio.ts serve --supervised'"
                />
              ) : (
                <CopyCommandRow
                  label={
                    clientPlatform === "windows"
                      ? gt(
                          "Recommended: Windows background service (Task Scheduler, auto-starts at login, supports in-app updates)",
                        )
                      : gt(
                          "Recommended: macOS background service (launchd, auto-starts at login, supports in-app updates)",
                        )
                  }
                  command="node app/bin/ct-studio.ts service install --yes"
                />
              )}
              <CopyCommandRow
                label={gt("Temporary foreground run only (stops when terminal closes)")}
                command="node app/bin/ct-studio.ts serve"
              />
            </div>
          </div>
        </section>

        {/* Step 3: Service URL & manual reconnect */}
        <div className="flex flex-col gap-3 rounded-2xl border border-border/80 bg-card/60 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setUrlDraft(baseUrl);
                setUrlError(null);
                setShowUrlEditor((prev) => !prev);
              }}
              className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Settings2Icon className="size-3.5" aria-hidden />
              <span>
                <T>
                  Service URL: <Var>{baseUrl}</Var>
                </T>
              </span>
            </button>
            <button
              type="button"
              onClick={triggerReload}
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            >
              <RefreshCwIcon className="size-3" aria-hidden />
              <span>
                <T>Retry now</T>
              </span>
            </button>
          </div>

          {showUrlEditor ? (
            <div className="space-y-1.5 border-t border-border/60 pt-2.5">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  aria-label={gt("CT Studio service URL")}
                  placeholder={DEFAULT_CT_STUDIO_URL}
                  className="h-8 flex-1 rounded-lg border border-input bg-background px-2.5 font-mono text-xs text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
                <button
                  type="button"
                  onClick={handleSaveUrl}
                  className="inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  <T>Save &amp; connect</T>
                </button>
                {baseUrl !== DEFAULT_CT_STUDIO_URL ? (
                  <button
                    type="button"
                    onClick={() => {
                      setUrlDraft(DEFAULT_CT_STUDIO_URL);
                      setUrlError(null);
                      setBaseUrl(DEFAULT_CT_STUDIO_URL);
                    }}
                    className="inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg border border-border bg-muted/40 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <T>Reset</T>
                  </button>
                ) : null}
              </div>
              {urlError ? <p className="text-3xs text-destructive">{urlError}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
