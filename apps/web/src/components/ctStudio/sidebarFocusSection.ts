import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { useState, useSyncExternalStore } from "react";

import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

const SIDEBAR_FOCUS_TOP_STORAGE_KEY = "t3code:ct-studio:sidebar-focus-top";
const SIDEBAR_FOCUS_EXPANDED_STORAGE_KEY = "t3code:ct-studio:sidebar-focus-expanded";

export type SidebarFocusBucket = "attention" | "unread" | "working";

const BUCKET_PRIORITY: Record<SidebarFocusBucket, number> = {
  attention: 0,
  unread: 1,
  working: 2,
};

const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

const focusTopListeners = new Set<() => void>();

function notifyFocusTopListeners() {
  for (const listener of focusTopListeners) listener();
}

export function readSidebarFocusTopEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_FOCUS_TOP_STORAGE_KEY);
    if (raw === null) return true;
    return raw !== "false" && raw !== "0";
  } catch {
    return true;
  }
}

export function writeSidebarFocusTopEnabled(enabled: boolean): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SIDEBAR_FOCUS_TOP_STORAGE_KEY, enabled ? "true" : "false");
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }
  notifyFocusTopListeners();
}

function subscribeFocusTopEnabled(listener: () => void): () => void {
  focusTopListeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SIDEBAR_FOCUS_TOP_STORAGE_KEY) {
      listener();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    focusTopListeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

export function useSidebarFocusTopEnabled(): boolean {
  return useSyncExternalStore(subscribeFocusTopEnabled, readSidebarFocusTopEnabled, () => true);
}

function readSidebarFocusExpanded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_FOCUS_EXPANDED_STORAGE_KEY);
    if (raw === null) return true;
    return raw !== "false" && raw !== "0";
  } catch {
    return true;
  }
}

export function useSidebarFocusExpanded(): readonly [boolean, () => void] {
  const [expanded, setExpanded] = useState(readSidebarFocusExpanded);
  const toggle = () => {
    setExpanded((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(SIDEBAR_FOCUS_EXPANDED_STORAGE_KEY, next ? "true" : "false");
        } catch {
          // Ignore storage failures in restricted contexts.
        }
      }
      return next;
    });
  };
  return [expanded, toggle] as const;
}

function focusBucketForStatus(status: SidebarThreadStatus): SidebarFocusBucket | null {
  switch (status) {
    case "approval":
    case "input":
    case "request":
    case "failed":
    case "limited":
      return "attention";
    case "preparing":
    case "working":
    case "waiting":
      return "working";
    case "ready":
      return null;
  }
}

export function classifySidebarFocusBucket(
  thread: EnvironmentThreadShell,
  localLastVisitedAt?: string,
): SidebarFocusBucket | null {
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const threadWithVisit = { ...thread, lastVisitedAt };
  const status = resolveSidebarRowStatus(threadWithVisit);
  const statusBucket = focusBucketForStatus(status);
  if (statusBucket !== null) return statusBucket;
  return hasUnseenCompletion(threadWithVisit) ? "unread" : null;
}

function focusActivityTimestamp(thread: EnvironmentThreadShell): number {
  return Math.max(
    toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
    toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
    toSortableTimestamp(thread.latestUserAuthoredMessageAt ?? undefined) ?? 0,
    toSortableTimestamp(thread.updatedAt) ?? 0,
    toSortableTimestamp(thread.createdAt) ?? 0,
  );
}

export interface StickySidebarFocus {
  readonly key: string;
  readonly bucket: SidebarFocusBucket;
}

export interface SidebarFocusPartitionResult {
  readonly focusThreads: readonly EnvironmentThreadShell[];
  readonly remainingPinnedThreads: readonly EnvironmentThreadShell[];
  readonly remainingActiveThreads: readonly EnvironmentThreadShell[];
  readonly naturalBucketByKey: ReadonlyMap<string, SidebarFocusBucket>;
}

