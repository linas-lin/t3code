import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  TextGenerationError,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type Project,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import type {
  ActiveThreadListEntry,
  ProjectionRecords,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { PersonalMemoryService, layer as personalMemoryLayer } from "./PersonalMemoryService.ts";
import {
  PersonalReflectionService,
  isDailyCompactDue,
  makeLayer as makePersonalReflectionLayer,
} from "./PersonalReflectionService.ts";
import { derivePersonalPaths } from "./personalPaths.ts";
import {
  MAX_REFLECTION_SLICES_CHARS,
  PersonalReflectionError,
  buildDailyCompactPrompt,
  buildIncrementalReflectionPrompt,
  extractNewMessagesForReflection,
  formatMessageForReflection,
  isMalformedReflectionOutput,
  isReflectableThreadMessages,
  parseReflectionOutput,
  renderConversationSlicesBounded,
  type ReflectableMessageLike,
  type ThreadMessageSlice,
} from "./personalReflector.ts";
import { REDACTED_VALUE } from "./personalSanitizer.ts";
import type { ReflectionSnapshot } from "./personalTypes.ts";

const isPersonalReflectionError = Schema.is(PersonalReflectionError);

const makeModelSelection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const makeMessage = (
  overrides: Partial<ReflectableMessageLike> & { readonly id: string },
): ReflectableMessageLike => ({
  role: "user",
  text: "这是一条足够长的测试对话消息内容",
  streaming: false,
  createdAt: "2026-11-26T10:00:00.000Z",
  ...overrides,
});

const makeProjectionMessage = (input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
  readonly streaming?: boolean;
  readonly scheduledTaskId?: string;
  readonly notification?: unknown;
  readonly delegatedCompletion?: unknown;
  readonly idleCompaction?: unknown;
  readonly workflowScript?: boolean;
}): OrchestrationV2ConversationMessage =>
  ({
    id: MessageId.make(input.id),
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.role,
    text: input.text,
    attachments: [],
    streaming: input.streaming ?? false,
    createdAt: DateTime.makeUnsafe(input.createdAt),
    updatedAt: DateTime.makeUnsafe(input.createdAt),
    ...(input.scheduledTaskId !== undefined
      ? { scheduledTaskId: ScheduledTaskId.make(input.scheduledTaskId) }
      : {}),
    ...(input.notification !== undefined ? { notification: input.notification } : {}),
    ...(input.delegatedCompletion !== undefined
      ? { delegatedCompletion: input.delegatedCompletion }
      : {}),
    ...(input.idleCompaction !== undefined ? { idleCompaction: input.idleCompaction } : {}),
    ...(input.workflowScript !== undefined ? { workflowScript: input.workflowScript } : {}),
  }) as unknown as OrchestrationV2ConversationMessage;

interface MockThreadFixture {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly updatedAt: string;
  readonly lineage?: OrchestrationV2AppThread["lineage"];
  readonly delegatedFrom?: OrchestrationV2AppThread["delegatedFrom"];
  readonly workflowRun?: unknown;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly failOnGetRecords?: boolean;
}

const runGitSubjects = Effect.fn("test.personalReflector.runGitSubjects")(function* (cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* spawner
    .spawn(
      ChildProcess.make("git", ["log", "--format=%s"], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .pipe(
      Effect.flatMap((handle) =>
        Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], {
          concurrency: "unbounded",
        }),
      ),
      Effect.scoped,
    );
  assert.strictEqual(result[1], 0);
  return result[0]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
});

const buildHarness = (input: {
  readonly threads: ReadonlyArray<MockThreadFixture>;
  readonly projects?: Readonly<
    Record<string, { readonly title: string; readonly workspaceRoot: string }>
  >;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly textGenerationModelSelection?: ModelSelection;
  readonly onGenerate?: (
    req: TextGeneration.TranscriptionPostProcessingInput,
  ) => Effect.Effect<TextGeneration.TranscriptionPostProcessingResult, TextGenerationError>;
}) => {
  const generateCalls: Array<TextGeneration.TranscriptionPostProcessingInput> = [];
  const getThreadRecordsCalls: Array<string> = [];
  let mutableThreads: ReadonlyArray<MockThreadFixture> = input.threads;

  const setThreads = (next: ReadonlyArray<MockThreadFixture>) => {
    mutableThreads = next;
  };

  const threadManagementMock = {
    listProjectThreads: () =>
      Effect.succeed(
        mutableThreads.map(
          (thread) =>
            ({
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              updatedAt: DateTime.makeUnsafe(thread.updatedAt),
              lineage: thread.lineage ?? {
                rootThreadId: thread.id,
                parentThreadId: null,
                relationshipToParent: null,
              },
              ...(thread.delegatedFrom !== undefined
                ? { delegatedFrom: thread.delegatedFrom }
                : {}),
              settledOverride: null,
              settledAt: null,
              snoozedUntil: null,
            }) as unknown as ActiveThreadListEntry,
        ),
      ),
    getThreadRecords: (threadId: ThreadId) => {
      getThreadRecordsCalls.push(threadId);
      const found = mutableThreads.find((t) => t.id === threadId);
      if (found === undefined || found.failOnGetRecords) {
        return Effect.fail(
          new ThreadManagementService.ThreadManagementProjectionLoadError({
            projectId: ProjectId.make("p-missing"),
            threadId,
            cause: new Error(`simulated load failure for ${threadId}`),
          }),
        );
      }
      return Effect.succeed({
        thread: {
          id: found.id,
          projectId: found.projectId,
          title: found.title,
          updatedAt: DateTime.makeUnsafe(found.updatedAt),
          lineage: found.lineage ?? {
            rootThreadId: found.id,
            parentThreadId: null,
            relationshipToParent: null,
          },
          ...(found.delegatedFrom !== undefined ? { delegatedFrom: found.delegatedFrom } : {}),
          ...(found.workflowRun !== undefined ? { workflowRun: found.workflowRun } : {}),
        } as unknown as OrchestrationV2AppThread,
        messages: found.messages,
      } as unknown as ProjectionRecords<"messages">);
    },
  } as unknown as ThreadManagementService.ThreadManagementServiceShape;

  const projectServiceMock = {
    getById: (projectId: ProjectId) => {
      const found = input.projects?.[projectId];
      if (found === undefined) {
        return Effect.succeedNone;
      }
      return Effect.succeedSome({
        id: projectId,
        title: found.title,
        workspaceRoot: found.workspaceRoot,
      } as unknown as Project);
    },
  } as unknown as ProjectService.ProjectService["Service"];

  const textGenerationMock = {
    generateTranscriptionPostProcessing: (req: TextGeneration.TranscriptionPostProcessingInput) => {
      generateCalls.push(req);
      if (input.onGenerate !== undefined) {
        return input.onGenerate(req);
      }
      return Effect.succeed({ transcription: "" });
    },
  } as unknown as TextGeneration.TextGeneration["Service"];

  const defaultSettingsModel =
    input.textGenerationModelSelection ?? makeModelSelection("codex", "gpt-5.4-mini");

  const serverSettingsMock = {
    getSettings: Effect.succeed({
      enablePersonalAgent: true,
      defaultModelSelection:
        input.defaultModelSelection === undefined ? null : input.defaultModelSelection,
      textGenerationModelSelection: defaultSettingsModel,
    }),
  } as unknown as ServerSettings.ServerSettingsService["Service"];

  const runWithService = <A, E>(
    body: (ctx: {
      readonly reflection: PersonalReflectionService["Service"];
      readonly memory: PersonalMemoryService["Service"];
      readonly baseDir: string;
    }) => Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
    >,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-personal-reflector-" });
      const memoryLayer = personalMemoryLayer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      const reflectionLayer = makePersonalReflectionLayer({ enableScheduler: false }).pipe(
        Layer.provideMerge(memoryLayer),
        Layer.provide(
          Layer.succeed(ThreadManagementService.ThreadManagementService, threadManagementMock),
        ),
        Layer.provide(Layer.succeed(ProjectService.ProjectService, projectServiceMock)),
        Layer.provide(Layer.succeed(TextGeneration.TextGeneration, textGenerationMock)),
        Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, serverSettingsMock)),
      );

      return yield* Effect.gen(function* () {
        const reflection = yield* PersonalReflectionService;
        const memory = yield* PersonalMemoryService;
        return yield* body({ reflection, memory, baseDir });
      }).pipe(Effect.provide(reflectionLayer));
    }).pipe(Effect.provide(NodeServices.layer));

  return {
    generateCalls,
    getThreadRecordsCalls,
    setThreads,
    runWithService,
  };
};

