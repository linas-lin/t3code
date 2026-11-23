import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCtStudioHostCatalog,
  buildCtStudioHostThreads,
  parseCtStudioInboundMessage,
  pickBestThreadForDiff,
  resolveThreadCtStudioLink,
} from "./ctStudioBridge";
import {
  buildCtStudioUrl,
  DEFAULT_CT_STUDIO_URL,
  detectClientPlatform,
  extractTicketKey,
  isCtStudioWorkspace,
  isTrustedCtStudioOrigin,
  joinCtStudioClonePath,
  normalizeCtStudioUrl,
  normalizeGitRepoUrl,
  toggleGitRepoProtocol,
} from "./ctStudioConfig";

describe("ctStudioConfig", () => {
  it("extracts Jira ticket keys from branch or title while ignoring technical acronyms", () => {
    expect(extractTicketKey("DEMO-123", "Implement checkout")).toBe("DEMO-123");
    expect(extractTicketKey("feat/demo-456-fix", "Random title")).toBe("DEMO-456");
    expect(extractTicketKey(null, "[CORE-99] Fix UTF-8 encoding")).toBe("CORE-99");
    expect(extractTicketKey("main", "Upgrade SHA-256 and HTTP-2 handling")).toBeNull();
    expect(extractTicketKey(null, "General refactor")).toBeNull();
  });

  it("normalizes and validates configured URLs", () => {
    expect(normalizeCtStudioUrl("http://127.0.0.1:4600/")).toBe(DEFAULT_CT_STUDIO_URL);
    expect(normalizeCtStudioUrl("https://studio.internal:8443/app/")).toBe(
      "https://studio.internal:8443/app",
    );
    expect(normalizeCtStudioUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeCtStudioUrl("not a url")).toBeNull();
  });

  it("checks trusted origins including loopback aliases on matching ports", () => {
    expect(isTrustedCtStudioOrigin("http://127.0.0.1:4600", DEFAULT_CT_STUDIO_URL)).toBe(true);
    expect(isTrustedCtStudioOrigin("http://localhost:4600", DEFAULT_CT_STUDIO_URL)).toBe(true);
    expect(isTrustedCtStudioOrigin("http://localhost:4601", DEFAULT_CT_STUDIO_URL)).toBe(false);
    expect(isTrustedCtStudioOrigin("https://evil.example", DEFAULT_CT_STUDIO_URL)).toBe(false);
  });

  it("builds initial URL with embedded flag and hash deep link when a ticket is provided", () => {
    expect(buildCtStudioUrl(DEFAULT_CT_STUDIO_URL)).toBe("http://127.0.0.1:4600/?embedded=1");
    expect(buildCtStudioUrl(DEFAULT_CT_STUDIO_URL, { ticket: "DEMO-123" })).toBe(
      "http://127.0.0.1:4600/?embedded=1#jira/DEMO-123",
    );
  });

  it("validates git repository URLs, toggles HTTPS/SSH, and detects ct-studio workspaces", () => {
    expect(normalizeGitRepoUrl("https://github.com/org/ct-studio.git")).toBe(
      "https://github.com/org/ct-studio.git",
    );
    expect(normalizeGitRepoUrl("git@github.com:org/ct-studio.git")).toBe(
      "git@github.com:org/ct-studio.git",
    );
    expect(normalizeGitRepoUrl("not a url")).toBeNull();
    expect(toggleGitRepoProtocol("https://github.com/org/ct-studio.git")).toBe(
      "git@github.com:org/ct-studio.git",
    );
    expect(toggleGitRepoProtocol("git@github.com:org/ct-studio.git")).toBe(
      "https://github.com/org/ct-studio.git",
    );
    expect(isCtStudioWorkspace({ title: "ct-studio", workspaceRoot: "/Users/dev/ct-studio" })).toBe(
      true,
    );
    expect(isCtStudioWorkspace({ title: "shop", workspaceRoot: "/Users/dev/sample-app" })).toBe(
      false,
    );
    expect(detectClientPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0)")).toBe("windows");
    expect(detectClientPlatform("MacIntel", "Mozilla/5.0 (Macintosh)")).toBe("macos");
    expect(detectClientPlatform("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)")).toBe("other");
    expect(joinCtStudioClonePath("C:\\Users\\dev\\projects\\")).toBe(
      "C:\\Users\\dev\\projects\\ct-studio",
    );
    expect(joinCtStudioClonePath("/Users/dev/projects/")).toBe("/Users/dev/projects/ct-studio");
    expect(joinCtStudioClonePath(null)).toBe("~/projects/ct-studio");
  });
});

