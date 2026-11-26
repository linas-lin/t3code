import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  classifySidebarFocusBucket,
  partitionSidebarFocusThreads,
  readSidebarFocusTopEnabled,
  writeSidebarFocusTopEnabled,
} from "./sidebarFocusSection";

function makeThread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("env-1"),
    id: ThreadId.make(id),
    projectId: ProjectId.make("proj-1"),
    title: `Thread ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-11-26T08:00:00.000Z",
    updatedAt: "2026-11-26T08:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    settledAt: null,
    unsettledAt: null,
    settledOverride: null,
    snoozedAt: null,
    snoozedUntil: null,
    lastVisitedAt: "2026-11-26T08:00:00.000Z",
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    hasActionableProposedPlan: false,
    blockedOnThreadWait: false,
    providerInstanceId: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

describe("sidebarFocusSection", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults sidebar focus top preference to enabled and persists toggles", () => {
    expect(readSidebarFocusTopEnabled()).toBe(true);
    writeSidebarFocusTopEnabled(false);
    expect(readSidebarFocusTopEnabled()).toBe(false);
    writeSidebarFocusTopEnabled(true);
    expect(readSidebarFocusTopEnabled()).toBe(true);
  });

  it("classifies attention, unread completion, working, and idle ready threads", () => {
    const approval = makeThread("approval", { hasPendingApprovals: true });
    const input = makeThread("input", { hasPendingUserInput: true });
    const failedUnread = makeThread("failed-unread", {
      lastVisitedAt: "2026-11-26T08:00:00.000Z",
      runtime: {
        status: "failed",
        activeRunId: null,
        updatedAt: "2026-11-26T08:05:00.000Z",
      } as any,
      latestRun: {
        runId: "r1",
        status: "failed",
        requestedAt: "2026-11-26T08:04:00.000Z",
        completedAt: "2026-11-26T08:05:00.000Z",
      } as any,
    });
    const failedRead = makeThread("failed-read", {
      lastVisitedAt: "2026-11-26T08:10:00.000Z",
      runtime: {
        status: "failed",
        activeRunId: null,
        updatedAt: "2026-11-26T08:05:00.000Z",
      } as any,
      latestRun: {
        runId: "r2",
        status: "failed",
        requestedAt: "2026-11-26T08:04:00.000Z",
        completedAt: "2026-11-26T08:05:00.000Z",
      } as any,
    });
    const unread = makeThread("unread", {
      lastVisitedAt: "2026-11-26T08:00:00.000Z",
      latestRun: {
        runId: "r3",
        status: "completed",
        requestedAt: "2026-11-26T08:01:00.000Z",
        completedAt: "2026-11-26T08:03:00.000Z",
      } as any,
    });
    const interrupted = makeThread("interrupted", {
      lastVisitedAt: "2026-11-26T08:00:00.000Z",
      latestRun: {
        runId: "r4",
        status: "interrupted",
        requestedAt: "2026-11-26T08:01:00.000Z",
        completedAt: "2026-11-26T08:03:00.000Z",
      } as any,
    });
    const working = makeThread("working", {
      runtime: {
        status: "running",
        activeRunId: "r5",
        updatedAt: "2026-11-26T08:06:00.000Z",
      } as any,
    });
    const readyRead = makeThread("ready-read", {
      lastVisitedAt: "2026-11-26T08:10:00.000Z",
      latestRun: {
        runId: "r6",
        status: "completed",
        requestedAt: "2026-11-26T08:01:00.000Z",
        completedAt: "2026-11-26T08:03:00.000Z",
      } as any,
    });

    expect(classifySidebarFocusBucket(approval)).toBe("attention");
    expect(classifySidebarFocusBucket(input)).toBe("attention");
    expect(classifySidebarFocusBucket(failedUnread)).toBe("attention");
    expect(classifySidebarFocusBucket(failedRead)).toBeNull();
    expect(classifySidebarFocusBucket(unread)).toBe("unread");
    expect(classifySidebarFocusBucket(interrupted)).toBeNull();
    expect(classifySidebarFocusBucket(working)).toBe("working");
    expect(classifySidebarFocusBucket(readyRead)).toBeNull();
  });

  it("mirrors focus threads in attention > unread > working order while preserving original lists", () => {
    const workingOlder = makeThread("working-older", {
      updatedAt: "2026-11-26T08:01:00.000Z",
      runtime: {
        status: "running",
        activeRunId: "r1",
        updatedAt: "2026-11-26T08:01:00.000Z",
      } as any,
    });
    const workingNewer = makeThread("working-newer", {
      pinnedAt: "2026-11-26T07:00:00.000Z",
      updatedAt: "2026-11-26T08:09:00.000Z",
      runtime: {
        status: "running",
        activeRunId: "r2",
        updatedAt: "2026-11-26T08:09:00.000Z",
      } as any,
    });
    const unread = makeThread("unread", {
      lastVisitedAt: "2026-11-26T08:00:00.000Z",
      latestRun: {
        runId: "r3",
        status: "completed",
        requestedAt: "2026-11-26T08:02:00.000Z",
        completedAt: "2026-11-26T08:04:00.000Z",
      } as any,
    });
    const attention = makeThread("attention", {
      hasPendingUserInput: true,
      updatedAt: "2026-11-26T08:02:00.000Z",
    });
    const pinnedIdle = makeThread("pinned-idle", {
      pinnedAt: "2026-11-26T07:00:00.000Z",
    });
    const activeIdle = makeThread("active-idle");

    const pinnedThreads = [workingNewer, pinnedIdle];
    const activeThreads = [workingOlder, activeIdle, unread, attention];

    const result = partitionSidebarFocusThreads({
      enabled: true,
      pinnedThreads,
      activeThreads,
      localLastVisitedAtById: {},
    });

    expect(result.focusThreads.map((t) => t.id)).toEqual([
      "attention",
      "unread",
      "working-newer",
      "working-older",
    ]);
    expect(result.remainingPinnedThreads).toBe(pinnedThreads);
    expect(result.remainingActiveThreads).toBe(activeThreads);
    expect(result.remainingPinnedThreads.map((t) => t.id)).toEqual([
      "working-newer",
      "pinned-idle",
    ]);
    expect(result.remainingActiveThreads.map((t) => t.id)).toEqual([
      "working-older",
      "active-idle",
      "unread",
      "attention",
    ]);
  });

  it("deduplicates mirrored focus threads if the same thread appears in both pinned and active", () => {
    const sharedWorking = makeThread("shared-working", {
      runtime: {
        status: "running",
        activeRunId: "r1",
        updatedAt: "2026-11-26T08:06:00.000Z",
      } as any,
    });

    const result = partitionSidebarFocusThreads({
      enabled: true,
      pinnedThreads: [sharedWorking],
      activeThreads: [sharedWorking],
      localLastVisitedAtById: {},
    });

    expect(result.focusThreads.map((t) => t.id)).toEqual(["shared-working"]);
  });

  it("keeps a sticky viewed thread in the focus mirror after it becomes read without removing it from active", () => {
    const justRead = makeThread("just-read", {
      lastVisitedAt: "2026-11-26T08:10:00.000Z",
      latestRun: {
        runId: "r1",
        status: "completed",
        requestedAt: "2026-11-26T08:01:00.000Z",
        completedAt: "2026-11-26T08:05:00.000Z",
      } as any,
    });
    const otherIdle = makeThread("other-idle");
    const activeThreads = [justRead, otherIdle];

    const anchored = partitionSidebarFocusThreads({
      enabled: true,
      pinnedThreads: [],
      activeThreads,
      localLastVisitedAtById: {},
      stickyFocus: { key: "env-1:just-read", bucket: "unread" },
    });
    expect(anchored.focusThreads.map((t) => t.id)).toEqual(["just-read"]);
    expect(anchored.remainingActiveThreads).toBe(activeThreads);
    expect(anchored.remainingActiveThreads.map((t) => t.id)).toEqual(["just-read", "other-idle"]);

    const released = partitionSidebarFocusThreads({
      enabled: true,
      pinnedThreads: [],
      activeThreads,
      localLastVisitedAtById: {},
      stickyFocus: null,
    });
    expect(released.focusThreads).toEqual([]);
    expect(released.remainingActiveThreads).toBe(activeThreads);
    expect(released.remainingActiveThreads.map((t) => t.id)).toEqual(["just-read", "other-idle"]);
  });

  it("returns original lists untouched when disabled", () => {
    const working = makeThread("working", {
      runtime: {
        status: "running",
        activeRunId: "r1",
        updatedAt: "2026-11-26T08:01:00.000Z",
      } as any,
    });
    const pinned = makeThread("pinned", { pinnedAt: "2026-11-26T07:00:00.000Z" });
    const pinnedThreads = [pinned];
    const activeThreads = [working];

    const result = partitionSidebarFocusThreads({
      enabled: false,
      pinnedThreads,
      activeThreads,
      localLastVisitedAtById: {},
    });
    expect(result.focusThreads).toEqual([]);
    expect(result.remainingPinnedThreads).toBe(pinnedThreads);
    expect(result.remainingActiveThreads).toBe(activeThreads);
    expect(result.remainingPinnedThreads.map((t) => t.id)).toEqual(["pinned"]);
    expect(result.remainingActiveThreads.map((t) => t.id)).toEqual(["working"]);
  });
});
