import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ServerProvider } from "@t3tools/contracts";

import { extractTicketKey } from "./ctStudioConfig";

interface CtStudioHostModelOptionChoice {
  readonly id: string;
  readonly label: string;
  readonly isDefault?: boolean | undefined;
}

type CtStudioHostModelOption =
  | {
      readonly id: string;
      readonly label: string;
      readonly type: "select";
      readonly options: ReadonlyArray<CtStudioHostModelOptionChoice>;
      readonly defaultValue?: string | undefined;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly type: "boolean";
      readonly defaultValue?: boolean | undefined;
    };

interface CtStudioHostModel {
  readonly slug: string;
  readonly name: string;
  readonly isDefault?: boolean | undefined;
  readonly options?: ReadonlyArray<CtStudioHostModelOption> | undefined;
}

interface CtStudioHostProvider {
  readonly id: string;
  readonly driver: string;
  readonly name: string;
  readonly available: boolean;
  readonly models: ReadonlyArray<CtStudioHostModel>;
}

interface CtStudioHostProject {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
}

interface CtStudioHostThread {
  readonly threadId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: "working" | "blocked" | "done" | "idle";
  readonly providerId: string;
  readonly model?: string | undefined;
  readonly branch?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly ticketKey?: string | undefined;
  readonly parentThreadId?: string | undefined;
  readonly rootThreadId?: string | undefined;
  readonly relationshipToParent?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

interface CtStudioHostCatalog {
  readonly id: string;
  readonly name: string;
  readonly theme: "light" | "dark";
  readonly capabilities: {
    readonly startThread: true;
    readonly prepareWorktree: true;
    readonly sendThread: true;
    readonly openInEditor?: boolean | undefined;
    readonly openDiff: true;
  };
  readonly editorLabel?: string | undefined;
  readonly defaultProjectId?: string | undefined;
  readonly projects: ReadonlyArray<CtStudioHostProject>;
  readonly providers: ReadonlyArray<CtStudioHostProvider>;
}

export interface CtStudioStartThreadSelection {
  readonly providerId: string;
  readonly modelSlug: string;
  readonly options?:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | undefined;
}

export interface CtStudioPrepareWorktree {
  readonly baseBranch: string;
  readonly branch?: string | undefined;
  readonly startFromOrigin?: boolean | undefined;
}

export type CtStudioThreadLinkInfo =
  | {
      readonly kind: "inbox";
      readonly itemId: string;
      readonly title: string;
      readonly source: string;
      readonly status?: string | undefined;
    }
  | {
      readonly kind: "ticket";
      readonly ticketKey: string;
      readonly stage?: string | undefined;
      readonly task?: string | undefined;
      readonly summary?: string | undefined;
      readonly status?: string | undefined;
    };

export interface CtStudioWatchedInboxItem {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly sourceLabel?: string | undefined;
  readonly attention: "action" | "fyi" | "low";
  readonly status: string;
  readonly pinned: boolean;
  readonly time: string;
  readonly threadId?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly threadStatus?: "working" | "blocked" | "done" | "idle" | undefined;
}

export interface CtStudioWatchedTaskItem {
  readonly key: string;
  readonly summary: string;
  readonly status: string;
  readonly statusCategory: "new" | "indeterminate" | "done";
  readonly priority?: string | undefined;
  readonly assignedToMe: boolean;
  readonly mentionsMe: boolean;
  readonly stage?: string | undefined;
  readonly threadId?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly threadStatus?: "working" | "blocked" | "done" | "idle" | undefined;
  readonly activeThreadCount?: number | undefined;
}

export interface CtStudioWorkspaceContext {
  readonly threadLinks: Readonly<Record<string, CtStudioThreadLinkInfo>>;
  readonly watchedInbox: ReadonlyArray<CtStudioWatchedInboxItem>;
  readonly watchedTasks: ReadonlyArray<CtStudioWatchedTaskItem>;
}

export const EMPTY_CT_STUDIO_WORKSPACE_CONTEXT: CtStudioWorkspaceContext = {
  threadLinks: {},
  watchedInbox: [],
  watchedTasks: [],
};

export type CtStudioInboundMessage =
  | { readonly type: "ct-studio:ready" }
  | { readonly type: "ct-studio:badge"; readonly count: number }
  | {
      readonly type: "ct-studio:focus-thread";
      readonly threadId: string;
      readonly environmentId?: string | undefined;
    }
  | {
      readonly type: "ct-studio:start-thread";
      readonly requestId: string;
      readonly projectId?: string | undefined;
      readonly cwd?: string | undefined;
      readonly worktreePath?: string | undefined;
      readonly branch?: string | undefined;
      readonly prepareWorktree?: CtStudioPrepareWorktree | undefined;
      readonly title: string;
      readonly prompt: string;
      readonly modelSelection?: CtStudioStartThreadSelection | undefined;
      readonly interactionMode?: "default" | "plan" | undefined;
      readonly focus?: boolean | undefined;
      readonly group?: string | undefined;
    }
  | {
      readonly type: "ct-studio:prepare-worktree";
      readonly requestId: string;
      readonly cwd: string;
      readonly existingWorktreePath?: string | undefined;
      readonly branch?: string | undefined;
      readonly baseBranch?: string | undefined;
    }
  | {
      readonly type: "ct-studio:send-thread";
      readonly requestId: string;
      readonly threadId: string;
      readonly environmentId?: string | undefined;
      readonly prompt: string;
      readonly title?: string | undefined;
      readonly focus?: boolean | undefined;
    }
  | {
      readonly type: "ct-studio:open-in-editor";
      readonly requestId: string;
      readonly path: string;
    }
  | {
      readonly type: "ct-studio:open-diff";
      readonly requestId: string;
      readonly threadId?: string | undefined;
      readonly environmentId?: string | undefined;
      readonly worktreePath?: string | undefined;
      readonly cwd?: string | undefined;
      readonly branch?: string | undefined;
      readonly scope?: "unstaged" | "branch" | undefined;
      readonly commit?: string | undefined;
      readonly title?: string | undefined;
    }
  | {
      readonly type: "ct-studio:workspace-context";
      readonly context: CtStudioWorkspaceContext;
    }
  | { readonly type: "ct-studio:toggle-back" };

export type CtStudioOutboundMessage =
  | {
      readonly type: "t3-ct-studio:hello";
      readonly version: 1;
      readonly host?: CtStudioHostCatalog | undefined;
    }
  | {
      readonly type: "t3-ct-studio:catalog";
      readonly host: CtStudioHostCatalog;
    }
  | {
      readonly type: "t3-ct-studio:threads";
      readonly threads: ReadonlyArray<CtStudioHostThread>;
    }
  | {
      readonly type: "t3-ct-studio:start-thread-result";
      readonly requestId: string;
      readonly ok: true;
      readonly threadId: string;
      readonly environmentId: string;
    }
  | {
      readonly type: "t3-ct-studio:start-thread-result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    }
  | {
      readonly type: "t3-ct-studio:prepare-worktree-result";
      readonly requestId: string;
      readonly ok: true;
      readonly projectId: string;
      readonly worktreePath: string;
      readonly branch: string;
    }
  | {
      readonly type: "t3-ct-studio:prepare-worktree-result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    }
  | {
      readonly type: "t3-ct-studio:send-thread-result";
      readonly requestId: string;
      readonly ok: true;
      readonly threadId: string;
      readonly environmentId: string;
    }
  | {
      readonly type: "t3-ct-studio:send-thread-result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    }
  | {
      readonly type: "t3-ct-studio:open-in-editor-result";
      readonly requestId: string;
      readonly ok: true;
      readonly editor: string;
    }
  | {
      readonly type: "t3-ct-studio:open-in-editor-result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    }
  | {
      readonly type: "t3-ct-studio:open-diff-result";
      readonly requestId: string;
      readonly ok: true;
      readonly threadId: string;
      readonly environmentId: string;
    }
  | {
      readonly type: "t3-ct-studio:open-diff-result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    }
  | {
      readonly type: "t3-ct-studio:navigate";
      readonly ticket?: string | undefined;
      readonly stage?: string | undefined;
      readonly itemId?: string | undefined;
      readonly view?: "timeline" | "jira" | "sessions" | "settings" | undefined;
    }
  | {
      readonly type: "t3-ct-studio:presentation";
      readonly mode: "page" | "modal" | "hidden";
    };

const DRIVER_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
};

function baseLabelForProvider(provider: ServerProvider): string {
  if (provider.displayName?.trim()) return provider.displayName.trim();
  return DRIVER_LABELS[provider.driver] ?? provider.instanceId;
}

function isCtStudioProject(project: CtStudioHostProject): boolean {
  const normalized = project.cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.endsWith("/ct-studio") || project.title.toLowerCase() === "ct-studio";
}

export function buildCtStudioHostCatalog(
  providers: ReadonlyArray<ServerProvider>,
  projects: ReadonlyArray<EnvironmentProject> = [],
  theme: "light" | "dark" = "light",
  editor?: { readonly available: boolean; readonly label?: string | undefined },
): CtStudioHostCatalog {
  const visible = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.status !== "disabled" &&
      provider.driver !== "replay" &&
      provider.instanceId !== "devReplay",
  );
  const labelCounts = new Map<string, number>();
  for (const provider of visible) {
    const base = baseLabelForProvider(provider);
    labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1);
  }
  const mappedProviders: Array<CtStudioHostProvider> = [];
  for (const provider of visible) {
    const base = baseLabelForProvider(provider);
    const badge = provider.badgeLabel?.trim();
    const name =
      (labelCounts.get(base) ?? 0) > 1 && badge && !base.includes(badge)
        ? `${base} (${badge})`
        : base;
    const activeModels = provider.models.filter((model) => !model.isLegacy);
    const sourceModels = activeModels.length > 0 ? activeModels : provider.models;
    const models: Array<CtStudioHostModel> = sourceModels.map((model) => {
      const descriptors = model.capabilities?.optionDescriptors ?? [];
      const options: Array<CtStudioHostModelOption> = [];
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
    mappedProviders.push({
      id: provider.instanceId,
      driver: provider.driver,
      name,
      available,
      models,
    });
  }

  const mappedProjects: Array<CtStudioHostProject> = projects
    .filter((project) => !project.archivedAt && !project.isScratch)
    .map((project) => ({
      id: project.id,
      title: project.title,
      cwd: project.workspaceRoot,
    }));
  const preferredProject = mappedProjects.find(isCtStudioProject) ?? mappedProjects[0];

  return {
    id: "t3-code",
    name: "T3 Code",
    theme,
    capabilities: {
      startThread: true,
      prepareWorktree: true,
      sendThread: true,
      openDiff: true,
      ...(editor?.available ? { openInEditor: true } : {}),
    },
    ...(editor?.available && editor.label ? { editorLabel: editor.label } : {}),
    ...(preferredProject ? { defaultProjectId: preferredProject.id } : {}),
    projects: mappedProjects,
    providers: mappedProviders,
  };
}

function mapHostThreadStatus(
  thread: EnvironmentThreadShell,
): "working" | "blocked" | "done" | "idle" {
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

export function buildCtStudioHostThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<CtStudioHostThread> {
  const active: Array<EnvironmentThreadShell> = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const isSettled =
      thread.settledOverride === "settled" ||
      (thread.settledOverride !== "active" && thread.settledAt !== null);
    if (isSettled) continue;
    active.push(thread);
  }

  // Propagate ticketKey across parent/child lineage sharing the same rootThreadId so a delegated
  // child (or its parent) always stays associated with the same ticket even if only one side has the key.
  const ticketByRoot = new Map<string, string>();
  for (const thread of active) {
    const key = extractTicketKey(thread.branch, thread.title);
    if (!key) continue;
    const rootId = thread.lineage?.rootThreadId ?? thread.id;
    if (!ticketByRoot.has(rootId)) ticketByRoot.set(rootId, key);
  }

  return active.map((thread) => {
    const rootId = thread.lineage?.rootThreadId ?? thread.id;
    const ticketKey = extractTicketKey(thread.branch, thread.title) ?? ticketByRoot.get(rootId);
    const parentThreadId = thread.lineage?.parentThreadId ?? undefined;
    const relationshipToParent = thread.lineage?.relationshipToParent ?? undefined;
    const model = thread.modelSelection?.model?.trim() || undefined;
    return {
      threadId: thread.id,
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      title: thread.title,
      status: mapHostThreadStatus(thread),
      providerId: thread.providerInstanceId,
      ...(model ? { model } : {}),
      ...(thread.branch ? { branch: thread.branch } : {}),
      ...(thread.worktreePath ? { worktreePath: thread.worktreePath } : {}),
      ...(ticketKey ? { ticketKey } : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(rootId !== thread.id || parentThreadId ? { rootThreadId: rootId } : {}),
      ...(relationshipToParent ? { relationshipToParent } : {}),
      ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
      ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModelSelection(raw: unknown): CtStudioStartThreadSelection | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.providerId !== "string" || !raw.providerId.trim()) return undefined;
  if (typeof raw.modelSlug !== "string" || !raw.modelSlug.trim()) return undefined;
  const options: Array<{ readonly id: string; readonly value: string | boolean }> = [];
  if (Array.isArray(raw.options)) {
    for (const entry of raw.options) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) continue;
      if (typeof entry.value === "string" && entry.value.trim()) {
        options.push({ id: entry.id.trim(), value: entry.value.trim() });
      } else if (typeof entry.value === "boolean") {
        options.push({ id: entry.id.trim(), value: entry.value });
      }
    }
  }
  return {
    providerId: raw.providerId.trim(),
    modelSlug: raw.modelSlug.trim(),
    ...(options.length > 0 ? { options } : {}),
  };
}

function parsePrepareWorktree(raw: unknown): CtStudioPrepareWorktree | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.baseBranch !== "string" || !raw.baseBranch.trim()) return undefined;
  return {
    baseBranch: raw.baseBranch.trim(),
    ...(typeof raw.branch === "string" && raw.branch.trim() ? { branch: raw.branch.trim() } : {}),
    ...(typeof raw.startFromOrigin === "boolean" ? { startFromOrigin: raw.startFromOrigin } : {}),
  };
}

function parseThreadStatus(raw: unknown): "working" | "blocked" | "done" | "idle" | undefined {
  return raw === "working" || raw === "blocked" || raw === "done" || raw === "idle"
    ? raw
    : undefined;
}

function parseWorkspaceContext(raw: unknown): CtStudioWorkspaceContext | null {
  if (!isRecord(raw)) return null;
  const threadLinks: Record<string, CtStudioThreadLinkInfo> = {};
  if (isRecord(raw.threadLinks)) {
    let count = 0;
    for (const [threadId, value] of Object.entries(raw.threadLinks)) {
      if (count >= 150) break;
      const cleanId = threadId.trim();
      if (!cleanId || !isRecord(value)) continue;
      if (value.kind === "inbox") {
        if (typeof value.itemId !== "string" || !value.itemId.trim()) continue;
        threadLinks[cleanId] = {
          kind: "inbox",
          itemId: value.itemId.trim(),
          title:
            typeof value.title === "string" && value.title.trim()
              ? value.title.trim().slice(0, 200)
              : value.itemId.trim(),
          source:
            typeof value.source === "string" && value.source.trim()
              ? value.source.trim().slice(0, 48)
              : "Inbox",
          ...(typeof value.status === "string" && value.status.trim()
            ? { status: value.status.trim().slice(0, 32) }
            : {}),
        };
        count += 1;
      } else if (value.kind === "ticket") {
        if (typeof value.ticketKey !== "string" || !value.ticketKey.trim()) continue;
        threadLinks[cleanId] = {
          kind: "ticket",
          ticketKey: value.ticketKey.trim().slice(0, 64),
          ...(typeof value.stage === "string" && value.stage.trim()
            ? { stage: value.stage.trim().slice(0, 32) }
            : {}),
          ...(typeof value.task === "string" && value.task.trim()
            ? { task: value.task.trim().slice(0, 32) }
            : {}),
          ...(typeof value.summary === "string" && value.summary.trim()
            ? { summary: value.summary.trim().slice(0, 200) }
            : {}),
          ...(typeof value.status === "string" && value.status.trim()
            ? { status: value.status.trim().slice(0, 48) }
            : {}),
        };
        count += 1;
      }
    }
  }

  const watchedInbox: Array<CtStudioWatchedInboxItem> = [];
  if (Array.isArray(raw.watchedInbox)) {
    for (const entry of raw.watchedInbox.slice(0, 30)) {
      if (!isRecord(entry)) continue;
      if (typeof entry.id !== "string" || !entry.id.trim()) continue;
      if (typeof entry.title !== "string" || !entry.title.trim()) continue;
      const attention =
        entry.attention === "action" || entry.attention === "fyi" || entry.attention === "low"
          ? entry.attention
          : "fyi";
      const threadStatus = parseThreadStatus(entry.threadStatus);
      watchedInbox.push({
        id: entry.id.trim(),
        title: entry.title.trim().slice(0, 200),
        source:
          typeof entry.source === "string" && entry.source.trim() ? entry.source.trim() : "inbox",
        ...(typeof entry.sourceLabel === "string" && entry.sourceLabel.trim()
          ? { sourceLabel: entry.sourceLabel.trim().slice(0, 48) }
          : {}),
        attention,
        status:
          typeof entry.status === "string" && entry.status.trim() ? entry.status.trim() : "new",
        pinned: entry.pinned === true,
        time: typeof entry.time === "string" ? entry.time : "",
        ...(typeof entry.threadId === "string" && entry.threadId.trim()
          ? { threadId: entry.threadId.trim() }
          : {}),
        ...(typeof entry.environmentId === "string" && entry.environmentId.trim()
          ? { environmentId: entry.environmentId.trim() }
          : {}),
        ...(threadStatus ? { threadStatus } : {}),
      });
    }
  }

  const watchedTasks: Array<CtStudioWatchedTaskItem> = [];
  if (Array.isArray(raw.watchedTasks)) {
    for (const entry of raw.watchedTasks.slice(0, 30)) {
      if (!isRecord(entry)) continue;
      if (typeof entry.key !== "string" || !entry.key.trim()) continue;
      const statusCategory =
        entry.statusCategory === "new" ||
        entry.statusCategory === "indeterminate" ||
        entry.statusCategory === "done"
          ? entry.statusCategory
          : "indeterminate";
      const threadStatus = parseThreadStatus(entry.threadStatus);
      watchedTasks.push({
        key: entry.key.trim().slice(0, 64),
        summary:
          typeof entry.summary === "string" && entry.summary.trim()
            ? entry.summary.trim().slice(0, 200)
            : entry.key.trim(),
        status:
          typeof entry.status === "string" && entry.status.trim()
            ? entry.status.trim().slice(0, 48)
            : "",
        statusCategory,
        ...(typeof entry.priority === "string" && entry.priority.trim()
          ? { priority: entry.priority.trim().slice(0, 32) }
          : {}),
        assignedToMe: entry.assignedToMe === true,
        mentionsMe: entry.mentionsMe === true,
        ...(typeof entry.stage === "string" && entry.stage.trim()
          ? { stage: entry.stage.trim().slice(0, 32) }
          : {}),
        ...(typeof entry.threadId === "string" && entry.threadId.trim()
          ? { threadId: entry.threadId.trim() }
          : {}),
        ...(typeof entry.environmentId === "string" && entry.environmentId.trim()
          ? { environmentId: entry.environmentId.trim() }
          : {}),
        ...(threadStatus ? { threadStatus } : {}),
        ...(typeof entry.activeThreadCount === "number" && Number.isFinite(entry.activeThreadCount)
          ? { activeThreadCount: Math.max(0, Math.floor(entry.activeThreadCount)) }
          : {}),
      });
    }
  }

  return { threadLinks, watchedInbox, watchedTasks };
}

export function resolveThreadCtStudioLink(
  thread: {
    readonly id?: string | null | undefined;
    readonly title?: string | null | undefined;
    readonly branch?: string | null | undefined;
    readonly rootThreadId?: string | null | undefined;
  },
  workspaceContext: CtStudioWorkspaceContext,
): { readonly link: CtStudioThreadLinkInfo; readonly inherited: boolean } | null {
  if (thread.id && thread.id in workspaceContext.threadLinks) {
    return { link: workspaceContext.threadLinks[thread.id]!, inherited: false };
  }
  if (
    thread.rootThreadId &&
    thread.rootThreadId !== thread.id &&
    thread.rootThreadId in workspaceContext.threadLinks
  ) {
    return { link: workspaceContext.threadLinks[thread.rootThreadId]!, inherited: true };
  }
  const ticketKey = extractTicketKey(thread.branch, thread.title);
  if (!ticketKey) return null;
  const matchedTask = workspaceContext.watchedTasks.find((task) => task.key === ticketKey);
  return {
    link: {
      kind: "ticket",
      ticketKey,
      ...(matchedTask?.stage ? { stage: matchedTask.stage } : {}),
      ...(matchedTask?.summary ? { summary: matchedTask.summary } : {}),
      ...(matchedTask?.status ? { status: matchedTask.status } : {}),
    },
    inherited: false,
  };
}

function normalizeFsPath(path: string | null | undefined): string {
  return path ? path.replaceAll("\\", "/").replace(/\/+$/, "") : "";
}

function isReviewSubagentTitle(title: string): boolean {
  const trimmed = title.trim();
  return (
    /^Act as the\s+review\s+sub-agent/i.test(trimmed) ||
    /(?:^|[\s·:：-])(?:review|审查|复审)(?:[\s#·:：-]|$)/i.test(trimmed)
  );
}

export function pickBestThreadForDiff(
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
  const targetWt = normalizeFsPath(options.worktreePath);

  if (options.threadId) {
    const explicit = active.find((thread) => thread.id === options.threadId);
    if (explicit) {
      if (!targetWt || normalizeFsPath(explicit.worktreePath) === targetWt) {
        return explicit;
      }
      const matchingChildren = active.filter(
        (thread) =>
          (thread.lineage?.parentThreadId === explicit.id ||
            thread.lineage?.rootThreadId === explicit.id) &&
          normalizeFsPath(thread.worktreePath) === targetWt,
      );
      if (matchingChildren.length > 0) {
        return [...matchingChildren].toSorted((a, b) => {
          const aRank = isReviewSubagentTitle(a.title) ? 1 : 0;
          const bRank = isReviewSubagentTitle(b.title) ? 1 : 0;
          if (aRank !== bRank) return aRank - bRank;
          const ta = a.updatedAt ?? a.createdAt ?? "";
          const tb = b.updatedAt ?? b.createdAt ?? "";
          return tb.localeCompare(ta);
        })[0]!;
      }
    }
  }

  if (targetWt) {
    const byWorktree = active.filter((thread) => normalizeFsPath(thread.worktreePath) === targetWt);
    if (byWorktree.length > 0) {
      return [...byWorktree].toSorted((a, b) => {
        const rank = (thread: EnvironmentThreadShell) => {
          if (!thread.lineage?.parentThreadId) return 0;
          return isReviewSubagentTitle(thread.title) ? 2 : 1;
        };
        const diff = rank(a) - rank(b);
        if (diff !== 0) return diff;
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

export function parseCtStudioInboundMessage(data: unknown): CtStudioInboundMessage | null {
  if (!isRecord(data) || typeof data.type !== "string") return null;
  switch (data.type) {
    case "ct-studio:ready":
      return { type: "ct-studio:ready" };
    case "ct-studio:badge":
      if (typeof data.count !== "number" || !Number.isFinite(data.count) || data.count < 0) {
        return null;
      }
      return { type: "ct-studio:badge", count: Math.floor(data.count) };
    case "ct-studio:focus-thread":
      if (typeof data.threadId !== "string" || !data.threadId.trim()) return null;
      return {
        type: "ct-studio:focus-thread",
        threadId: data.threadId.trim(),
        ...(typeof data.environmentId === "string" && data.environmentId.trim()
          ? { environmentId: data.environmentId.trim() }
          : {}),
      };
    case "ct-studio:start-thread": {
      if (typeof data.requestId !== "string" || !data.requestId.trim()) return null;
      if (typeof data.prompt !== "string" || !data.prompt.trim()) return null;
      const title =
        typeof data.title === "string" && data.title.trim()
          ? data.title.trim()
          : (data.prompt.trim().split(/\r?\n/, 1)[0]?.slice(0, 60) ?? "CT Studio");
      const modelSelection = parseModelSelection(data.modelSelection);
      const prepareWorktree = parsePrepareWorktree(data.prepareWorktree);
      const interactionMode =
        data.interactionMode === "plan" || data.interactionMode === "default"
          ? data.interactionMode
          : undefined;
      return {
        type: "ct-studio:start-thread",
        requestId: data.requestId.trim(),
        ...(typeof data.projectId === "string" && data.projectId.trim()
          ? { projectId: data.projectId.trim() }
          : {}),
        ...(typeof data.cwd === "string" && data.cwd.trim() ? { cwd: data.cwd.trim() } : {}),
        ...(typeof data.worktreePath === "string" && data.worktreePath.trim()
          ? { worktreePath: data.worktreePath.trim() }
          : {}),
        ...(typeof data.branch === "string" && data.branch.trim()
          ? { branch: data.branch.trim() }
          : {}),
        ...(prepareWorktree ? { prepareWorktree } : {}),
        title,
        prompt: data.prompt,
        ...(modelSelection ? { modelSelection } : {}),
        ...(interactionMode ? { interactionMode } : {}),
        ...(typeof data.focus === "boolean" ? { focus: data.focus } : {}),
        ...(typeof data.group === "string" && data.group.trim()
          ? { group: data.group.trim() }
          : {}),
      };
    }
    case "ct-studio:prepare-worktree": {
      if (typeof data.requestId !== "string" || !data.requestId.trim()) return null;
      if (typeof data.cwd !== "string" || !data.cwd.trim()) return null;
      return {
        type: "ct-studio:prepare-worktree",
        requestId: data.requestId.trim(),
        cwd: data.cwd.trim(),
        ...(typeof data.existingWorktreePath === "string" && data.existingWorktreePath.trim()
          ? { existingWorktreePath: data.existingWorktreePath.trim() }
          : {}),
        ...(typeof data.branch === "string" && data.branch.trim()
          ? { branch: data.branch.trim() }
          : {}),
        ...(typeof data.baseBranch === "string" && data.baseBranch.trim()
          ? { baseBranch: data.baseBranch.trim() }
          : {}),
      };
    }
    case "ct-studio:send-thread": {
      if (typeof data.requestId !== "string" || !data.requestId.trim()) return null;
      if (typeof data.threadId !== "string" || !data.threadId.trim()) return null;
      if (typeof data.prompt !== "string" || !data.prompt.trim()) return null;
      return {
        type: "ct-studio:send-thread",
        requestId: data.requestId.trim(),
        threadId: data.threadId.trim(),
        ...(typeof data.environmentId === "string" && data.environmentId.trim()
          ? { environmentId: data.environmentId.trim() }
          : {}),
        prompt: data.prompt,
        ...(typeof data.title === "string" && data.title.trim()
          ? { title: data.title.trim().slice(0, 120) }
          : {}),
        ...(typeof data.focus === "boolean" ? { focus: data.focus } : {}),
      };
    }
    case "ct-studio:open-in-editor": {
      if (typeof data.requestId !== "string" || !data.requestId.trim()) return null;
      if (typeof data.path !== "string" || !data.path.trim()) return null;
      return {
        type: "ct-studio:open-in-editor",
        requestId: data.requestId.trim(),
        path: data.path.trim(),
      };
    }
    case "ct-studio:open-diff": {
      if (typeof data.requestId !== "string" || !data.requestId.trim()) return null;
      const threadId =
        typeof data.threadId === "string" && data.threadId.trim()
          ? data.threadId.trim()
          : undefined;
      const worktreePath =
        typeof data.worktreePath === "string" && data.worktreePath.trim()
          ? data.worktreePath.trim()
          : undefined;
      if (!threadId && !worktreePath) return null;
      const scope = data.scope === "unstaged" || data.scope === "branch" ? data.scope : undefined;
      const commit =
        typeof data.commit === "string" && /^[0-9a-f]{6,40}$/i.test(data.commit.trim())
          ? data.commit.trim()
          : undefined;
      return {
        type: "ct-studio:open-diff",
        requestId: data.requestId.trim(),
        ...(threadId ? { threadId } : {}),
        ...(typeof data.environmentId === "string" && data.environmentId.trim()
          ? { environmentId: data.environmentId.trim() }
          : {}),
        ...(worktreePath ? { worktreePath } : {}),
        ...(typeof data.cwd === "string" && data.cwd.trim() ? { cwd: data.cwd.trim() } : {}),
        ...(typeof data.branch === "string" && data.branch.trim()
          ? { branch: data.branch.trim() }
          : {}),
        ...(scope ? { scope } : {}),
        ...(commit ? { commit } : {}),
        ...(typeof data.title === "string" && data.title.trim()
          ? { title: data.title.trim().slice(0, 120) }
          : {}),
      };
    }
    case "ct-studio:workspace-context": {
      const context = parseWorkspaceContext(data.context);
      if (!context) return null;
      return {
        type: "ct-studio:workspace-context",
        context,
      };
    }
    case "ct-studio:toggle-back":
      return { type: "ct-studio:toggle-back" };
    default:
      return null;
  }
}
