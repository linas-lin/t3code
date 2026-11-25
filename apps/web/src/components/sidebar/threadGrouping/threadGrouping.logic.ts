import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  MAX_THREAD_GROUP_NAME_LENGTH,
  normalizeThreadGroupName,
  parseThreadGroupName,
} from "@t3tools/contracts";

export { MAX_THREAD_GROUP_NAME_LENGTH, normalizeThreadGroupName };

const TICKET_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const GROUP_DROP_PREFIX = "sidebar-group-drop:";
const UNGROUPED_DROP_PREFIX = "sidebar-ungrouped-drop:";
const KEY_SEPARATOR = "::";

export const THREAD_GROUP_LIST_CLASS = [
  "[&>li:has([data-sidebar-parent^='group:top:'])]:relative",
  "[&>li:has([data-sidebar-parent^='group:top:'])]:pl-4",
  "[&>li:has([data-sidebar-parent^='group:top:'])]:before:pointer-events-none",
  "[&>li:has([data-sidebar-parent^='group:top:'])]:before:absolute",
  "[&>li:has([data-sidebar-parent^='group:top:'])]:before:inset-y-0",
  "[&>li:has([data-sidebar-parent^='group:top:'])]:before:left-2.5",
  "[&>li:has([data-sidebar-parent^='group:top:'])]:before:w-px",
  "[&>li:has([data-sidebar-parent^='group:top:'])]:before:bg-sidebar-border/80",
  "[&>li:has([data-sidebar-parent^='group:top:'])]:before:content-['']",
  "[&>li:has([data-sidebar-parent^='group:nested:'])]:relative",
  "[&>li:has([data-sidebar-parent^='group:nested:'])]:pl-7",
  "[&>li:has([data-sidebar-parent^='group:nested:'])]:before:pointer-events-none",
  "[&>li:has([data-sidebar-parent^='group:nested:'])]:before:absolute",
  "[&>li:has([data-sidebar-parent^='group:nested:'])]:before:inset-y-0",
  "[&>li:has([data-sidebar-parent^='group:nested:'])]:before:left-5.5",
  "[&>li:has([data-sidebar-parent^='group:nested:'])]:before:w-px",
  "[&>li:has([data-sidebar-parent^='group:nested:'])]:before:bg-sidebar-border/80",
  "[&>li:has([data-sidebar-parent^='group:nested:'])]:before:content-['']",
].join(" ");

export function readThreadTags(thread: {
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly source?: { readonly tags?: ReadonlyArray<string> | undefined } | undefined;
}): ReadonlyArray<string> {
  return thread.tags ?? thread.source?.tags ?? [];
}

export function readThreadGroupName(thread: {
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly source?: { readonly tags?: ReadonlyArray<string> | undefined } | undefined;
}): string | null {
  return parseThreadGroupName(readThreadTags(thread));
}

export function threadGroupExpansionKey(projectKey: string, groupName: string): string {
  return `${projectKey}${KEY_SEPARATOR}${groupName}`;
}

function sidebarThreadGroupRowId(projectKey: string, groupName: string, nested: boolean): string {
  return `group:${nested ? "nested" : "top"}:${projectKey}${KEY_SEPARATOR}${groupName}`;
}

export function threadGroupDropId(projectKey: string, groupName: string): string {
  return `${GROUP_DROP_PREFIX}${projectKey}${KEY_SEPARATOR}${groupName}`;
}

export function threadUngroupedDropId(projectKey: string): string {
  return `${UNGROUPED_DROP_PREFIX}${projectKey}`;
}

export type ParsedThreadGroupDropTarget =
  | { readonly kind: "group"; readonly projectKey: string; readonly groupName: string }
  | { readonly kind: "ungrouped"; readonly projectKey: string };

export function parseThreadGroupDropId(id: string): ParsedThreadGroupDropTarget | null {
  if (id.startsWith(GROUP_DROP_PREFIX)) {
    const rest = id.slice(GROUP_DROP_PREFIX.length);
    const separatorIndex = rest.indexOf(KEY_SEPARATOR);
    if (separatorIndex <= 0) return null;
    const projectKey = rest.slice(0, separatorIndex);
    const groupName = normalizeThreadGroupName(rest.slice(separatorIndex + KEY_SEPARATOR.length));
    if (!projectKey || groupName === null) return null;
    return { kind: "group", projectKey, groupName };
  }
  if (id.startsWith(UNGROUPED_DROP_PREFIX)) {
    const projectKey = id.slice(UNGROUPED_DROP_PREFIX.length);
    if (!projectKey) return null;
    return { kind: "ungrouped", projectKey };
  }
  return null;
}

