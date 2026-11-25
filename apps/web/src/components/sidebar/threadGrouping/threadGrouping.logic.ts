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

function sidebarThreadGroupRowId(projectKey: string, groupName: string): string {
  return `group:${projectKey}${KEY_SEPARATOR}${groupName}`;
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
 * Groups active threads within a single project by their `group:*` tag.
 * Preserves the caller's thread order inside each group and orders every group
 * uniformly by its leading (most recent under the active sort order) thread.
 */
export function groupProjectActiveThreads<
  T extends Pick<EnvironmentThreadShell, "tags"> & {
    readonly source?: { readonly tags?: ReadonlyArray<string> | undefined } | undefined;
  },
>(input: {
  readonly projectKey: string;
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

  const groups: SidebarThreadGroupBucket<T>[] = orderedGroupNames.map((groupName) => {
    const allThreads = bucketMap.get(groupName)!;
    const expansionKey = threadGroupExpansionKey(input.projectKey, groupName);
    const collapsed = input.expandedByKey[expansionKey] === false;
    const visibleThreads = collapsed
      ? allThreads.filter(
          (thread) =>
            input.routeThreadKey != null && input.getThreadKey(thread) === input.routeThreadKey,
        )
      : allThreads;
    const hiddenThreads = collapsed
      ? allThreads.filter(
          (thread) =>
            input.routeThreadKey == null || input.getThreadKey(thread) !== input.routeThreadKey,
        )
      : [];
    return {
      projectKey: input.projectKey,
      groupName,
      expansionKey,
      rowId: sidebarThreadGroupRowId(input.projectKey, groupName),
      dropId: threadGroupDropId(input.projectKey, groupName),
      collapsed,
      threads: visibleThreads,
      allThreads,
      hiddenThreads,
    };
  });

  return {
    groups,
    ungrouped,
    groupNames: orderedGroupNames,
  };
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