describe("parseCtStudioInboundMessage", () => {
  it("parses valid bridge messages and rejects malformed payloads", () => {
    expect(parseCtStudioInboundMessage({ type: "ct-studio:ready" })).toEqual({
      type: "ct-studio:ready",
    });
    expect(parseCtStudioInboundMessage({ type: "ct-studio:badge", count: 3.8 })).toEqual({
      type: "ct-studio:badge",
      count: 3,
    });
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:focus-thread",
        threadId: "thr_123",
        environmentId: "env_1",
      }),
    ).toEqual({
      type: "ct-studio:focus-thread",
      threadId: "thr_123",
      environmentId: "env_1",
    });
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:prepare-worktree",
        requestId: "prep-1",
        cwd: "/Users/dev/sample-app",
        baseBranch: "develop",
        branch: "DEMO-123",
      }),
    ).toEqual({
      type: "ct-studio:prepare-worktree",
      requestId: "prep-1",
      cwd: "/Users/dev/sample-app",
      baseBranch: "develop",
      branch: "DEMO-123",
    });
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:prepare-worktree",
        requestId: "prep-2",
        cwd: "   ",
      }),
    ).toBeNull();
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:send-thread",
        requestId: "send-1",
        threadId: "thr-1",
        environmentId: "env-1",
        prompt: "Continue with T2",
        title: "DEMO-123 · 开发 T1~T2 (team)",
        focus: true,
      }),
    ).toEqual({
      type: "ct-studio:send-thread",
      requestId: "send-1",
      threadId: "thr-1",
      environmentId: "env-1",
      prompt: "Continue with T2",
      title: "DEMO-123 · 开发 T1~T2 (team)",
      focus: true,
    });
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:open-in-editor",
        requestId: "edit-1",
        path: "/Users/dev/worktrees/shop-DEMO-123",
      }),
    ).toEqual({
      type: "ct-studio:open-in-editor",
      requestId: "edit-1",
      path: "/Users/dev/worktrees/shop-DEMO-123",
    });
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:open-diff",
        requestId: "diff-1",
        worktreePath: "/Users/dev/worktrees/shop-DEMO-123",
        cwd: "/Users/dev/shop",
        branch: "DEMO-123",
        scope: "unstaged",
        commit: "abc1234",
        title: "DEMO-123 · shop Review",
      }),
    ).toEqual({
      type: "ct-studio:open-diff",
      requestId: "diff-1",
      worktreePath: "/Users/dev/worktrees/shop-DEMO-123",
      cwd: "/Users/dev/shop",
      branch: "DEMO-123",
      scope: "unstaged",
      commit: "abc1234",
      title: "DEMO-123 · shop Review",
    });
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:open-diff",
        requestId: "diff-invalid-sha",
        threadId: "thr-1",
        commit: "not-a-sha!",
      }),
    ).toEqual({
      type: "ct-studio:open-diff",
      requestId: "diff-invalid-sha",
      threadId: "thr-1",
    });
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:open-diff",
        requestId: "diff-2",
      }),
    ).toBeNull();
    expect(parseCtStudioInboundMessage({ type: "ct-studio:badge", count: -1 })).toBeNull();
    expect(
      parseCtStudioInboundMessage({ type: "ct-studio:focus-thread", threadId: "   " }),
    ).toBeNull();
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:start-thread",
        requestId: "req-1",
        projectId: "proj-1",
        cwd: "/Users/dev/sample-app",
        worktreePath: "/Users/dev/ct-studio/worktrees/sample-app-DEMO-123",
        branch: "DEMO-123",
        prepareWorktree: {
          baseBranch: "develop",
          branch: "DEMO-123",
          startFromOrigin: true,
        },
        title: "Investigate alert",
        prompt: "Check logs",
        modelSelection: {
          providerId: "antigravity",
          modelSlug: "gemini-4-neon",
          options: [
            { id: "thought_level", value: "high" },
            { id: "fastMode", value: true },
          ],
        },
        interactionMode: "plan",
        focus: false,
      }),
    ).toEqual({
      type: "ct-studio:start-thread",
      requestId: "req-1",
      projectId: "proj-1",
      cwd: "/Users/dev/sample-app",
      worktreePath: "/Users/dev/ct-studio/worktrees/sample-app-DEMO-123",
      branch: "DEMO-123",
      prepareWorktree: {
        baseBranch: "develop",
        branch: "DEMO-123",
        startFromOrigin: true,
      },
      title: "Investigate alert",
      prompt: "Check logs",
      modelSelection: {
        providerId: "antigravity",
        modelSlug: "gemini-4-neon",
        options: [
          { id: "thought_level", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      interactionMode: "plan",
      focus: false,
    });
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:start-thread",
        requestId: "req-2",
        prompt: "   ",
      }),
    ).toBeNull();
    expect(
      parseCtStudioInboundMessage({
        type: "ct-studio:workspace-context",
        context: {
          threadLinks: {
            "thr-1": {
              kind: "ticket",
              ticketKey: "DEMO-100",
              stage: "coding",
              summary: "Checkout enum upgrade",
            },
            "thr-2": {
              kind: "inbox",
              itemId: "item-9",
              title: "Slack thread about timeout",
              source: "Slack",
            },
          },
          watchedInbox: [
            {
              id: "item-9",
              title: "Slack thread about timeout",
              source: "slack",
              sourceLabel: "Slack",
              attention: "action",
              status: "new",
              pinned: true,
              time: "2026-11-23T02:00:00Z",
              threadId: "thr-2",
              environmentId: "env-1",
              threadStatus: "blocked",
            },
          ],
          watchedTasks: [
            {
              key: "DEMO-100",
              summary: "Checkout enum upgrade",
              status: "In Progress",
              statusCategory: "indeterminate",
              assignedToMe: true,
              mentionsMe: false,
              stage: "coding",
              threadId: "thr-1",
              environmentId: "env-1",
              threadStatus: "working",
              activeThreadCount: 1,
            },
          ],
        },
      }),
    ).toMatchObject({
      type: "ct-studio:workspace-context",
      context: {
        threadLinks: {
          "thr-1": { kind: "ticket", ticketKey: "DEMO-100", stage: "coding" },
          "thr-2": { kind: "inbox", itemId: "item-9", source: "Slack" },
        },
      },
    });
    expect(parseCtStudioInboundMessage({ type: "unknown" })).toBeNull();
  });
});

