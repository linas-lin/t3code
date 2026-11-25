import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import {
  extractSuggestedGroupFromThread,
  groupProjectActiveThreads,
  hasGroupedThreadsInSingleProjectScope,
  parseThreadGroupDropId,
  readThreadGroupName,
  threadGroupDropId,
  threadGroupExpansionKey,
  threadUngroupedDropId,
} from "./threadGrouping.logic";

type MockThread = {
  readonly id: string;
  readonly tags?: ReadonlyArray<string>;
  readonly source?: { readonly tags?: ReadonlyArray<string> };
};

describe("threadGrouping.logic", () => {
  it("groups threads within a project uniformly by leading thread order, including scheduled and inbox", () => {
    const threads: MockThread[] = [
      { id: "t-sched-1", tags: ["group:定时任务"] },
      { id: "t-plain-1" },
      { id: "t-ticket-1", tags: ["private", "group:BLUE-123"] },
      { id: "t-inbox-1", tags: ["group:inbox"] },
      { id: "t-ticket-2", tags: ["group:BLUE-123"] },
      { id: "t-plain-2", tags: ["other-tag"] },
      { id: "t-sched-2", tags: ["group:定时任务"] },
    ];

    const result = groupProjectActiveThreads({
      projectKey: "proj-a",
      threads,
      expandedByKey: {},
      getThreadKey: (thread) => thread.id,
    });

    expect(result.groupNames).toEqual(["定时任务", "BLUE-123", "inbox"]);
    expect(result.groups.map((group) => group.allThreads.map((t) => t.id))).toEqual([
      ["t-sched-1", "t-sched-2"],
      ["t-ticket-1", "t-ticket-2"],
      ["t-inbox-1"],
    ]);
    expect(result.ungrouped.map((t) => t.id)).toEqual(["t-plain-1", "t-plain-2"]);
  });

  it("hides all member rows when collapsed and marks hasActiveRouteThread on the group", () => {
    const threads: MockThread[] = [
      { id: "t-1", tags: ["group:BLUE-123"] },
      { id: "t-2", tags: ["group:BLUE-123"] },
      { id: "t-3", tags: ["group:BLUE-123"] },
    ];

    const expansionKey = threadGroupExpansionKey("proj-a", "BLUE-123");
    const result = groupProjectActiveThreads({
      projectKey: "proj-a",
      nested: true,
      threads,
      expandedByKey: { [expansionKey]: false },
      routeThreadKey: "t-2",
      getThreadKey: (thread) => thread.id,
    });

    expect(result.groups).toHaveLength(1);
    const group = result.groups[0]!;
    expect(group.collapsed).toBe(true);
    expect(group.hasActiveRouteThread).toBe(true);
    expect(group.rowId).toBe("group:nested:proj-a::BLUE-123");
    expect(group.threads).toEqual([]);
    expect(group.hiddenThreads.map((t) => t.id)).toEqual(["t-1", "t-2", "t-3"]);
    expect(group.allThreads.map((t) => t.id)).toEqual(["t-1", "t-2", "t-3"]);
  });

  it("detects when a single-project scope has grouped active threads", () => {
    const scope = new Set(["env-1:proj-1"]);
    expect(
      hasGroupedThreadsInSingleProjectScope({
        scopedProjectKeys: scope,
        isSingleProjectScope: true,
        threads: [
          {
            environmentId: "env-1" as EnvironmentThreadShell["environmentId"],
            projectId: "proj-1" as EnvironmentThreadShell["projectId"],
            pinnedAt: null,
            settledOverride: null,
            tags: ["group:BLUE-123"],
          },
        ],
      }),
    ).toBe(true);

    expect(
      hasGroupedThreadsInSingleProjectScope({
        scopedProjectKeys: scope,
        isSingleProjectScope: false,
        threads: [
          {
            environmentId: "env-1" as EnvironmentThreadShell["environmentId"],
            projectId: "proj-1" as EnvironmentThreadShell["projectId"],
            pinnedAt: null,
            settledOverride: null,
            tags: ["group:BLUE-123"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("falls back to thread.source.tags and picks the last valid group tag", () => {
    expect(readThreadGroupName({ source: { tags: ["group:OLD-1", "group:NEW-2"] } })).toBe("NEW-2");
    expect(readThreadGroupName({ tags: ["private"] })).toBeNull();
  });

  it("round-trips group and ungrouped droppable ids", () => {
    const groupId = threadGroupDropId("env:proj-1", "BLUE-123");
    expect(parseThreadGroupDropId(groupId)).toEqual({
      kind: "group",
      projectKey: "env:proj-1",
      groupName: "BLUE-123",
    });

    const ungroupedId = threadUngroupedDropId("env:proj-1");
    expect(parseThreadGroupDropId(ungroupedId)).toEqual({
      kind: "ungrouped",
      projectKey: "env:proj-1",
    });

    expect(parseThreadGroupDropId("other-drop-id")).toBeNull();
  });

  it("extracts suggested group names from linked issue, branch, worktree, or unique title ticket", () => {
    expect(
      extractSuggestedGroupFromThread({
        title: "Work on BLUE-999",
        branch: "feat/BLUE-123-cart",
        worktreePath: null,
        issues: [{ displayKey: "ENG-42" } as NonNullable<EnvironmentThreadShell["issues"]>[number]],
      }),
    ).toBe("ENG-42");

    expect(
      extractSuggestedGroupFromThread({
        title: "Fix pricing",
        branch: "feat/BLUE-123-pricing",
        worktreePath: null,
        issues: [],
      }),
    ).toBe("BLUE-123");

    expect(
      extractSuggestedGroupFromThread({
        title: "Compare BLUE-123 and BLUE-456",
        branch: null,
        worktreePath: null,
        issues: [],
      }),
    ).toBeNull();
  });
});