export function partitionSidebarFocusThreads(input: {
  readonly enabled: boolean;
  readonly pinnedThreads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly localLastVisitedAtById: Readonly<Record<string, string>>;
  readonly stickyFocus?: StickySidebarFocus | null;
}): SidebarFocusPartitionResult {
  const { enabled, pinnedThreads, activeThreads, localLastVisitedAtById, stickyFocus } = input;
  const naturalBucketByKey = new Map<string, SidebarFocusBucket>();
  if (!enabled) {
    return {
      focusThreads: EMPTY_THREADS,
      remainingPinnedThreads: pinnedThreads,
      remainingActiveThreads: activeThreads,
      naturalBucketByKey,
    };
  }

  const focusEntries: Array<{
    readonly thread: EnvironmentThreadShell;
    readonly bucket: SidebarFocusBucket;
    readonly timestamp: number;
  }> = [];
  const remainingPinned: EnvironmentThreadShell[] = [];
  const remainingActive: EnvironmentThreadShell[] = [];

  const collect = (
    list: readonly EnvironmentThreadShell[],
    remaining: EnvironmentThreadShell[],
  ) => {
    for (const thread of list) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const naturalBucket = classifySidebarFocusBucket(thread, localLastVisitedAtById[key]);
      if (naturalBucket !== null) {
        naturalBucketByKey.set(key, naturalBucket);
      }
      const effectiveBucket =
        naturalBucket ?? (stickyFocus?.key === key ? stickyFocus.bucket : null);
      if (effectiveBucket !== null) {
        focusEntries.push({
          thread,
          bucket: effectiveBucket,
          timestamp: focusActivityTimestamp(thread),
        });
      } else {
        remaining.push(thread);
      }
    }
  };

  collect(pinnedThreads, remainingPinned);
  collect(activeThreads, remainingActive);

  focusEntries.sort(
    (left, right) =>
      BUCKET_PRIORITY[left.bucket] - BUCKET_PRIORITY[right.bucket] ||
      right.timestamp - left.timestamp ||
      left.thread.id.localeCompare(right.thread.id) ||
      left.thread.environmentId.localeCompare(right.thread.environmentId),
  );

  return {
    focusThreads: focusEntries.map((entry) => entry.thread),
    remainingPinnedThreads: remainingPinned,
    remainingActiveThreads: remainingActive,
    naturalBucketByKey,
  };
}

/**
 * Extracts active/unread/attention threads into a top focus section while keeping
 * the currently viewed thread anchored until the user navigates away so clicking an
 * unread thread does not make it jump out from under the pointer.
 */
export function useSidebarFocusPartition(input: {
  readonly enabled: boolean;
  readonly pinnedThreads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly routeRowThreadKey: string | null;
}) {
  const localLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const [stickyState, setStickyState] = useState<{
    readonly routeKey: string | null;
    readonly sticky: StickySidebarFocus | null;
  }>({ routeKey: input.routeRowThreadKey, sticky: null });

  const activeSticky =
    input.enabled && stickyState.routeKey === input.routeRowThreadKey ? stickyState.sticky : null;

  const partitioned = partitionSidebarFocusThreads({
    enabled: input.enabled,
    pinnedThreads: input.pinnedThreads,
    activeThreads: input.activeThreads,
    localLastVisitedAtById,
    stickyFocus: activeSticky,
  });

  const routeNaturalBucket =
    input.enabled && input.routeRowThreadKey !== null
      ? (partitioned.naturalBucketByKey.get(input.routeRowThreadKey) ?? null)
      : null;

  const nextSticky: StickySidebarFocus | null = !input.enabled
    ? null
    : input.routeRowThreadKey === null
      ? null
      : routeNaturalBucket !== null
        ? { key: input.routeRowThreadKey, bucket: routeNaturalBucket }
        : stickyState.routeKey === input.routeRowThreadKey
          ? stickyState.sticky
          : null;

  if (
    stickyState.routeKey !== input.routeRowThreadKey ||
    stickyState.sticky?.key !== nextSticky?.key ||
    stickyState.sticky?.bucket !== nextSticky?.bucket
  ) {
    setStickyState({ routeKey: input.routeRowThreadKey, sticky: nextSticky });
  }

  return partitioned;
}