describe("resolveThreadCtStudioLink", () => {
  it("resolves direct links, inherits coordinator links for subagents, and falls back to ticket key extraction", () => {
    const context = {
      threadLinks: {
        "thr-coord": {
          kind: "ticket" as const,
          ticketKey: "DEMO-100",
          stage: "coding",
          summary: "Multi-repo checkout",
        },
        "thr-inbox": {
          kind: "inbox" as const,
          itemId: "item-9",
          title: "Slack incident",
          source: "Slack",
        },
      },
      watchedInbox: [],
      watchedTasks: [
        {
          key: "DEMO-200",
          summary: "Fallback task",
          status: "To Do",
          statusCategory: "new" as const,
          assignedToMe: true,
          mentionsMe: false,
          stage: "design",
        },
      ],
    };

    expect(resolveThreadCtStudioLink({ id: "thr-inbox", title: "Random title" }, context)).toEqual({
      link: context.threadLinks["thr-inbox"],
      inherited: false,
    });
    expect(
      resolveThreadCtStudioLink(
        { id: "thr-child", rootThreadId: "thr-coord", title: "Review #1" },
        context,
      ),
    ).toEqual({
      link: context.threadLinks["thr-coord"],
      inherited: true,
    });
    expect(
      resolveThreadCtStudioLink(
        { id: "thr-untracked", branch: "feat/DEMO-200-design", title: "Draft" },
        context,
      ),
    ).toEqual({
      link: {
        kind: "ticket",
        ticketKey: "DEMO-200",
        stage: "design",
        summary: "Fallback task",
        status: "To Do",
      },
      inherited: false,
    });
  });
});