describe("personalReflector pure functions", () => {
  it("isReflectableThreadMessages excludes unlisted lineages, delegated threads, workflowRun, scheduledTaskId, and slack-relay: messages", () => {
    const normalMessages = [
      makeMessage({ id: "msg-1" }),
      makeMessage({ id: "msg-2", role: "assistant" }),
    ];
    const rootId = ThreadId.make("t-root");

    assert.isTrue(isReflectableThreadMessages({}, normalMessages));
    assert.isTrue(
      isReflectableThreadMessages(
        {
          lineage: { rootThreadId: rootId, parentThreadId: null, relationshipToParent: null },
          workflowRun: null,
        },
        normalMessages,
      ),
    );
    assert.isFalse(
      isReflectableThreadMessages(
        {
          lineage: {
            rootThreadId: rootId,
            parentThreadId: rootId,
            relationshipToParent: "subagent",
          },
        },
        normalMessages,
      ),
    );
    assert.isFalse(
      isReflectableThreadMessages(
        {
          lineage: {
            rootThreadId: rootId,
            parentThreadId: rootId,
            relationshipToParent: null,
            sideChat: true,
          },
        },
        normalMessages,
      ),
    );
    assert.isFalse(
      isReflectableThreadMessages(
        {
          lineage: {
            rootThreadId: rootId,
            parentThreadId: rootId,
            relationshipToParent: null,
            workflowStep: true,
          },
        },
        normalMessages,
      ),
    );
    assert.isFalse(
      isReflectableThreadMessages(
        {
          lineage: { rootThreadId: rootId, parentThreadId: null, relationshipToParent: null },
          delegatedFrom: {
            environmentId: "env-1",
            threadId: rootId,
          } as unknown as OrchestrationV2AppThread["delegatedFrom"],
        },
        normalMessages,
      ),
    );
    assert.isFalse(isReflectableThreadMessages({ workflowRun: { runId: "wf-1" } }, normalMessages));
    assert.isFalse(
      isReflectableThreadMessages({}, [
        makeMessage({ id: "msg-1" }),
        makeMessage({ id: "msg-2", scheduledTaskId: "sched-1" }),
      ]),
    );
    assert.isFalse(
      isReflectableThreadMessages({}, [makeMessage({ id: "slack-relay:1700000001.1234" })]),
    );
  });

  it("extractNewMessagesForReflection handles incremental cursors, streaming watermark, rollback reset, lookbackDays sinceIso, slash commands, and short greetings", () => {
    const messages: ReadonlyArray<ReflectableMessageLike> = [
      makeMessage({
        id: "m1",
        role: "user",
        text: "请帮我检查一下项目的 TypeScript 严格模式配置",
        createdAt: "2026-11-20T08:00:00.000Z",
      }),
      makeMessage({
        id: "m2",
        role: "assistant",
        text: "已经检查完 tsconfig.base.json，目前启用了 exactOptionalPropertyTypes。",
        createdAt: "2026-11-20T08:01:00.000Z",
      }),
      makeMessage({
        id: "m3",
        role: "user",
        text: "/compact",
        createdAt: "2026-11-25T10:00:00.000Z",
      }),
      makeMessage({
        id: "m4",
        role: "system",
        text: "System banner",
        createdAt: "2026-11-25T10:01:00.000Z",
      }),
      makeMessage({
        id: "m5",
        role: "user",
        text: "在 Effect v4 里定时任务 fiber 必须注意不要吞掉 interrupt cause",
        createdAt: "2026-11-26T09:00:00.000Z",
      }),
      makeMessage({
        id: "m7",
        role: "user",
        text: "内部通知消息不应被反思",
        notification: { source: "test" },
        createdAt: "2026-11-26T09:01:00.000Z",
      }),
      makeMessage({
        id: "m8",
        role: "user",
        text: "delegated completion message",
        delegatedCompletion: { parentRunId: "r1" },
        createdAt: "2026-11-26T09:01:30.000Z",
      }),
      makeMessage({
        id: "m9",
        role: "user",
        text: "idle compaction trigger",
        idleCompaction: "onReturn",
        createdAt: "2026-11-26T09:02:00.000Z",
      }),
      makeMessage({
        id: "m10",
        role: "user",
        text: "workflow script content",
        workflowScript: true,
        createdAt: "2026-11-26T09:02:30.000Z",
      }),
      makeMessage({
        id: "m11",
        role: "assistant",
        text: "好的，可以用 Cause.hasInterrupts 判断并重新抛出中断。",
        createdAt: "2026-11-26T09:03:00.000Z",
      }),
      makeMessage({
        id: "m12",
        role: "assistant",
        text: "正在流式输出中...",
        streaming: true,
        createdAt: "2026-11-26T09:03:30.000Z",
      }),
      makeMessage({
        id: "m13",
        role: "assistant",
        text: "位于 streaming 水位线之后的任何消息都不应被提前提取",
        createdAt: "2026-11-26T09:04:00.000Z",
      }),
    ];

    // Incremental from cursorLastCount = 2 skips m1/m2 and noise messages, stops before m12 (streaming: true),
    // and preserves originalIndex for each extracted message.
    const incremental = extractNewMessagesForReflection(messages, { cursorLastCount: 2 });
    assert.deepStrictEqual(
      incremental.map((m) => ({ id: m.id, originalIndex: m.originalIndex })),
      [
        { id: "m5", originalIndex: 4 },
        { id: "m11", originalIndex: 9 },
      ],
    );

    // Rollback detection: cursorLastCount > messages.length resets slice start to 0.
    const rolledBack = extractNewMessagesForReflection(messages.slice(0, 2), {
      cursorLastCount: 10,
    });
    assert.deepStrictEqual(
      rolledBack.map((m) => ({ id: m.id, originalIndex: m.originalIndex })),
      [
        { id: "m1", originalIndex: 0 },
        { id: "m2", originalIndex: 1 },
      ],
    );

    // sinceIso filters by timestamp regardless of cursor, still respecting the streaming watermark.
    const lookback = extractNewMessagesForReflection(messages, {
      cursorLastCount: 12,
      sinceIso: "2026-11-26T00:00:00.000Z",
    });
    assert.deepStrictEqual(
      lookback.map((m) => m.id),
      ["m5", "m11"],
    );

    // Short greetings or slash commands only -> no substantive user message -> empty result.
    const trivialOnly = extractNewMessagesForReflection([
      makeMessage({ id: "t1", role: "user", text: "好的" }),
      makeMessage({ id: "t2", role: "user", text: "  /clear " }),
      makeMessage({
        id: "t3",
        role: "assistant",
        text: "这是一段很长的助手回复但没有实质用户问题",
      }),
    ]);
    assert.deepStrictEqual(trivialOnly, []);
  });

  it("formatMessageForReflection sanitizes secrets, folds large code blocks, and enforces per-role length caps", () => {
    const largeCode = `\`\`\`ts\n${"const x = 1;\n".repeat(45)}\`\`\``;
    const shortCode = "```ts\nconst ok = true;\n```";
    const userInput = `请检查 token ghp_1234567890abcdefABCDEF1234567890abcd\n${largeCode}\n${shortCode}\n${"需求细节".repeat(400)}`;
    const formattedUser = formatMessageForReflection(userInput, "user");

    assert.strictEqual(formattedUser.redactedCount, 1);
    assert.include(formattedUser.text, REDACTED_VALUE);
    assert.notInclude(formattedUser.text, "ghp_1234567890abcdefABCDEF1234567890abcd");
    assert.include(formattedUser.text, "[code block omitted]");
    assert.include(formattedUser.text, "const ok = true;");
    assert.isAtMost(formattedUser.text.length, 1200);

    const formattedAssistant = formatMessageForReflection("回复内容".repeat(400), "assistant");
    assert.isAtMost(formattedAssistant.text.length, 800);
  });

  it("buildIncrementalReflectionPrompt bounds conversation slices to ~16,000 chars, tracks inclusion indices, and includes XML protocol", () => {
    const snapshot: ReflectionSnapshot = {
      guardrails: "# Guardrails\n- 禁止对外操作\n",
      profile: "# Profile\n- 偏好简洁中文结论\n",
      workingItems: [],
      lessons: { global: "# Global Lessons\n- 经验 1\n" },
      state: {
        version: 1,
        reflectionModelSelection: null,
        threadCursors: {},
        optOutThreadIds: [],
        lastIncrementalAt: null,
        lastDailyCompactAt: null,
      },
    };

    const slices: Array<ThreadMessageSlice> = Array.from({ length: 20 }, (_, idx) => ({
      threadId: `thread-${idx}`,
      title: `Long Thread ${idx}`,
      projectSlug: "t3code",
      updatedAt: "2026-11-26T10:00:00.000Z",
      totalMessageCount: 4,
      redactedCount: 0,
      messages: [
        {
          role: "user",
          createdAt: "2026-11-26T09:50:00.000Z",
          text: `线程 ${idx} 用户长消息：${"A".repeat(1000)}`,
          redactedCount: 0,
          originalIndex: 0,
        },
        {
          role: "assistant",
          createdAt: "2026-11-26T09:51:00.000Z",
          text: `线程 ${idx} 助手长消息：${"B".repeat(700)}`,
          redactedCount: 0,
          originalIndex: 1,
        },
      ],
    }));

    const promptResult = buildIncrementalReflectionPrompt({
      snapshot,
      slices,
      nowIso: "2026-11-26T10:00:00.000Z",
    });

    const convMatch = /<conversations>\n([\s\S]*?)\n<\/conversations>/.exec(promptResult.prompt);
    assert.isNotNull(convMatch);
    assert.isAtMost((convMatch?.[1] ?? "").length, MAX_REFLECTION_SLICES_CHARS);
    assert.include(promptResult.prompt, '{"transcription":');
    assert.include(promptResult.prompt, "<profile_replace>");
    assert.include(promptResult.prompt, "<working_upsert");
    assert.include(promptResult.prompt, "<working_close");
    assert.isFalse(promptResult.truncatedProfile);
    assert.strictEqual(promptResult.truncatedLessonScopes.size, 0);
    // Earlier threads are fully included; later threads that exceeded 16k are excluded from inclusion maps.
    assert.isTrue(promptResult.fullyIncludedThreadIds.has("thread-0"));
    assert.strictEqual(promptResult.includedEndIndexByThread.get("thread-0"), 2);
    assert.isFalse(promptResult.includedEndIndexByThread.has("thread-19"));
    assert.isFalse(promptResult.fullyIncludedThreadIds.has("thread-19"));

    const compactPromptResult = buildDailyCompactPrompt({
      snapshot,
      nowIso: "2026-11-26T10:00:00.000Z",
    });
    assert.include(compactPromptResult.prompt, "<lesson_replace");
    assert.include(compactPromptResult.prompt, "<working_close");
    assert.isFalse(compactPromptResult.truncatedProfile);
    assert.strictEqual(compactPromptResult.truncatedLessonScopes.size, 0);
  });

  it("parseReflectionOutput parses all tag types and recovers safely from malformed attributes and noise", () => {
    const nowIso = "2026-11-26T10:00:00.000Z";
    const raw = `
      无关前缀文本将被忽略
      <profile_replace>
      # 个人画像与偏好 (Profile)

      - 回答保持精炼，代码标识符保留英文原词。
      </profile_replace>

      <lesson scope="T3 Code / Server">Effect v4 中 Layer.effect 原生支持 Scope，不需要单独调 Layer.scoped。</lesson>
      <lesson scope="global">排查构建超时优先检查并发测试锁争用。</lesson>
      <lesson scope="  ">   </lesson>

      <lesson_replace scope="../weird/Scope">
      # 项目经验：weird-scope

      - 归并后的精炼经验
      </lesson_replace>

      <working_upsert id="optional" priority="HIGH" scope="t3code" expires="2026-12-03" threads="t-1, t-2, t-1">
        跟进 Personal Agent MCP 工具接线
      </working_upsert>
      <working_upsert id="w-existing" priority="invalid-level" scope="" expires="invalid-date" threads="none">
        验证后台反思定时任务
      </working_upsert>
      <working_upsert priority=low scope="global" expires="none">
        长期追踪上游变更
      </working_upsert>
      <working_upsert priority="high">   </working_upsert>

      <working_close id="w-old-1" status="done" />
      <working_close id="w-old-2" status="dismiss" />
      <working_close id="w-old-3" status="bogus"></working_close>
      <working_close status="done" />
    `;

    const parsed = parseReflectionOutput(raw, nowIso);

    assert.isTrue(parsed.hasContentChanges);
    assert.include(parsed.profile ?? "", "代码标识符保留英文原词");
    assert.deepStrictEqual(parsed.lessonsAppend, {
      "t3-code-server": ["Effect v4 中 Layer.effect 原生支持 Scope，不需要单独调 Layer.scoped。"],
      global: ["排查构建超时优先检查并发测试锁争用。"],
    });
    assert.deepStrictEqual(parsed.lessonsReplace, {
      "weird-scope": "# 项目经验：weird-scope\n\n- 归并后的精炼经验\n",
    });

    assert.strictEqual(parsed.workingItemsUpsert?.length, 3);
    assert.deepStrictEqual(parsed.workingItemsUpsert?.[0], {
      priority: "high",
      scope: "t3code",
      expiresAt: "2026-12-03T23:59:59.000Z",
      sourceThreadIds: ["t-1", "t-2"],
      summary: "跟进 Personal Agent MCP 工具接线",
    });
    assert.deepStrictEqual(parsed.workingItemsUpsert?.[1], {
      id: "w-existing",
      priority: "medium",
      scope: "global",
      expiresAt: "2026-12-03T23:59:59.000Z",
      summary: "验证后台反思定时任务",
    });
    assert.deepStrictEqual(parsed.workingItemsUpsert?.[2], {
      priority: "low",
      scope: "global",
      expiresAt: null,
      summary: "长期追踪上游变更",
    });

    assert.deepStrictEqual(parsed.workingClosures, [
      { id: "w-old-1", status: "done" },
      { id: "w-old-2", status: "dismissed" },
      { id: "w-old-3", status: "done" },
    ]);

    // Tolerates double-wrapped JSON and empty/garbage outputs.
    const wrapped = parseReflectionOutput(
      JSON.stringify({ transcription: '<lesson scope="global">JSON 包裹容错生效</lesson>' }),
      nowIso,
    );
    assert.deepStrictEqual(wrapped.lessonsAppend, { global: ["JSON 包裹容错生效"] });

    const empty = parseReflectionOutput("没有任何标签的普通文本", nowIso);
    assert.isFalse(empty.hasContentChanges);
    assert.isUndefined(empty.profile);
    assert.isUndefined(empty.lessonsAppend);
    assert.isUndefined(empty.workingItemsUpsert);
    assert.deepStrictEqual(empty.workingClosures, []);
  });
});

