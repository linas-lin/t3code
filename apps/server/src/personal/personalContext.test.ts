import { assert, describe, it } from "@effect/vitest";

import {
  DEFAULT_PERSONAL_CONTEXT_MAX_BYTES,
  buildPersonalContextBlock,
  selectActiveWorkingItems,
} from "./personalContext.ts";
import type { WorkingItem } from "./personalTypes.ts";

const makeWorkingItem = (overrides: Partial<WorkingItem> = {}): WorkingItem => ({
  id: "w-1",
  priority: "medium",
  scope: "global",
  reminded: false,
  status: "open",
  expiresAt: null,
  sourceThreadIds: ["t-1"],
  createdAt: "2026-11-26T08:00:00.000Z",
  updatedAt: "2026-11-26T09:00:00.000Z",
  summary: "默认待跟进事项",
  ...overrides,
});

describe("personalContext", () => {
  it("returns empty string when thread is opted out", () => {
    const block = buildPersonalContextBlock({
      input: {
        threadId: "t-optout",
        projectSlug: "t3code",
        nowIso: "2026-11-26T10:00:00.000Z",
      },
      isOptOut: true,
      guardrails: "- 红线 1",
      profile: "- 偏好 1",
      workingItems: [makeWorkingItem({ priority: "high" })],
    });
    assert.strictEqual(block, "");
  });

  it("includes protocol, all 5 native tool names, guardrails, profile, and <=2 prioritized working items", () => {
    const items: ReadonlyArray<WorkingItem> = [
      makeWorkingItem({ id: "w-low", priority: "low", summary: "低优先级任务" }),
      makeWorkingItem({ id: "w-high-1", priority: "high", summary: "高优先级任务一" }),
      makeWorkingItem({
        id: "w-med-proj",
        priority: "medium",
        scope: "t3code",
        summary: "项目相关中优先级任务",
      }),
      makeWorkingItem({
        id: "w-high-reminded",
        priority: "high",
        reminded: true,
        summary: "已提醒不应再注入",
      }),
      makeWorkingItem({
        id: "w-high-done",
        priority: "high",
        status: "done",
        summary: "已完成不应注入",
      }),
      makeWorkingItem({
        id: "w-high-expired",
        priority: "high",
        expiresAt: "2026-11-26T09:59:59.000Z",
        summary: "已过期不应注入",
      }),
    ];

    const selected = selectActiveWorkingItems(items, "t3code", "2026-11-26T10:00:00.000Z");
    assert.deepStrictEqual(
      selected.map((item) => item.id),
      ["w-high-1", "w-med-proj"],
    );

    const block = buildPersonalContextBlock({
      input: {
        threadId: "t-1",
        projectSlug: "t3code",
        projectTitle: "T3 Code",
        nowIso: "2026-11-26T10:00:00.000Z",
      },
      isOptOut: false,
      guardrails: "# Guardrails\n- 严禁未经确认执行 git push",
      profile: "# Profile\n- 回复直接给结论",
      workingItems: items,
    });

    assert.isTrue(block.startsWith("<personal_context>\n"));
    assert.isTrue(block.endsWith("\n</personal_context>"));
    assert.include(block, "P.S.");
    assert.include(block, "personal_memory_search");
    assert.include(block, "personal_memory_note");
    assert.include(block, "personal_working_update");
    assert.include(block, "personal_thread_privacy");
    assert.include(block, "personal_reflect_now");
    assert.include(block, "w-high-1");
    assert.include(block, "w-med-proj");
    assert.notInclude(block, "w-low");
    assert.notInclude(block, "w-high-reminded");
    assert.notInclude(block, "w-high-done");
    assert.notInclude(block, "w-high-expired");
    assert.isAtMost(Buffer.byteLength(block, "utf8"), DEFAULT_PERSONAL_CONTEXT_MAX_BYTES);
  });

  it("enforces strict scope isolation between projects", () => {
    const items: ReadonlyArray<WorkingItem> = [
      makeWorkingItem({
        id: "w-proj-a",
        priority: "high",
        scope: "project-a",
        summary: "仅属于 project-a 的事项",
      }),
      makeWorkingItem({
        id: "w-proj-b",
        priority: "high",
        scope: "project-b",
        summary: "仅属于 project-b 的事项",
      }),
      makeWorkingItem({
        id: "w-global",
        priority: "medium",
        scope: "global",
        summary: "全局可见事项",
      }),
    ];

    const forA = buildPersonalContextBlock({
      input: {
        threadId: "t-a",
        projectSlug: "project-a",
        nowIso: "2026-11-26T10:00:00.000Z",
      },
      isOptOut: false,
      guardrails: "",
      profile: "",
      workingItems: items,
    });
    assert.include(forA, "w-proj-a");
    assert.include(forA, "w-global");
    assert.notInclude(forA, "w-proj-b");

    const withoutProject = buildPersonalContextBlock({
      input: {
        threadId: "t-none",
        projectSlug: null,
        nowIso: "2026-11-26T10:00:00.000Z",
      },
      isOptOut: false,
      guardrails: "",
      profile: "",
      workingItems: items,
    });
    assert.include(withoutProject, "w-global");
    assert.notInclude(withoutProject, "w-proj-a");
    assert.notInclude(withoutProject, "w-proj-b");
  });

  it("strictly enforces the UTF-8 byte ceiling (default 3200B and custom tight budgets)", () => {
    const hugeGuardrails = Array.from(
      { length: 80 },
      (_, idx) => `- 红线规则 #${idx + 1}：严禁在未确认情况下执行外部可见变更或泄露敏感凭据。`,
    ).join("\n");
    const hugeProfile = Array.from(
      { length: 80 },
      (_, idx) => `- 偏好条目 #${idx + 1}：使用中文简洁叙述 🚀，关键专有名词保持英文原词。`,
    ).join("\n");
    const hugeWorking = [
      makeWorkingItem({
        id: "w-long-1",
        priority: "high",
        summary: "跟进超长待办事项 ".repeat(40),
      }),
      makeWorkingItem({
        id: "w-long-2",
        priority: "high",
        summary: "第二条超长待办事项 ".repeat(40),
      }),
    ];

    const defaultBlock = buildPersonalContextBlock({
      input: {
        threadId: "t-huge",
        projectSlug: "t3code",
        nowIso: "2026-11-26T10:00:00.000Z",
      },
      isOptOut: false,
      guardrails: hugeGuardrails,
      profile: hugeProfile,
      workingItems: hugeWorking,
    });
    assert.isAtMost(Buffer.byteLength(defaultBlock, "utf8"), DEFAULT_PERSONAL_CONTEXT_MAX_BYTES);
    assert.isTrue(defaultBlock.startsWith("<personal_context>\n"));
    assert.isTrue(defaultBlock.endsWith("\n</personal_context>"));
    assert.notInclude(defaultBlock, "\uFFFD");

    for (const budget of [1200, 500, 120, 48, 40, 32, 20, 0]) {
      const tightBlock = buildPersonalContextBlock({
        input: {
          threadId: "t-tight",
          projectSlug: "t3code",
          nowIso: "2026-11-26T10:00:00.000Z",
          maxBytes: budget,
        },
        isOptOut: false,
        guardrails: hugeGuardrails,
        profile: hugeProfile,
        workingItems: hugeWorking,
      });
      assert.isAtMost(Buffer.byteLength(tightBlock, "utf8"), budget, `expected <= ${budget} bytes`);
      assert.notInclude(tightBlock, "\uFFFD");
      if (tightBlock.length > 0) {
        assert.isTrue(
          tightBlock.startsWith("<personal_context>\n"),
          `expected opening tag for budget ${budget}`,
        );
        assert.isTrue(
          tightBlock.endsWith("\n</personal_context>"),
          `expected closing tag for budget ${budget}`,
        );
      }
    }
  });

  it("clamps overly long projectTitle (>3000B) so protocol, tools, and memory sections are never crowded out", () => {
    const hugeTitle = "超长项目标题-ProjectTitle-".repeat(180); // > 4000 UTF-8 bytes
    assert.isAbove(Buffer.byteLength(hugeTitle, "utf8"), 3000);

    const block = buildPersonalContextBlock({
      input: {
        threadId: "t-long-title",
        projectSlug: "t3code",
        projectTitle: hugeTitle,
        nowIso: "2026-11-26T10:00:00.000Z",
      },
      isOptOut: false,
      guardrails: "- 严禁未确认执行 force push",
      profile: "- 回复直接给结论",
      workingItems: [makeWorkingItem({ id: "w-1", priority: "high", summary: "检查发布流程" })],
    });

    assert.isTrue(block.startsWith("<personal_context>\n[发言协议]\n"));
    assert.isTrue(block.endsWith("\n</personal_context>"));
    assert.isAtMost(Buffer.byteLength(block, "utf8"), DEFAULT_PERSONAL_CONTEXT_MAX_BYTES);
    assert.include(block, "[发言协议]");
    assert.include(block, "personal_memory_search");
    assert.include(block, "[红线 Guardrails]");
    assert.include(block, "严禁未确认执行 force push");
    assert.include(block, "[待跟进 Working]");
    assert.include(block, "w-1");
    assert.include(block, "[偏好 Profile]");
    assert.include(block, "回复直接给结论");

    const projectMetaLine = block.split("\n").find((line) => line.startsWith("[当前项目] "));
    assert.isDefined(projectMetaLine);
    assert.isAtMost(Buffer.byteLength(projectMetaLine!, "utf8"), 200);
    assert.include(projectMetaLine!, "(t3code)");
  });

  it("returns empty string for tiny maxBytes instead of emitting malformed unclosed XML", () => {
    for (const tinyBudget of [0, 10, 20, 39, 40, 47]) {
      const block = buildPersonalContextBlock({
        input: {
          threadId: "t-tiny",
          projectSlug: "t3code",
          projectTitle: "T3 Code",
          nowIso: "2026-11-26T10:00:00.000Z",
          maxBytes: tinyBudget,
        },
        isOptOut: false,
        guardrails: "- 红线",
        profile: "- 偏好",
        workingItems: [makeWorkingItem({ priority: "high" })],
      });
      assert.strictEqual(block, "", `expected empty string for maxBytes=${tinyBudget}`);
    }

    const minimalValid = buildPersonalContextBlock({
      input: {
        threadId: "t-min-valid",
        projectSlug: "t3code",
        nowIso: "2026-11-26T10:00:00.000Z",
        maxBytes: 48,
      },
      isOptOut: false,
      guardrails: "- 红线",
      profile: "- 偏好",
      workingItems: [],
    });
    assert.isTrue(minimalValid.startsWith("<personal_context>\n"));
    assert.isTrue(minimalValid.endsWith("\n</personal_context>"));
    assert.isAtMost(Buffer.byteLength(minimalValid, "utf8"), 48);
  });

  it("prioritizes Guardrails ahead of Working and Profile under tight budgets", () => {
    const guardrails = "- 必须保留的最高优先级红线规则：绝不自动执行 git push 或删除生产数据。";
    const hugeWorking = [
      makeWorkingItem({
        id: "w-huge-1",
        priority: "high",
        summary: "超长待跟进事项一 ".repeat(60),
      }),
      makeWorkingItem({
        id: "w-huge-2",
        priority: "high",
        summary: "超长待跟进事项二 ".repeat(60),
      }),
    ];
    const hugeProfile = Array.from(
      { length: 30 },
      (_, idx) => `- 偏好条目 #${idx + 1}：输出使用中文并附带文件路径。`,
    ).join("\n");

    const normalBlock = buildPersonalContextBlock({
      input: {
        threadId: "t-priority-order",
        projectSlug: "t3code",
        nowIso: "2026-11-26T10:00:00.000Z",
      },
      isOptOut: false,
      guardrails,
      profile: hugeProfile,
      workingItems: hugeWorking,
    });

    const guardrailsIdx = normalBlock.indexOf("[红线 Guardrails]");
    const workingIdx = normalBlock.indexOf("[待跟进 Working]");
    const profileIdx = normalBlock.indexOf("[偏好 Profile]");
    assert.isAbove(guardrailsIdx, -1);
    assert.isAbove(workingIdx, guardrailsIdx);
    assert.isAbove(profileIdx, workingIdx);
    assert.include(normalBlock, "必须保留的最高优先级红线规则");

    // Under a very tight budget where only one optional section fits after core,
    // Guardrails must survive rather than being crowded out by Working or Profile.
    const coreOnlyBlock = buildPersonalContextBlock({
      input: {
        threadId: "t-priority-tight",
        projectSlug: "t3code",
        nowIso: "2026-11-26T10:00:00.000Z",
      },
      isOptOut: false,
      guardrails: "",
      profile: "",
      workingItems: [],
    });
    const tightBudget = Buffer.byteLength(coreOnlyBlock, "utf8") + 70;
    const tightBlock = buildPersonalContextBlock({
      input: {
        threadId: "t-priority-tight",
        projectSlug: "t3code",
        nowIso: "2026-11-26T10:00:00.000Z",
        maxBytes: tightBudget,
      },
      isOptOut: false,
      guardrails,
      profile: hugeProfile,
      workingItems: hugeWorking,
    });
    assert.isAtMost(Buffer.byteLength(tightBlock, "utf8"), tightBudget);
    assert.isTrue(tightBlock.startsWith("<personal_context>\n"));
    assert.isTrue(tightBlock.endsWith("\n</personal_context>"));
    assert.include(tightBlock, "[红线 Guardrails]");
    assert.notInclude(tightBlock, "[偏好 Profile]");
  });
});