describe("buildCtStudioHostCatalog", () => {
  it("maps enabled providers, non-legacy models, and option descriptors", () => {
    const providers = [
      {
        instanceId: "antigravity",
        driver: "antigravity",
        enabled: true,
        installed: true,
        status: "ready",
        models: [
          {
            slug: "gemini-4-neon",
            name: "Gemini 4 Neon",
            isCustom: false,
            isDefault: true,
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Thinking",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                },
                {
                  id: "fastMode",
                  label: "Fast Mode",
                  type: "boolean",
                  currentValue: false,
                },
              ],
            },
          },
          {
            slug: "gemini-old",
            name: "Old",
            isCustom: false,
            isLegacy: true,
            capabilities: null,
          },
        ],
      },
      {
        instanceId: "disabled-one",
        driver: "codex",
        enabled: false,
        installed: true,
        status: "disabled",
        models: [],
      },
      {
        instanceId: "replay-dev",
        driver: "replay",
        displayName: "Replay (dev)",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "replay", name: "Replay", isCustom: false, capabilities: null }],
      },
      {
        instanceId: "devReplay",
        driver: "acpRegistry",
        displayName: "Replay (dev)",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "replay", name: "Replay", isCustom: false, capabilities: null }],
      },
    ] as unknown as ReadonlyArray<ServerProvider>;

    const projects = [
      { id: "proj-app", title: "sample-app", workspaceRoot: "/Users/dev/sample-app" },
      { id: "proj-ct", title: "ct-studio", workspaceRoot: "/Users/dev/ct-studio" },
      {
        id: "proj-old",
        title: "archived",
        workspaceRoot: "/Users/dev/archived",
        archivedAt: "2026-01-01T00:00:00Z",
      },
    ] as unknown as ReadonlyArray<EnvironmentProject>;

    expect(buildCtStudioHostCatalog(providers, projects, "dark")).toEqual({
      id: "t3-code",
      name: "T3 Code",
      theme: "dark",
      capabilities: { startThread: true, prepareWorktree: true, sendThread: true, openDiff: true },
      defaultProjectId: "proj-ct",
      projects: [
        { id: "proj-app", title: "sample-app", cwd: "/Users/dev/sample-app" },
        { id: "proj-ct", title: "ct-studio", cwd: "/Users/dev/ct-studio" },
      ],
      providers: [
        {
          id: "antigravity",
          driver: "antigravity",
          name: "Antigravity",
          available: true,
          models: [
            {
              slug: "gemini-4-neon",
              name: "Gemini 4 Neon",
              isDefault: true,
              options: [
                {
                  id: "effort",
                  label: "Thinking",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                  defaultValue: "medium",
                },
                {
                  id: "fastMode",
                  label: "Fast Mode",
                  type: "boolean",
                  defaultValue: false,
                },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe("buildCtStudioHostThreads", () => {
  it("maps active threads, excludes archived/settled threads, preserves lineage, and propagates ticket keys across parent/child trees", () => {
    const threads = [
      {
        id: "thr-1",
        environmentId: "env-1",
        projectId: "proj-ct",
        title: "DEMO-100 · 开发 T1 (team)",
        providerInstanceId: "antigravity",
        modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
        branch: "main",
        worktreePath: null,
        lineage: { rootThreadId: "thr-1", parentThreadId: null, relationshipToParent: null },
        runtime: { status: "running" },
        latestRun: { status: "running" },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        archivedAt: null,
        settledAt: null,
        settledOverride: null,
      },
      {
        id: "thr-child-1",
        environmentId: "env-1",
        projectId: "proj-app",
        title: "Review changes",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        branch: null,
        worktreePath: "/Users/dev/.t3/worktrees/shop/wt-1",
        lineage: {
          rootThreadId: "thr-1",
          parentThreadId: "thr-1",
          relationshipToParent: "subagent",
        },
        runtime: null,
        latestRun: { status: "completed" },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        createdAt: "2026-01-01T00:02:00Z",
        updatedAt: "2026-01-01T00:03:00Z",
        archivedAt: null,
        settledAt: null,
        settledOverride: null,
      },
      {
        id: "thr-2",
        environmentId: "env-1",
        projectId: "proj-1",
        title: "Settled thread",
        providerInstanceId: "codex",
        branch: null,
        runtime: null,
        latestRun: { status: "completed" },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        archivedAt: null,
        settledAt: "2026-01-01T00:00:00Z",
        settledOverride: null,
      },
    ] as unknown as ReadonlyArray<EnvironmentThreadShell>;

    expect(buildCtStudioHostThreads(threads)).toEqual([
      {
        threadId: "thr-1",
        environmentId: "env-1",
        projectId: "proj-ct",
        title: "DEMO-100 · 开发 T1 (team)",
        status: "working",
        providerId: "antigravity",
        model: "gemini-4-neon",
        branch: "main",
        ticketKey: "DEMO-100",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
      },
      {
        threadId: "thr-child-1",
        environmentId: "env-1",
        projectId: "proj-app",
        title: "Review changes",
        status: "done",
        providerId: "codex",
        model: "gpt-5.4",
        worktreePath: "/Users/dev/.t3/worktrees/shop/wt-1",
        ticketKey: "DEMO-100",
        parentThreadId: "thr-1",
        rootThreadId: "thr-1",
        relationshipToParent: "subagent",
        createdAt: "2026-01-01T00:02:00Z",
        updatedAt: "2026-01-01T00:03:00Z",
      },
    ]);
  });
});

describe("pickBestThreadForDiff", () => {
  const mkThread = (overrides: Record<string, unknown>) =>
    ({
      id: "thr-default",
      environmentId: "env-1",
      projectId: "proj-1",
      title: "Thread",
      worktreePath: null,
      lineage: { rootThreadId: "thr-default", parentThreadId: null, relationshipToParent: null },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archivedAt: null,
      ...overrides,
    }) as unknown as EnvironmentThreadShell;

  it("prefers coding child over review child when coordinator runs outside the business worktree", () => {
    const wt = "/Users/dev/.t3/worktrees/shop/DEMO-42";
    const threads = [
      mkThread({
        id: "thr-coord",
        title: "DEMO-42 · 追加开发 (team)",
        worktreePath: null,
        lineage: { rootThreadId: "thr-coord", parentThreadId: null, relationshipToParent: null },
        updatedAt: "2026-01-01T00:05:00Z",
      }),
      mkThread({
        id: "thr-review",
        title: "DEMO-42 · Review #1",
        worktreePath: wt,
        lineage: {
          rootThreadId: "thr-coord",
          parentThreadId: "thr-coord",
          relationshipToParent: "subagent",
        },
        updatedAt: "2026-01-01T00:04:00Z",
      }),
      mkThread({
        id: "thr-code",
        title: "DEMO-42 · Coding",
        worktreePath: wt,
        lineage: {
          rootThreadId: "thr-coord",
          parentThreadId: "thr-coord",
          relationshipToParent: "subagent",
        },
        updatedAt: "2026-01-01T00:03:00Z",
      }),
    ];

    expect(
      pickBestThreadForDiff(threads, { environmentId: "env-1", worktreePath: `${wt}/` })?.id,
    ).toBe("thr-code");
    // Even when called with the Coordinator's threadId, drills into the coding child on that worktree!
    expect(
      pickBestThreadForDiff(threads, {
        environmentId: "env-1",
        threadId: "thr-coord",
        worktreePath: wt,
      })?.id,
    ).toBe("thr-code");
  });

  it("prefers a root thread directly on the worktree over subagents, ignores archived threads, and returns null if none match", () => {
    const wt = "/Users/dev/.t3/worktrees/shop/DEMO-99";
    const threads = [
      mkThread({
        id: "thr-archived",
        title: "Old thread",
        worktreePath: wt,
        archivedAt: "2026-01-01T00:10:00Z",
        updatedAt: "2026-01-01T00:10:00Z",
      }),
      mkThread({
        id: "thr-root",
        title: "DEMO-99 · 追加开发 (team)",
        worktreePath: wt,
        updatedAt: "2026-01-01T00:01:00Z",
      }),
      mkThread({
        id: "thr-child",
        title: "DEMO-99 · Coding",
        worktreePath: wt,
        lineage: {
          rootThreadId: "thr-root",
          parentThreadId: "thr-root",
          relationshipToParent: "subagent",
        },
        updatedAt: "2026-01-01T00:02:00Z",
      }),
    ];

    expect(pickBestThreadForDiff(threads, { environmentId: "env-1", worktreePath: wt })?.id).toBe(
      "thr-root",
    );
    expect(
      pickBestThreadForDiff(threads, {
        environmentId: "env-1",
        worktreePath: "/Users/dev/worktrees/external-wt",
      }),
    ).toBeNull();
  });
});