describe("PersonalReflectionService integration", () => {
  it.effect(
    "skips LLM completely (0 calls) when there are no new substantive conversations",
    () => {
      const tTrivial = ThreadId.make("t-trivial");
      const p1 = ProjectId.make("p-1");
      const harness = buildHarness({
        threads: [
          {
            id: tTrivial,
            projectId: p1,
            title: "Short ping",
            updatedAt: "2026-11-26T09:00:00.000Z",
            messages: [
              makeProjectionMessage({
                id: "m-1",
                threadId: tTrivial,
                role: "user",
                text: "嗯",
                createdAt: "2026-11-26T09:00:00.000Z",
              }),
              makeProjectionMessage({
                id: "m-2",
                threadId: tTrivial,
                role: "user",
                text: "/status",
                createdAt: "2026-11-26T09:00:10.000Z",
              }),
            ],
          },
        ],
      });

      return harness.runWithService(({ reflection, memory }) =>
        Effect.gen(function* () {
          const result = yield* reflection.reflectNow();
          assert.isTrue(result.skipped);
          assert.strictEqual(result.reason, "no_new_conversations");
          assert.strictEqual(result.scannedThreads, 1);
          assert.strictEqual(result.reflectedThreads, 0);
          assert.strictEqual(harness.generateCalls.length, 0);

          // Cursor was still recorded so subsequent run skips even getThreadRecords.
          const state = yield* memory.readState();
          assert.strictEqual(state.threadCursors[tTrivial]?.lastMessageCount, 2);

          const second = yield* reflection.reflectNow();
          assert.isTrue(second.skipped);
          assert.strictEqual(second.scannedThreads, 0);
          assert.strictEqual(harness.generateCalls.length, 0);
          assert.strictEqual(harness.getThreadRecordsCalls.length, 1);
        }),
      );
    },
  );

  it.effect(
    "reflects new threads with defaultModelSelection, filters opt-out/non-reflectable threads, writes memory atomically, and skips second run via cursor",
    () => {
      const p1 = ProjectId.make("p-t3");
      const tMain = ThreadId.make("t-main");
      const tOptOut = ThreadId.make("t-opt-out");
      const tWorkflow = ThreadId.make("t-workflow");
      const tBroken = ThreadId.make("t-broken");
      const defaultModel = makeModelSelection("claudeAgent", "claude-sonnet-4-6");

      const harness = buildHarness({
        defaultModelSelection: defaultModel,
        projects: {
          [p1]: { title: "T3 Code", workspaceRoot: "/workspace/t3code" },
        },
        threads: [
          {
            id: tMain,
            projectId: p1,
            title: "Personal Reflector Design",
            updatedAt: "2026-11-26T10:10:00.000Z",
            messages: [
              makeProjectionMessage({
                id: "m-1",
                threadId: tMain,
                role: "user",
                text: "后续实现 Personal Agent 请坚持中文叙述加英文专有名词，不要把 token ghp_1234567890abcdefABCDEF1234567890abcd 写进记忆",
                createdAt: "2026-11-26T10:00:00.000Z",
              }),
              makeProjectionMessage({
                id: "m-2",
                threadId: tMain,
                role: "assistant",
                text: "明白，另外旧任务 w-old-done 已经完成了，接下来需要把 MCP 工具接入 server.ts。",
                createdAt: "2026-11-26T10:05:00.000Z",
              }),
            ],
          },
          {
            id: tOptOut,
            projectId: p1,
            title: "Private Secret Chat",
            updatedAt: "2026-11-26T10:15:00.000Z",
            messages: [
              makeProjectionMessage({
                id: "m-priv",
                threadId: tOptOut,
                role: "user",
                text: "这是私密无痕会话的内容绝对不能进入提示词",
                createdAt: "2026-11-26T10:15:00.000Z",
              }),
            ],
          },
          {
            id: tWorkflow,
            projectId: p1,
            title: "Automated Workflow",
            updatedAt: "2026-11-26T10:12:00.000Z",
            workflowRun: { id: "wf-99" },
            messages: [
              makeProjectionMessage({
                id: "m-wf",
                threadId: tWorkflow,
                role: "user",
                text: "自动工作流执行输出不应被个人反思扫描",
                createdAt: "2026-11-26T10:12:00.000Z",
              }),
            ],
          },
          {
            id: tBroken,
            projectId: p1,
            title: "Broken Thread",
            updatedAt: "2026-11-26T10:11:00.000Z",
            failOnGetRecords: true,
            messages: [],
          },
        ],
        onGenerate: (req) => {
          assert.include(req.prompt, "Personal Reflector Design");
          assert.notInclude(req.prompt, "私密无痕会话");
          assert.notInclude(req.prompt, "自动工作流执行输出");
          assert.notInclude(req.prompt, "ghp_1234567890abcdefABCDEF1234567890abcd");
          return Effect.succeed({
            transcription: `
              <profile_replace>
              # 个人画像与偏好 (Profile)

              - 始终使用中文叙述搭配英文专有名词。
              </profile_replace>
              <lesson scope="t3-code">TextGeneration.generateTranscriptionPostProcessing 需在空临时目录运行。</lesson>
              <working_upsert id="w-mcp-wire" priority="high" scope="t3-code" expires="2026-12-10" threads="t-main">
                将 PersonalReflectionService 接入 personalMcp.ts 与 server.ts
              </working_upsert>
              <working_close id="w-old-done" status="done" />
            `,
          });
        },
      });

      return harness.runWithService(({ reflection, memory, baseDir }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const paths = derivePersonalPaths(baseDir, path);

          yield* memory.setThreadOptOut(tOptOut, true);
          yield* memory.applyReflectionUpdates({
            reason: "seed existing working item",
            workingItemsUpsert: [
              {
                id: "w-old-done",
                priority: "medium",
                scope: "t3-code",
                summary: "完成 Wave 1 存储底座",
              },
            ],
          });

          const beforeCommits = yield* runGitSubjects(paths.personalDir);

          const first = yield* reflection.reflectNow();
          assert.isFalse(first.skipped);
          assert.strictEqual(first.mode, "incremental");
          assert.strictEqual(first.reflectedThreads, 1);
          assert.strictEqual(first.scannedThreads, 2); // tMain + tWorkflow (tOptOut skipped before read, tBroken failed gracefully)
          assert.strictEqual(first.modelUsed, "claudeAgent:claude-sonnet-4-6");
          assert.strictEqual(first.redactedCount, 1);
          assert.strictEqual(harness.generateCalls.length, 1);
          assert.deepStrictEqual(harness.generateCalls[0]?.modelSelection, defaultModel);

          // Single atomic git snapshot created for the reflection update.
          const afterCommits = yield* runGitSubjects(paths.personalDir);
          assert.strictEqual(afterCommits.length, beforeCommits.length + 1);

          const snapshot = yield* memory.readSnapshotForReflection();
          assert.include(snapshot.profile, "始终使用中文叙述搭配英文专有名词");
          assert.include(snapshot.lessons["t3-code"] ?? "", "generateTranscriptionPostProcessing");
          const closedItem = snapshot.workingItems.find((w) => w.id === "w-old-done");
          assert.strictEqual(closedItem?.status, "done");
          assert.strictEqual(closedItem?.summary, "完成 Wave 1 存储底座");
          const newItem = snapshot.workingItems.find((w) => w.id === "w-mcp-wire");
          assert.strictEqual(newItem?.priority, "high");
          assert.deepStrictEqual(newItem?.sourceThreadIds, ["t-main"]);
          assert.strictEqual(snapshot.state.threadCursors[tMain]?.lastMessageCount, 2);
          assert.isNotNull(snapshot.state.lastIncrementalAt);

          // Second run with unchanged threads must skip with 0 additional LLM calls and 0 new reads.
          const callsBeforeSecond = harness.getThreadRecordsCalls.length;
          const second = yield* reflection.reflectNow();
          assert.isTrue(second.skipped);
          assert.strictEqual(second.reason, "no_new_conversations");
          assert.strictEqual(harness.generateCalls.length, 1);
          // Only tBroken was not cursor-marked so it may be retried; tMain & tWorkflow were skipped with zero I/O.
          assert.strictEqual(harness.getThreadRecordsCalls.length, callsBeforeSecond + 1);
        }),
      );
    },
  );

  it.effect("prefers state.reflectionModelSelection over defaultModelSelection", () => {
    const p1 = ProjectId.make("p-1");
    const t1 = ThreadId.make("t-override");
    const defaultModel = makeModelSelection("codex", "gpt-5.4");
    const overrideModel = makeModelSelection("claudeAgent", "claude-haiku-4-5");

    const harness = buildHarness({
      defaultModelSelection: defaultModel,
      threads: [
        {
          id: t1,
          projectId: p1,
          title: "Model Override Check",
          updatedAt: "2026-11-26T10:00:00.000Z",
          messages: [
            makeProjectionMessage({
              id: "m-1",
              threadId: t1,
              role: "user",
              text: "请帮我确认这次 reflection 是否走了自定义模型配置",
              createdAt: "2026-11-26T10:00:00.000Z",
            }),
          ],
        },
      ],
      onGenerate: () =>
        Effect.succeed({
          transcription: '<lesson scope="global">已使用自定义 reflection 模型。</lesson>',
        }),
    });

    return harness.runWithService(({ reflection, memory }) =>
      Effect.gen(function* () {
        yield* memory.updateState((current) => ({
          ...current,
          reflectionModelSelection: overrideModel,
        }));

        const result = yield* reflection.reflectNow();
        assert.isFalse(result.skipped);
        assert.strictEqual(result.modelUsed, "claudeAgent:claude-haiku-4-5");
        assert.deepStrictEqual(harness.generateCalls[0]?.modelSelection, overrideModel);
      }),
    );
  });

  it.effect("lookbackDays rescans already-reflected threads within the lookback window", () => {
    const p1 = ProjectId.make("p-1");
    const t1 = ThreadId.make("t-lookback");
    const fixedNowMs = Date.parse("2026-11-26T12:00:00.000Z");
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(fixedNowMs));
    const recentIso = DateTime.formatIso(DateTime.makeUnsafe(fixedNowMs - 2 * 60 * 60 * 1000));
    const oldIso = DateTime.formatIso(DateTime.makeUnsafe(fixedNowMs - 10 * 24 * 60 * 60 * 1000));

    const harness = buildHarness({
      threads: [
        {
          id: t1,
          projectId: p1,
          title: "Lookback Thread",
          updatedAt: nowIso,
          messages: [
            makeProjectionMessage({
              id: "m-old",
              threadId: t1,
              role: "user",
              text: "这是十天前的历史消息不应进入三天回溯窗口",
              createdAt: oldIso,
            }),
            makeProjectionMessage({
              id: "m-recent",
              threadId: t1,
              role: "user",
              text: "这是两小时前的近期消息应该进入三天回溯窗口",
              createdAt: recentIso,
            }),
          ],
        },
      ],
      onGenerate: (req) => {
        if (harness.generateCalls.length === 2) {
          assert.include(req.prompt, "两小时前的近期消息");
          assert.notInclude(req.prompt, "十天前的历史消息");
        }
        return Effect.succeed({
          transcription: '<lesson scope="global">lookback 模式正常抽取窗口内消息。</lesson>',
        });
      },
    });

    return harness.runWithService(({ reflection }) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedNowMs);

        // First incremental run advances cursor to the end.
        const first = yield* reflection.reflectNow();
        assert.isFalse(first.skipped);
        assert.strictEqual(harness.generateCalls.length, 1);

        // Regular incremental skips.
        const skipped = yield* reflection.reflectNow();
        assert.isTrue(skipped.skipped);
        assert.strictEqual(harness.generateCalls.length, 1);

        // lookbackDays: 3 rescans recent messages even though cursor is up to date.
        const rescanned = yield* reflection.reflectNow({ mode: "incremental", lookbackDays: 3 });
        assert.isFalse(rescanned.skipped);
        assert.strictEqual(rescanned.reflectedThreads, 1);
        assert.strictEqual(harness.generateCalls.length, 2);
      }),
    );
  });

  it.effect(
    "daily_compact skips empty template memory, prunes expired working items, compacts memory, and updates lastDailyCompactAt",
    () => {
      const fixedNowMs = Date.parse("2026-11-26T12:00:00.000Z");
      const harness = buildHarness({
        threads: [],
        onGenerate: () =>
          Effect.succeed({
            transcription: `
              <profile_replace>
              # 个人画像与偏好 (Profile)

              - 精炼后的长期偏好总结。
              </profile_replace>
              <lesson_replace scope="global">
              # 全局经验与教训 (Global Lessons)

              - 合并去重后的全局经验。
              </lesson_replace>
              <working_close id="w-stale" status="dismissed" />
            `,
          }),
      });

      return harness.runWithService(({ reflection, memory }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(fixedNowMs);

          // 1. Fresh default template memory -> skips LLM completely.
          const emptyCompact = yield* reflection.reflectNow({ mode: "daily_compact" });
          assert.isTrue(emptyCompact.skipped);
          assert.strictEqual(emptyCompact.reason, "empty_memory");
          assert.strictEqual(harness.generateCalls.length, 0);

          // 2. Seed substantive memory + one expired open working item + one stale open item.
          yield* memory.applyReflectionUpdates({
            reason: "seed memory for compact",
            profile: "# Profile\n- 重复偏好 A\n- 重复偏好 A\n",
            lessonsAppend: {
              global: ["经验 A", "经验 A 的重复版本"],
            },
            workingItemsUpsert: [
              {
                id: "w-expired",
                priority: "low",
                scope: "global",
                expiresAt: "2020-01-01T00:00:00.000Z",
                summary: "早已过期的事项",
              },
              {
                id: "w-stale",
                priority: "medium",
                scope: "global",
                expiresAt: "2099-01-01T00:00:00.000Z",
                summary: "模型决定关闭的冗余事项",
              },
              {
                id: "w-keep",
                priority: "high",
                scope: "global",
                expiresAt: "2099-01-01T00:00:00.000Z",
                summary: "仍需保留的活跃事项",
              },
            ],
          });

          const compacted = yield* reflection.reflectNow({ mode: "daily_compact" });
          assert.isFalse(compacted.skipped);
          assert.strictEqual(compacted.mode, "daily_compact");
          assert.strictEqual(harness.generateCalls.length, 1);

          const snapshot = yield* memory.readSnapshotForReflection();
          assert.include(snapshot.profile, "精炼后的长期偏好总结");
          assert.include(snapshot.lessons["global"] ?? "", "合并去重后的全局经验");
          assert.strictEqual(
            snapshot.workingItems.find((w) => w.id === "w-expired")?.status,
            "dismissed",
          );
          assert.strictEqual(
            snapshot.workingItems.find((w) => w.id === "w-stale")?.status,
            "dismissed",
          );
          assert.strictEqual(snapshot.workingItems.find((w) => w.id === "w-keep")?.status, "open");
          assert.isNotNull(snapshot.state.lastDailyCompactAt);
        }),
      );
    },
  );

  it.effect(
    "fails gracefully with PersonalReflectionError without polluting state or cursors when TextGeneration fails",
    () => {
      const p1 = ProjectId.make("p-1");
      const t1 = ThreadId.make("t-fail");

      const harness = buildHarness({
        threads: [
          {
            id: t1,
            projectId: p1,
            title: "Failing Reflection Thread",
            updatedAt: "2026-11-26T11:00:00.000Z",
            messages: [
              makeProjectionMessage({
                id: "m-1",
                threadId: t1,
                role: "user",
                text: "这条消息会触发模型调用然后模拟上游 LLM 报错失败",
                createdAt: "2026-11-26T11:00:00.000Z",
              }),
            ],
          },
        ],
        onGenerate: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateTranscriptionPostProcessing",
              detail: "upstream provider rate limited",
            }),
          ),
      });

      return harness.runWithService(({ reflection, memory }) =>
        Effect.gen(function* () {
          const beforeSnapshot = yield* memory.readSnapshotForReflection();
          const exit = yield* Effect.exit(reflection.reflectNow());

          assert.isTrue(Exit.isFailure(exit));
          const failure = yield* Effect.flip(reflection.reflectNow());
          assert.isTrue(isPersonalReflectionError(failure));
          assert.strictEqual(failure.operation, "generateIncrementalReflection");

          // Verify state, cursors, profile, and working items remain completely untouched.
          const afterSnapshot = yield* memory.readSnapshotForReflection();
          assert.deepStrictEqual(afterSnapshot.state, beforeSnapshot.state);
          assert.strictEqual(afterSnapshot.profile, beforeSnapshot.profile);
          assert.deepStrictEqual(afterSnapshot.workingItems, beforeSnapshot.workingItems);
          assert.isUndefined(afterSnapshot.state.threadCursors[t1]);
          assert.isNull(afterSnapshot.state.lastIncrementalAt);
        }),
      );
    },
  );

  it.effect(
    "does not advance cursor past streaming: true watermark and reflects completed assistant reply on next run",
    () => {
      const p1 = ProjectId.make("p-stream");
      const tStream = ThreadId.make("t-streaming");

      const initialMessages: ReadonlyArray<OrchestrationV2ConversationMessage> = [
        makeProjectionMessage({
          id: "m-1",
          threadId: tStream,
          role: "user",
          text: "请帮我定位为什么连接池会在高峰期偶发超时",
          createdAt: "2026-11-26T10:00:00.000Z",
        }),
        makeProjectionMessage({
          id: "m-2",
          threadId: tStream,
          role: "assistant",
          text: "正在分析日志中...",
          streaming: true,
          createdAt: "2026-11-26T10:00:10.000Z",
        }),
      ];

      const completedMessages: ReadonlyArray<OrchestrationV2ConversationMessage> = [
        initialMessages[0]!,
        makeProjectionMessage({
          id: "m-2",
          threadId: tStream,
          role: "assistant",
          text: "根因已定位：pgbouncer transaction pooling 模式下需要关闭 prepared statements。",
          streaming: false,
          createdAt: "2026-11-26T10:00:10.000Z",
        }),
      ];

      const harness = buildHarness({
        threads: [
          {
            id: tStream,
            projectId: p1,
            title: "Streaming Thread",
            updatedAt: "2026-11-26T10:00:10.000Z",
            messages: initialMessages,
          },
        ],
        onGenerate: (req) => {
          if (harness.generateCalls.length === 1) {
            assert.include(req.prompt, "连接池会在高峰期偶发超时");
            assert.notInclude(req.prompt, "正在分析日志中");
            return Effect.succeed({ transcription: "" });
          }
          assert.include(req.prompt, "pgbouncer transaction pooling");
          return Effect.succeed({
            transcription:
              '<lesson scope="global">pgbouncer transaction pooling 需关闭 prepared statements。</lesson>',
          });
        },
      });

      return harness.runWithService(({ reflection, memory }) =>
        Effect.gen(function* () {
          // Run 1: m-2 is still streaming -> only m-1 reflected, cursor stops at safeCount=1 with lastUpdatedAt="" sentinel.
          const first = yield* reflection.reflectNow();
          assert.isFalse(first.skipped);
          assert.strictEqual(harness.generateCalls.length, 1);

          const midState = yield* memory.readState();
          assert.strictEqual(midState.threadCursors[tStream]?.lastMessageCount, 1);
          assert.strictEqual(midState.threadCursors[tStream]?.lastUpdatedAt, "");

          // Streaming finishes (even with the exact same thread updatedAt timestamp!).
          harness.setThreads([
            {
              id: tStream,
              projectId: p1,
              title: "Streaming Thread",
              updatedAt: "2026-11-26T10:00:10.000Z",
              messages: completedMessages,
            },
          ]);

          // Run 2: rescan triggers automatically and captures the completed assistant message m-2.
          const second = yield* reflection.reflectNow();
          assert.isFalse(second.skipped);
          assert.strictEqual(harness.generateCalls.length, 2);

          const finalSnapshot = yield* memory.readSnapshotForReflection();
          assert.include(finalSnapshot.lessons["global"] ?? "", "pgbouncer transaction pooling");
          assert.strictEqual(finalSnapshot.state.threadCursors[tStream]?.lastMessageCount, 2);
          assert.strictEqual(
            finalSnapshot.state.threadCursors[tStream]?.lastUpdatedAt,
            "2026-11-26T10:00:10.000Z",
          );
        }),
      );
    },
  );

  it.effect(
    "resets slice start to 0 when thread rollback shrinks messages.length below existing cursor",
    () => {
      const p1 = ProjectId.make("p-rollback");
      const tRollback = ThreadId.make("t-rollback");

      const harness = buildHarness({
        threads: [
          {
            id: tRollback,
            projectId: p1,
            title: "Rollback Thread",
            updatedAt: "2026-11-26T10:00:00.000Z",
            messages: [
              makeProjectionMessage({
                id: "m-1",
                threadId: tRollback,
                role: "user",
                text: "最初方案准备使用内存队列处理日志",
                createdAt: "2026-11-26T09:50:00.000Z",
              }),
              makeProjectionMessage({
                id: "m-2",
                threadId: tRollback,
                role: "assistant",
                text: "好的，先按内存队列实现。",
                createdAt: "2026-11-26T09:52:00.000Z",
              }),
              makeProjectionMessage({
                id: "m-3",
                threadId: tRollback,
                role: "user",
                text: "再补充一下重试逻辑的超时参数",
                createdAt: "2026-11-26T09:55:00.000Z",
              }),
              makeProjectionMessage({
                id: "m-4",
                threadId: tRollback,
                role: "assistant",
                text: "已补充指数退避重试。",
                createdAt: "2026-11-26T10:00:00.000Z",
              }),
            ],
          },
        ],
        onGenerate: (req) => {
          if (harness.generateCalls.length === 2) {
            assert.include(req.prompt, "回滚后改为基于 SQLite WAL 持久化队列");
            return Effect.succeed({
              transcription: '<lesson scope="global">日志缓冲改用 SQLite WAL 持久化队列。</lesson>',
            });
          }
          return Effect.succeed({ transcription: "" });
        },
      });

      return harness.runWithService(({ reflection, memory }) =>
        Effect.gen(function* () {
          // Run 1 advances cursor to 4.
          const first = yield* reflection.reflectNow();
          assert.isFalse(first.skipped);
          assert.strictEqual(
            (yield* memory.readState()).threadCursors[tRollback]?.lastMessageCount,
            4,
          );

          // Simulate thread rollback: history shortened to 2 messages with new branch content.
          harness.setThreads([
            {
              id: tRollback,
              projectId: p1,
              title: "Rollback Thread",
              updatedAt: "2026-11-26T10:10:00.000Z",
              messages: [
                makeProjectionMessage({
                  id: "m-1-rb",
                  threadId: tRollback,
                  role: "user",
                  text: "回滚后改为基于 SQLite WAL 持久化队列避免进程重启丢消息",
                  createdAt: "2026-11-26T10:08:00.000Z",
                }),
                makeProjectionMessage({
                  id: "m-2-rb",
                  threadId: tRollback,
                  role: "assistant",
                  text: "收到，采用 SQLite WAL 更稳妥。",
                  createdAt: "2026-11-26T10:10:00.000Z",
                }),
              ],
            },
          ]);

          const second = yield* reflection.reflectNow();
          assert.isFalse(second.skipped);
          assert.strictEqual(harness.generateCalls.length, 2);

          const snapshot = yield* memory.readSnapshotForReflection();
          assert.include(snapshot.lessons["global"] ?? "", "SQLite WAL 持久化队列");
          assert.strictEqual(snapshot.state.threadCursors[tRollback]?.lastMessageCount, 2);
          assert.strictEqual(
            snapshot.state.threadCursors[tRollback]?.lastUpdatedAt,
            "2026-11-26T10:10:00.000Z",
          );
        }),
      );
    },
  );

  it.effect(
    "respects 16,000-char prompt budget by advancing partially included threads only to includedEndIndex and leaving excluded threads untouched",
    () => {
      const p1 = ProjectId.make("p-budget");
      // Build 12 threads, each with 3 messages (~2,500 chars/thread => ~30,000 chars total > 16,000 cap).
      const threads: Array<MockThreadFixture> = Array.from({ length: 12 }, (_, idx) => {
        const id = ThreadId.make(`t-cap-${String(idx).padStart(2, "0")}`);
        // Newer threads sorted first: t-cap-00 is newest, t-cap-11 is oldest.
        const minute = String(59 - idx).padStart(2, "0");
        const ts = `2026-11-26T10:${minute}:00.000Z`;
        return {
          id,
          projectId: p1,
          title: `Cap Thread ${idx}`,
          updatedAt: ts,
          messages: [
            makeProjectionMessage({
              id: `m-${idx}-0`,
              threadId: id,
              role: "user",
              text: `THREAD_${idx}_MSG_0:${"U".repeat(950)}`,
              createdAt: ts,
            }),
            makeProjectionMessage({
              id: `m-${idx}-1`,
              threadId: id,
              role: "assistant",
              text: `THREAD_${idx}_MSG_1:${"A".repeat(720)}`,
              createdAt: ts,
            }),
            makeProjectionMessage({
              id: `m-${idx}-2`,
              threadId: id,
              role: "user",
              text: `THREAD_${idx}_MSG_2:${"V".repeat(950)}`,
              createdAt: ts,
            }),
          ],
        };
      });

      const seenPrompts: Array<string> = [];
      const harness = buildHarness({
        threads,
        onGenerate: (req) => {
          seenPrompts.push(req.prompt);
          return Effect.succeed({ transcription: "" });
        },
      });

      return harness.runWithService(({ reflection, memory }) =>
        Effect.gen(function* () {
          // Run 1: hits 16k budget.
          const first = yield* reflection.reflectNow();
          assert.isFalse(first.skipped);
          assert.isBelow(first.reflectedThreads, 12);

          const stateAfterFirst = yield* memory.readState();
          // Thread 0 (newest) must be fully included with cursor=3 and full updatedAt.
          const t0 = ThreadId.make("t-cap-00");
          assert.strictEqual(stateAfterFirst.threadCursors[t0]?.lastMessageCount, 3);
          assert.strictEqual(
            stateAfterFirst.threadCursors[t0]?.lastUpdatedAt,
            threads[0]!.updatedAt,
          );

          // Last thread (t-cap-11) did not fit in 16k -> cursor MUST NOT be created/advanced.
          const t11 = ThreadId.make("t-cap-11");
          assert.isUndefined(stateAfterFirst.threadCursors[t11]);

          // Check if there is a partially included boundary thread: its cursor must be < 3 and lastUpdatedAt === "".
          const partialEntries = Object.entries(stateAfterFirst.threadCursors).filter(
            ([, cursor]) => cursor.lastMessageCount > 0 && cursor.lastMessageCount < 3,
          );
          for (const [partialId, cursor] of partialEntries) {
            assert.strictEqual(cursor.lastUpdatedAt, "");
            // Verify the message right after cursor was NOT in run 1 prompt.
            const idxNum = Number(partialId.replace("t-cap-", ""));
            assert.notInclude(
              seenPrompts[0] ?? "",
              `THREAD_${idxNum}_MSG_${cursor.lastMessageCount}:`,
            );
          }

          // Subsequent runs continue draining remaining messages and excluded threads without losing a single message.
          const second = yield* reflection.reflectNow();
          assert.isFalse(second.skipped);
          const third = yield* reflection.reflectNow();
          if (!third.skipped) {
            const fourth = yield* reflection.reflectNow();
            assert.isTrue(fourth.skipped);
          }

          const finalState = yield* memory.readState();
          for (const thread of threads) {
            assert.strictEqual(finalState.threadCursors[thread.id]?.lastMessageCount, 3);
            assert.strictEqual(
              finalState.threadCursors[thread.id]?.lastUpdatedAt,
              thread.updatedAt,
            );
          }

          // Every single message across all 12 threads appeared in at least one reflection prompt.
          const allPrompts = seenPrompts.join("\n");
          for (let idx = 0; idx < 12; idx += 1) {
            assert.include(allPrompts, `THREAD_${idx}_MSG_0:`);
            assert.include(allPrompts, `THREAD_${idx}_MSG_1:`);
            assert.include(allPrompts, `THREAD_${idx}_MSG_2:`);
          }
        }),
      );
    },
  );

  it.effect(
    "sanitizes secrets in slice.title, projectTitle, manually edited profile.md, and final prompt before calling LLM",
    () => {
      const p1 = ProjectId.make("p-sec");
      const tSec = ThreadId.make("t-sec");
      const titleToken = "ghp_111122223333444455556666777788889999";
      const profileSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
      const projectSecret = "AKIAIOSFODNN7EXAMPLE";

      const harness = buildHarness({
        projects: {
          [p1]: {
            title: `SecretProj ${projectSecret}`,
            workspaceRoot: "/workspace/secret-proj",
          },
        },
        threads: [
          {
            id: tSec,
            projectId: p1,
            title: `Debug auth with ${titleToken}`,
            updatedAt: "2026-11-26T10:00:00.000Z",
            messages: [
              makeProjectionMessage({
                id: "m-1",
                threadId: tSec,
                role: "user",
                text: "请帮我总结一下今天的鉴权排查经验以便沉淀",
                createdAt: "2026-11-26T10:00:00.000Z",
              }),
            ],
          },
        ],
        onGenerate: (req) => {
          assert.notInclude(req.prompt, titleToken);
          assert.notInclude(req.prompt, profileSecret);
          assert.notInclude(req.prompt, projectSecret);
          assert.include(req.prompt, REDACTED_VALUE);
          return Effect.succeed({ transcription: "" });
        },
      });

      return harness.runWithService(({ reflection, memory, baseDir }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const paths = derivePersonalPaths(baseDir, path);

          yield* memory.readState();
          // Simulate user manually pasting an OpenAI key directly into profile.md on disk.
          yield* fs.writeFileString(
            paths.profilePath,
            `# Profile\n- 手动误粘贴的 key: ${profileSecret}\n`,
          );

          const result = yield* reflection.reflectNow();
          assert.isFalse(result.skipped);
          assert.strictEqual(harness.generateCalls.length, 1);
          assert.isAtLeast(result.redactedCount, 3);
        }),
      );
    },
  );

  it.effect(
    "hard-rejects profile_replace and lesson_replace when the corresponding file was truncated in the prompt",
    () => {
      const p1 = ProjectId.make("p-trunc");
      const tTrunc = ThreadId.make("t-trunc");
      const longProfileTail = "PROFILE_TAIL_SENTINEL_MUST_SURVIVE";
      const longLessonTail = "LESSON_TAIL_SENTINEL_MUST_SURVIVE";

      const harness = buildHarness({
        threads: [
          {
            id: tTrunc,
            projectId: p1,
            title: "Truncation Safety Check",
            updatedAt: "2026-11-26T10:00:00.000Z",
            messages: [
              makeProjectionMessage({
                id: "m-1",
                threadId: tTrunc,
                role: "user",
                text: "请整理一下全局经验与个人画像，不要丢失已有条目",
                createdAt: "2026-11-26T10:00:00.000Z",
              }),
            ],
          },
        ],
        onGenerate: () =>
          Effect.succeed({
            transcription: `
              <profile_replace>
              # Profile
              - 被截断后模型只看到了前半段生成的覆写内容
              </profile_replace>
              <lesson_replace scope="global">
              # Global Lessons
              - 被截断后模型生成的全量覆盖内容
              </lesson_replace>
              <lesson_replace scope="small-repo">
              # 项目经验：small-repo
              - 未截断的小文件允许正常归并覆盖
              </lesson_replace>
              <lesson scope="global">增量 append 不受截断限制，应正常追加。</lesson>
            `,
          }),
      });

      return harness.runWithService(({ reflection, memory, baseDir }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const paths = derivePersonalPaths(baseDir, path);

          yield* memory.readState();
          // Seed oversized profile (> 3000 chars for incremental, > 6000 chars for daily_compact)
          // and oversized global lesson (> 3000 chars) + small lesson (< 500 chars).
          const hugeProfile = `# Profile\n${"- 长期偏好条目示例内容\n".repeat(600)}- ${longProfileTail}\n`;
          const hugeGlobalLesson = `# Global Lessons\n${"- 全局踩坑经验详细记录\n".repeat(250)}- ${longLessonTail}\n`;
          yield* fs.writeFileString(paths.profilePath, hugeProfile);
          yield* fs.writeFileString(path.join(paths.lessonsDir, "global.md"), hugeGlobalLesson);
          yield* memory.applyReflectionUpdates({
            reason: "seed small-repo lesson",
            lessonsReplace: {
              "small-repo": "# 项目经验：small-repo\n- 旧条目\n",
            },
          });

          // Test incremental mode truncation rejection.
          const incResult = yield* reflection.reflectNow({ mode: "incremental" });
          assert.isFalse(incResult.skipped);

          const afterInc = yield* memory.readSnapshotForReflection();
          assert.include(afterInc.profile, longProfileTail);
          assert.notInclude(afterInc.profile, "只看到了前半段");
          assert.include(afterInc.lessons["global"] ?? "", longLessonTail);
          assert.notInclude(afterInc.lessons["global"] ?? "", "全量覆盖内容");
          // Incremental append to global lesson & replace on non-truncated small-repo must still apply!
          assert.include(afterInc.lessons["global"] ?? "", "增量 append 不受截断限制");
          assert.include(afterInc.lessons["small-repo"] ?? "", "未截断的小文件允许正常归并覆盖");

          // Test daily_compact mode truncation rejection as well (> 6000 chars profile, > 3000 chars global lesson).
          const compactResult = yield* reflection.reflectNow({ mode: "daily_compact" });
          assert.isFalse(compactResult.skipped);

          const afterCompact = yield* memory.readSnapshotForReflection();
          assert.include(afterCompact.profile, longProfileTail);
          assert.notInclude(afterCompact.profile, "只看到了前半段");
          assert.include(afterCompact.lessons["global"] ?? "", longLessonTail);
          assert.notInclude(afterCompact.lessons["global"] ?? "", "全量覆盖内容");
        }),
      );
    },
  );

  it.effect(
    "does not advance cursor when LLM returns malformed/unclosed reflection XML tags",
    () => {
      const p1 = ProjectId.make("p-malformed");
      const tBad = ThreadId.make("t-malformed");

      const malformedOutput = '<lesson scope="global">这条反思结果因 max_tokens 被截断没有闭合标签';
      assert.isTrue(
        isMalformedReflectionOutput(
          malformedOutput,
          parseReflectionOutput(malformedOutput, "2026-11-26T10:00:00.000Z"),
        ),
      );
      assert.isFalse(
        isMalformedReflectionOutput(
          "无需更新",
          parseReflectionOutput("无需更新", "2026-11-26T10:00:00.000Z"),
        ),
      );

      const harness = buildHarness({
        threads: [
          {
            id: tBad,
            projectId: p1,
            title: "Malformed Output Thread",
            updatedAt: "2026-11-26T10:00:00.000Z",
            messages: [
              makeProjectionMessage({
                id: "m-1",
                threadId: tBad,
                role: "user",
                text: "这是一条包含重要架构决策的对话消息不能被损坏输出静默吞掉",
                createdAt: "2026-11-26T10:00:00.000Z",
              }),
            ],
          },
        ],
        onGenerate: () => Effect.succeed({ transcription: malformedOutput }),
      });

      return harness.runWithService(({ reflection, memory }) =>
        Effect.gen(function* () {
          const result = yield* reflection.reflectNow();
          assert.isTrue(result.skipped);
          assert.strictEqual(result.reason, "malformed_reflection_output");
          assert.strictEqual(result.reflectedThreads, 0);
          assert.deepStrictEqual(result.updatedFiles, []);

          // Cursor and lastIncrementalAt MUST NOT advance.
          const state = yield* memory.readState();
          assert.isUndefined(state.threadCursors[tBad]);
          assert.isNull(state.lastIncrementalAt);
        }),
      );
    },
  );

  it.effect(
    "end-to-end reflection preserves concurrent working/profile edits and aborts on mid-flight TOCTOU opt-out",
    () => {
      const p1 = ProjectId.make("p-race");
      const tRace = ThreadId.make("t-race");
      const tOptRace = ThreadId.make("t-opt-race");

      let activeMemory: PersonalMemoryService["Service"] | undefined;
      let phase: "concurrent_edit" | "toctou_optout" = "concurrent_edit";

      const harness = buildHarness({
        threads: [
          {
            id: tRace,
            projectId: p1,
            title: "Concurrent Edit Thread",
            updatedAt: "2026-11-26T10:00:00.000Z",
            messages: [
              makeProjectionMessage({
                id: "m-1",
                threadId: tRace,
                role: "user",
                text: "任务 w-old 已经完成，另外请更新一下我的工作流偏好",
                createdAt: "2026-11-26T10:00:00.000Z",
              }),
            ],
          },
        ],
        onGenerate: () =>
          Effect.gen(function* () {
            if (phase === "concurrent_edit" && activeMemory !== undefined) {
              // Mid-flight edits while LLM is running!
              yield* activeMemory.addNote({
                target: "working",
                scope: "global",
                priority: "high",
                content: "反思期间主会话并发新增的事项",
              });
              yield* activeMemory.addNote({
                target: "profile",
                content: "反思期间主会话并发写入的偏好",
              });
              return {
                transcription: `
                  <profile_replace>
                  # Profile
                  - 旧快照覆盖文本（应被哈希校验拒绝）
                  </profile_replace>
                  <working_close id="w-old" status="done" />
                  <lesson scope="global">并发场景下 append 仍可安全落盘。</lesson>
                `,
              };
            }
            if (phase === "toctou_optout" && activeMemory !== undefined) {
              // User toggles thread incognito mid-flight while LLM is running!
              yield* activeMemory.setThreadOptOut(tOptRace, true);
              return {
                transcription: '<lesson scope="global">来自刚开启无痕会话的泄露内容</lesson>',
              };
            }
            return { transcription: "" };
          }).pipe(Effect.orDie),
      });

      return harness.runWithService(({ reflection, memory }) =>
        Effect.gen(function* () {
          activeMemory = memory;
          yield* memory.applyReflectionUpdates({
            reason: "seed w-old",
            workingItemsUpsert: [
              {
                id: "w-old",
                priority: "medium",
                scope: "global",
                summary: "等待关闭的旧事项",
              },
            ],
          });

          // Phase 1: concurrent working + profile edit during reflection.
          phase = "concurrent_edit";
          const res1 = yield* reflection.reflectNow();
          assert.isFalse(res1.skipped);

          const snap1 = yield* memory.readSnapshotForReflection();
          assert.include(snap1.profile, "反思期间主会话并发写入的偏好");
          assert.notInclude(snap1.profile, "旧快照覆盖文本");
          assert.include(snap1.lessons["global"] ?? "", "并发场景下 append 仍可安全落盘");
          assert.isTrue(
            snap1.workingItems.some((item) =>
              item.summary.includes("反思期间主会话并发新增的事项"),
            ),
          );
          assert.strictEqual(
            snap1.workingItems.find((item) => item.id === "w-old")?.status,
            "done",
          );

          // Phase 2: TOCTOU opt-out mid-flight aborts persistence completely.
          phase = "toctou_optout";
          harness.setThreads([
            {
              id: tOptRace,
              projectId: p1,
              title: "About To Go Private",
              updatedAt: "2026-11-26T11:00:00.000Z",
              messages: [
                makeProjectionMessage({
                  id: "m-priv-1",
                  threadId: tOptRace,
                  role: "user",
                  text: "用户在反思中途把这个线程切成了无痕隐私模式",
                  createdAt: "2026-11-26T11:00:00.000Z",
                }),
              ],
            },
          ]);

          const res2 = yield* reflection.reflectNow();
          assert.deepStrictEqual(res2.updatedFiles, []);
          const snap2 = yield* memory.readSnapshotForReflection();
          assert.notInclude(snap2.lessons["global"] ?? "", "泄露内容");
          assert.isUndefined(snap2.state.threadCursors[tOptRace]);
        }),
      );
    },
  );

  it("isDailyCompactDue triggers for expired open items and closed working items older than 14 days, and renderConversationSlicesBounded handles partial/excluded threads cleanly", () => {
    const nowIso = "2026-11-26T12:00:00.000Z";
    const nowMs = Date.parse(nowIso);

    const baseSnapshot: ReflectionSnapshot = {
      guardrails: "",
      profile: "",
      lessons: {},
      workingItems: [
        {
          id: "w-old-done",
          priority: "low",
          scope: "global",
          reminded: true,
          status: "done",
          expiresAt: null,
          sourceThreadIds: [],
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-05T00:00:00.000Z",
          summary: "超过 14 天的已完成事项",
        },
      ],
      state: {
        version: 1,
        reflectionModelSelection: null,
        threadCursors: {},
        optOutThreadIds: [],
        lastIncrementalAt: null,
        lastDailyCompactAt: null,
      },
    };
    assert.isTrue(isDailyCompactDue(baseSnapshot, nowMs, nowIso, 24 * 60 * 60 * 1000));

    // Recent closed item (< 14 days) with empty template memory should NOT trigger daily compact.
    const recentClosedSnapshot: ReflectionSnapshot = {
      ...baseSnapshot,
      workingItems: [
        {
          ...baseSnapshot.workingItems[0]!,
          updatedAt: "2026-11-25T00:00:00.000Z",
        },
      ],
    };
    assert.isFalse(isDailyCompactDue(recentClosedSnapshot, nowMs, nowIso, 24 * 60 * 60 * 1000));

    // Direct unit check on renderConversationSlicesBounded partial boundary.
    const bounded = renderConversationSlicesBounded(
      [
        {
          threadId: "t-a",
          title: "Thread A",
          projectSlug: "t3code",
          updatedAt: nowIso,
          totalMessageCount: 5,
          redactedCount: 0,
          messages: [
            {
              role: "user",
              createdAt: nowIso,
              text: "第一条完整纳入的消息",
              redactedCount: 0,
              originalIndex: 2,
            },
            {
              role: "assistant",
              createdAt: nowIso,
              text: "第二条超过剩余预算将被排除：" + "X".repeat(300),
              redactedCount: 0,
              originalIndex: 4,
            },
          ],
        },
        {
          threadId: "t-b",
          title: "Thread B",
          projectSlug: "t3code",
          updatedAt: nowIso,
          totalMessageCount: 1,
          redactedCount: 0,
          messages: [
            {
              role: "user",
              createdAt: nowIso,
              text: "第二个线程完全进不去",
              redactedCount: 0,
              originalIndex: 0,
            },
          ],
        },
      ],
      220,
    );
    assert.strictEqual(bounded.includedEndIndexByThread.get("t-a"), 3);
    assert.isFalse(bounded.fullyIncludedThreadIds.has("t-a"));
    assert.isFalse(bounded.includedEndIndexByThread.has("t-b"));
  });
});