export interface SidebarThreadGroupBucket<T> {
  readonly projectKey: string;
  readonly groupName: string;
  readonly expansionKey: string;
  readonly rowId: string;
  readonly dropId: string;
  readonly collapsed: boolean;
  readonly hasActiveRouteThread: boolean;
  readonly threads: readonly T[];
  readonly allThreads: readonly T[];
  readonly hiddenThreads: readonly T[];
}

export interface ProjectActiveThreadsGroupingResult<T> {
  readonly groups: readonly SidebarThreadGroupBucket<T>[];
  readonly ungrouped: readonly T[];
  readonly groupNames: readonly string[];
}

/**
 * Groups active threads within one project by `group:*` tag, preserving input order inside each
 * group and ordering groups by their leading thread. Collapsed groups hide all member rows.
 */
export function groupProjectActiveThreads<
  T extends Pick<EnvironmentThreadShell, "tags"> & {
    readonly source?: { readonly tags?: ReadonlyArray<string> | undefined } | undefined;
  },
>(input: {
  readonly projectKey: string;
  readonly nested?: boolean;
  readonly threads: readonly T[];
  readonly expandedByKey: Readonly<Record<string, boolean>>;
  readonly routeThreadKey?: string | null;
  readonly getThreadKey: (thread: T) => string;
}): ProjectActiveThreadsGroupingResult<T> {
  const bucketMap = new Map<string, T[]>();
  const orderedGroupNames: string[] = [];
  const ungrouped: T[] = [];

  for (const thread of input.threads) {
    const groupName = readThreadGroupName(thread);
    if (groupName === null) {
      ungrouped.push(thread);
      continue;
    }
    let bucket = bucketMap.get(groupName);
    if (!bucket) {
      bucket = [];
      bucketMap.set(groupName, bucket);
      orderedGroupNames.push(groupName);
    }
    bucket.push(thread);
  }

  const nested = input.nested === true;
  const groups: SidebarThreadGroupBucket<T>[] = orderedGroupNames.map((groupName) => {
    const allThreads = bucketMap.get(groupName)!;
    const expansionKey = threadGroupExpansionKey(input.projectKey, groupName);
    const collapsed = input.expandedByKey[expansionKey] === false;
    const hasActiveRouteThread =
      input.routeThreadKey != null &&
      allThreads.some((thread) => input.getThreadKey(thread) === input.routeThreadKey);
    return {
      projectKey: input.projectKey,
      groupName,
      expansionKey,
      rowId: sidebarThreadGroupRowId(input.projectKey, groupName, nested),
      dropId: threadGroupDropId(input.projectKey, groupName),
      collapsed,
      hasActiveRouteThread,
      threads: collapsed ? [] : allThreads,
      allThreads,
      hiddenThreads: collapsed ? allThreads : [],
    };
  });

  return {
    groups,
    ungrouped,
    groupNames: orderedGroupNames,
  };
}

/**
 * Returns true when a single-project filter scope has at least one non-settled,
 * non-pinned thread carrying a `group:*` tag so the Working shelf can stay off
 * and keep working threads inside their group.
 */
export function hasGroupedThreadsInSingleProjectScope(input: {
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly isSingleProjectScope: boolean;
  readonly threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      "environmentId" | "projectId" | "pinnedAt" | "settledOverride" | "tags"
    > & {
      readonly source?: { readonly tags?: ReadonlyArray<string> | undefined } | undefined;
    }
  >;
}): boolean {
  if (!input.isSingleProjectScope || input.scopedProjectKeys === null) return false;
  for (const thread of input.threads) {
    if (!input.scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)) continue;
    if (thread.pinnedAt != null || thread.settledOverride === "settled") continue;
    if (readThreadGroupName(thread) !== null) return true;
  }
  return false;
}

function extractUniqueTicketKey(text: string | null | undefined): string | null {
  if (!text) return null;
  const matches = new Set<string>();
  for (const match of text.matchAll(TICKET_KEY_PATTERN)) {
    const key = match[1];
    if (key) matches.add(key);
  }
  if (matches.size !== 1) return null;
  return normalizeThreadGroupName([...matches][0]!);
}

/**
 * Suggests a single group name (e.g. Jira/Linear ticket key) for menu actions only.
 * Never used to auto-assign groups during sidebar rendering.
 */
export function extractSuggestedGroupFromThread(
  thread: Pick<EnvironmentThreadShell, "title" | "branch" | "worktreePath" | "issues">,
): string | null {
  const firstIssueKey = thread.issues?.[0]?.displayKey;
  if (firstIssueKey) {
    const normalizedIssue = normalizeThreadGroupName(firstIssueKey);
    if (normalizedIssue !== null) return normalizedIssue;
  }
  return (
    extractUniqueTicketKey(thread.branch) ??
    extractUniqueTicketKey(thread.worktreePath) ??
    extractUniqueTicketKey(thread.title)
  );
}
