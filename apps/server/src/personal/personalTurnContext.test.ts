import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ContextHandoffId,
  ContextTransferId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { isSlashCommandMessage } from "../orchestration-v2/ContextHandoffDelivery.ts";
import { ProjectOperationError } from "../project/ProjectService.ts";
import type { PersonalMemoryServiceShape } from "./PersonalMemoryService.ts";
import {
  hasDeliveredPromptOnNativeThread,
  isEligiblePersonalContextTurn,
  resolveTurnPersonalContext,
  type HasDeliveredPromptOnNativeThreadInput,
  type PersonalContextTurnEligibilityInput,
  type ResolveTurnPersonalContextInput,
} from "./personalTurnContext.ts";
import { PersonalStoreError, type PersonalContextBuildInput } from "./personalTypes.ts";

const testPathService = {
  basename: (filePath: string): string =>
    filePath
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .at(-1) ?? "",
};

const THREAD_ID = ThreadId.make("thread-personal-1");
const PROJECT_ID = ProjectId.make("project-alpha-01");
const RUN_1 = RunId.make("run-1");
const RUN_2 = RunId.make("run-2");
const RUN_3 = RunId.make("run-3");
const MSG_1 = MessageId.make("msg-1");
const MSG_2 = MessageId.make("msg-2");
const MSG_3 = MessageId.make("msg-3");
const NOW_ISO = "2026-11-26T12:00:00.000Z";

const baseThread = (
  overrides: Partial<ResolveTurnPersonalContextInput["projection"]["thread"]> = {},
): ResolveTurnPersonalContextInput["projection"]["thread"] => ({
  id: THREAD_ID,
  projectId: PROJECT_ID,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: THREAD_ID,
  },
  delegatedFrom: undefined,
  workflowRun: undefined,
  ...overrides,
});

const baseMessage = (
  overrides: Partial<ResolveTurnPersonalContextInput["providerMessage"]> = {},
): ResolveTurnPersonalContextInput["providerMessage"] => ({
  id: MSG_1,
  role: "user",
  text: "请帮我排查这个问题",
  attachments: [],
  createdBy: "user",
  scheduledTaskId: undefined,
  senderThreadId: undefined,
  linkedSender: undefined,
  notification: undefined,
  delegatedCompletion: undefined,
  idleCompaction: undefined,
  workflowScript: undefined,
  ...overrides,
});

const makeEligibilityInput = (
  overrides: Partial<PersonalContextTurnEligibilityInput> = {},
): PersonalContextTurnEligibilityInput => ({
  thread: baseThread(),
  providerMessage: baseMessage(),
  slashCommand: false,
  compact: false,
  manualResume: false,
  unsentResumeMessage: undefined,
  ...overrides,
});

const makeMemoryStub = (
  buildTurnContext: (input: PersonalContextBuildInput) => Effect.Effect<string>,
): PersonalMemoryServiceShape => ({
  buildTurnContext,
  searchMemory: () => Effect.die("unexpected searchMemory"),
  addNote: () => Effect.die("unexpected addNote"),
  updateWorkingItem: () => Effect.die("unexpected updateWorkingItem"),
  setThreadOptOut: () => Effect.die("unexpected setThreadOptOut"),
  isThreadOptOut: () => Effect.die("unexpected isThreadOptOut"),
  readState: () => Effect.die("unexpected readState"),
  updateState: () => Effect.die("unexpected updateState"),
  readSnapshotForReflection: () => Effect.die("unexpected readSnapshotForReflection"),
  applyReflectionUpdates: () => Effect.die("unexpected applyReflectionUpdates"),
});

const makeResolveInput = (
  overrides: Partial<ResolveTurnPersonalContextInput> = {},
): {
  readonly input: ResolveTurnPersonalContextInput;
  readonly getByIdCalls: Array<{
    readonly projectId: ProjectId;
    readonly includeDeleted: boolean | undefined;
  }>;
  readonly buildCalls: Array<PersonalContextBuildInput>;
} => {
  const getByIdCalls: Array<{
    readonly projectId: ProjectId;
    readonly includeDeleted: boolean | undefined;
  }> = [];
  const buildCalls: Array<PersonalContextBuildInput> = [];

  const defaultMessage = baseMessage();
  const input: ResolveTurnPersonalContextInput = {
    personalMemory: Option.some(
      makeMemoryStub((buildInput) =>
        Effect.sync(() => {
          buildCalls.push(buildInput);
          return `<personal_context>\n[当前项目] ${buildInput.projectTitle ?? buildInput.projectSlug ?? ""}\n</personal_context>`;
        }),
      ),
    ),
    projects: {
      getById: (projectId, options) =>
        Effect.sync(() => {
          getByIdCalls.push({ projectId, includeDeleted: options?.includeDeleted });
          return Option.some({
            title: "T3 Code",
            workspaceRoot: "/Users/dev/t3code",
          });
        }),
    },
    pathService: testPathService,
    nowIso: NOW_ISO,
    projection: {
      thread: baseThread(),
      runs: [{ id: RUN_1, ordinal: 1, userMessageId: defaultMessage.id }],
      messages: [defaultMessage],
    },
    acceptedAttempts: [],
    loadedNativeThreadId: "native-1",
    sameNativeThread: false,
    currentRunOrdinal: 1,
    providerMessage: defaultMessage,
    slashCommand: false,
    compact: false,
    manualResume: false,
    unsentResumeMessage: undefined,
    importedNativeSession: false,
    nativeForkTransfer: undefined,
    portableForkFallback: undefined,
    isSlashCommandMessage,
    ...overrides,
  };

  return { input, getByIdCalls, buildCalls };
};

describe("personalTurnContext", () => {
  describe("isEligiblePersonalContextTurn", () => {
    it("allows a normal top-level user turn", () => {
      assert.isTrue(isEligiblePersonalContextTurn(makeEligibilityInput()));
    });

    it("allows manualResume when unsentResumeMessage is present", () => {
      assert.isTrue(
        isEligiblePersonalContextTurn(
          makeEligibilityInput({
            manualResume: true,
            unsentResumeMessage: baseMessage(),
          }),
        ),
      );
    });

    it("excludes every non-user / non-top-level / control / relay turn type", () => {
      const excludedCases: ReadonlyArray<{
        readonly name: string;
        readonly input: PersonalContextTurnEligibilityInput;
      }> = [
        {
          name: "subagent lineage",
          input: makeEligibilityInput({
            thread: baseThread({
              lineage: {
                parentThreadId: ThreadId.make("parent-1"),
                relationshipToParent: "subagent",
                rootThreadId: ThreadId.make("parent-1"),
              },
            }),
          }),
        },
        {
          name: "sideChat lineage",
          input: makeEligibilityInput({
            thread: baseThread({
              lineage: {
                parentThreadId: ThreadId.make("parent-1"),
                relationshipToParent: "fork",
                rootThreadId: ThreadId.make("parent-1"),
                sideChat: true,
              },
            }),
          }),
        },
        {
          name: "workflowStep lineage",
          input: makeEligibilityInput({
            thread: baseThread({
              lineage: {
                parentThreadId: ThreadId.make("parent-1"),
                relationshipToParent: null,
                rootThreadId: ThreadId.make("parent-1"),
                workflowStep: true,
              },
            }),
          }),
        },
        {
          name: "delegatedFrom thread",
          input: makeEligibilityInput({
            thread: baseThread({
              delegatedFrom: {
                environmentId: EnvironmentId.make("env-remote"),
                threadId: ThreadId.make("remote-thread"),
                title: "Remote delegated thread",
              },
            }),
          }),
        },
        {
          name: "workflowRun thread",
          input: makeEligibilityInput({
            thread: baseThread({
              workflowRun: {
                workflowId: "wf-1",
                workflowRunId: "wfr-1",
                stepId: "step-1",
              } as unknown as ResolveTurnPersonalContextInput["projection"]["thread"]["workflowRun"],
            }),
          }),
        },
        {
          name: "scheduledTaskId message",
          input: makeEligibilityInput({
            providerMessage: baseMessage({ scheduledTaskId: ScheduledTaskId.make("sched-1") }),
          }),
        },
        {
          name: "senderThreadId message",
          input: makeEligibilityInput({
            providerMessage: baseMessage({ senderThreadId: ThreadId.make("sender-1") }),
          }),
        },
        {
          name: "linkedSender message",
          input: makeEligibilityInput({
            providerMessage: baseMessage({
              linkedSender: {
                environmentId: EnvironmentId.make("env-2"),
                threadId: ThreadId.make("remote-2"),
                title: "Linked peer thread",
              },
            }),
          }),
        },
        {
          name: "slack-relay message id prefix",
          input: makeEligibilityInput({
            providerMessage: baseMessage({ id: MessageId.make("slack-relay:msg:abc") }),
          }),
        },
        {
          name: "agent createdBy message",
          input: makeEligibilityInput({
            providerMessage: baseMessage({ createdBy: "agent" }),
          }),
        },
        {
          name: "system createdBy message",
          input: makeEligibilityInput({
            providerMessage: baseMessage({ createdBy: "system" }),
          }),
        },
        {
          name: "notification message",
          input: makeEligibilityInput({
            providerMessage: baseMessage({
              notification: {
                source: { kind: "background_task" },
                outcome: "completed",
                summary: "Task finished",
              },
            }),
          }),
        },
        {
          name: "delegatedCompletion message",
          input: makeEligibilityInput({
            providerMessage: baseMessage({
              delegatedCompletion: {
                parentRunId: RUN_1,
                generation: 1,
                taskIds: [NodeId.make("task-1")],
              },
            }),
          }),
        },
        {
          name: "idleCompaction message",
          input: makeEligibilityInput({
            providerMessage: baseMessage({ idleCompaction: "beforeCacheExpires" }),
          }),
        },
        {
          name: "workflowScript message",
          input: makeEligibilityInput({
            providerMessage: baseMessage({ workflowScript: true }),
          }),
        },
        {
          name: "slashCommand turn",
          input: makeEligibilityInput({ slashCommand: true }),
        },
        {
          name: "compact turn",
          input: makeEligibilityInput({ compact: true }),
        },
        {
          name: "manualResume without unsentResumeMessage",
          input: makeEligibilityInput({
            manualResume: true,
            unsentResumeMessage: undefined,
          }),
        },
      ];

      for (const testCase of excludedCases) {
        assert.isFalse(
          isEligiblePersonalContextTurn(testCase.input),
          `expected "${testCase.name}" to be excluded`,
        );
      }
    });
  });

  describe("hasDeliveredPromptOnNativeThread", () => {
    const baseDeliveredInput = (
      overrides: Partial<HasDeliveredPromptOnNativeThreadInput> = {},
    ): HasDeliveredPromptOnNativeThreadInput => ({
      acceptedAttempts: [],
      loadedNativeThreadId: "native-1",
      sameNativeThread: true,
      runs: [
        { id: RUN_1, ordinal: 1, userMessageId: MSG_1 },
        { id: RUN_2, ordinal: 2, userMessageId: MSG_2 },
      ],
      messages: [
        baseMessage({ id: MSG_1, text: "你好" }),
        baseMessage({ id: MSG_2, text: "继续" }),
      ],
      currentRunOrdinal: 2,
      isSlashCommandMessage,
      importedNativeSession: false,
      nativeForkTransfer: undefined,
      portableForkFallback: undefined,
      ...overrides,
    });

    it("returns false on the first turn when no attempts were delivered", () => {
      assert.isFalse(
        hasDeliveredPromptOnNativeThread(baseDeliveredInput({ currentRunOrdinal: 1 })),
      );
    });

    it("returns true on turn 2 when turn 1 delivered a normal prompt on the same native thread", () => {
      assert.isTrue(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            acceptedAttempts: [{ runId: RUN_1, nativeThreadId: "native-1" }],
            currentRunOrdinal: 2,
          }),
        ),
      );
    });

    it("defers to turn 2 when turn 1 was a slash command, then blocks turn 3", () => {
      const runs = [
        { id: RUN_1, ordinal: 1, userMessageId: MSG_1 },
        { id: RUN_2, ordinal: 2, userMessageId: MSG_2 },
        { id: RUN_3, ordinal: 3, userMessageId: MSG_3 },
      ];
      const messages = [
        baseMessage({ id: MSG_1, text: "/status" }),
        baseMessage({ id: MSG_2, text: "帮我看下这个 bug" }),
        baseMessage({ id: MSG_3, text: "再确认一下" }),
      ];

      assert.isFalse(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            acceptedAttempts: [{ runId: RUN_1, nativeThreadId: "native-1" }],
            runs,
            messages,
            currentRunOrdinal: 2,
          }),
        ),
      );

      assert.isTrue(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            acceptedAttempts: [
              { runId: RUN_1, nativeThreadId: "native-1" },
              { runId: RUN_2, nativeThreadId: "native-1" },
            ],
            runs,
            messages,
            currentRunOrdinal: 3,
          }),
        ),
      );
    });

    it("ignores earlier ineligible non-user / cross-thread / notification turns and defers to first eligible user turn", () => {
      const runs = [
        { id: RUN_1, ordinal: 1, userMessageId: MSG_1 },
        { id: RUN_2, ordinal: 2, userMessageId: MSG_2 },
        { id: RUN_3, ordinal: 3, userMessageId: MSG_3 },
      ];
      const ineligibleTurn1Cases: ReadonlyArray<{
        readonly name: string;
        readonly turn1Message: ReturnType<typeof baseMessage>;
      }> = [
        {
          name: "cross-thread senderThreadId",
          turn1Message: baseMessage({
            id: MSG_1,
            senderThreadId: ThreadId.make("peer-thread-1"),
            text: "来自其他线程的消息",
          }),
        },
        {
          name: "linkedSender cross-environment message",
          turn1Message: baseMessage({
            id: MSG_1,
            linkedSender: {
              environmentId: EnvironmentId.make("env-remote"),
              threadId: ThreadId.make("remote-thread-1"),
              title: "Remote thread",
            },
            text: "来自远端线程的消息",
          }),
        },
        {
          name: "system notification",
          turn1Message: baseMessage({
            id: MSG_1,
            createdBy: "system",
            notification: {
              source: { kind: "background_task" },
              outcome: "completed",
              summary: "Background build finished",
            },
            text: "后台任务已完成",
          }),
        },
        {
          name: "scheduled task",
          turn1Message: baseMessage({
            id: MSG_1,
            scheduledTaskId: ScheduledTaskId.make("sched-1"),
            text: "定时巡检",
          }),
        },
        {
          name: "delegatedCompletion",
          turn1Message: baseMessage({
            id: MSG_1,
            createdBy: "system",
            delegatedCompletion: {
              parentRunId: RUN_1,
              generation: 1,
              taskIds: [NodeId.make("task-1")],
            },
            text: "子任务已完成",
          }),
        },
        {
          name: "idleCompaction",
          turn1Message: baseMessage({
            id: MSG_1,
            idleCompaction: "beforeCacheExpires",
            text: "/compact",
          }),
        },
        {
          name: "workflowScript",
          turn1Message: baseMessage({
            id: MSG_1,
            workflowScript: true,
            text: "workflow script payload",
          }),
        },
        {
          name: "slack-relay message",
          turn1Message: baseMessage({
            id: MessageId.make("slack-relay:msg:1"),
            text: "Slack 转发问题",
          }),
        },
      ];

      for (const testCase of ineligibleTurn1Cases) {
        const turn1Id = testCase.turn1Message.id;
        const caseRuns = [{ id: RUN_1, ordinal: 1, userMessageId: turn1Id }, runs[1]!, runs[2]!];
        const messages = [
          testCase.turn1Message,
          baseMessage({ id: MSG_2, text: "正式用户首轮提问" }),
          baseMessage({ id: MSG_3, text: "正式用户次轮追问" }),
        ];

        assert.isFalse(
          hasDeliveredPromptOnNativeThread(
            baseDeliveredInput({
              acceptedAttempts: [{ runId: RUN_1, nativeThreadId: "native-1" }],
              runs: caseRuns,
              messages,
              currentRunOrdinal: 2,
            }),
          ),
          `expected turn 2 to remain eligible after "${testCase.name}"`,
        );

        assert.isTrue(
          hasDeliveredPromptOnNativeThread(
            baseDeliveredInput({
              acceptedAttempts: [
                { runId: RUN_1, nativeThreadId: "native-1" },
                { runId: RUN_2, nativeThreadId: "native-1" },
              ],
              runs: caseRuns,
              messages,
              currentRunOrdinal: 3,
            }),
          ),
          `expected turn 3 to skip after eligible user turn 2 following "${testCase.name}"`,
        );
      }
    });

    it("returns false on retry when turn 1 failed or was dropped before delivery", () => {
      // Failed/dropped turn 1 is excluded from acceptedAttempts by isDeliveredProviderTurn.
      assert.isFalse(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            acceptedAttempts: [],
            currentRunOrdinal: 1,
          }),
        ),
      );
      assert.isFalse(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            acceptedAttempts: [],
            currentRunOrdinal: 2,
          }),
        ),
      );
    });

    it("returns false when native session was replaced with a new nativeThreadId", () => {
      assert.isFalse(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            acceptedAttempts: [{ runId: RUN_1, nativeThreadId: "native-old" }],
            loadedNativeThreadId: "native-new",
            sameNativeThread: false,
            currentRunOrdinal: 2,
          }),
        ),
      );
    });

    it("handles legacy attempts without nativeThreadId based on sameNativeThread", () => {
      assert.isTrue(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            acceptedAttempts: [{ runId: RUN_1, nativeThreadId: undefined }],
            sameNativeThread: true,
            currentRunOrdinal: 2,
          }),
        ),
      );

      assert.isFalse(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            acceptedAttempts: [{ runId: RUN_1, nativeThreadId: undefined }],
            sameNativeThread: false,
            currentRunOrdinal: 2,
          }),
        ),
      );
    });

    it("treats importedNativeSession and successful native fork as existing history", () => {
      assert.isTrue(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            currentRunOrdinal: 1,
            importedNativeSession: true,
          }),
        ),
      );

      assert.isTrue(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            currentRunOrdinal: 1,
            nativeForkTransfer: { id: ContextTransferId.make("transfer-fork-1") },
            portableForkFallback: undefined,
          }),
        ),
      );

      // Portable fork fallback creates a fresh native session, so injection stays enabled.
      assert.isFalse(
        hasDeliveredPromptOnNativeThread(
          baseDeliveredInput({
            currentRunOrdinal: 1,
            nativeForkTransfer: { id: ContextTransferId.make("transfer-fork-1") },
            portableForkFallback: { id: ContextHandoffId.make("handoff-fork-1") },
          }),
        ),
      );
    });
  });

  describe("resolveTurnPersonalContext", () => {
    it.effect(
      "injects <personal_context> with derived projectSlug on first top-level user turn",
      () =>
        Effect.gen(function* () {
          const { input, getByIdCalls, buildCalls } = makeResolveInput();
          const result = yield* resolveTurnPersonalContext(input);

          assert.include(result, "<personal_context>");
          assert.include(result, "</personal_context>");
          assert.deepStrictEqual(getByIdCalls, [{ projectId: PROJECT_ID, includeDeleted: true }]);
          assert.deepStrictEqual(buildCalls, [
            {
              threadId: THREAD_ID,
              projectSlug: "t3-code",
              projectTitle: "T3 Code",
              nowIso: NOW_ISO,
            },
          ]);
        }),
    );

    it.effect("falls back projectSlug from title -> basename(workspaceRoot) -> projectId", () =>
      Effect.gen(function* () {
        const fromWorkspace = makeResolveInput({
          projects: {
            getById: () =>
              Effect.succeedSome({
                title: "   ",
                workspaceRoot: "/Users/dev/CT Studio Repo",
              }),
          },
        });
        yield* resolveTurnPersonalContext(fromWorkspace.input);
        assert.strictEqual(fromWorkspace.buildCalls[0]?.projectSlug, "ct-studio-repo");

        const fromProjectId = makeResolveInput({
          projects: {
            getById: () => Effect.succeedNone,
          },
        });
        yield* resolveTurnPersonalContext(fromProjectId.input);
        assert.strictEqual(fromProjectId.buildCalls[0]?.projectSlug, "project-alpha-01");
        assert.isNull(fromProjectId.buildCalls[0]?.projectTitle);
      }),
    );

    it.effect("returns empty string with zero I/O on turn 2 after a delivered prompt", () =>
      Effect.gen(function* () {
        const msg1 = baseMessage({ id: MSG_1, text: "第一轮问题" });
        const msg2 = baseMessage({ id: MSG_2, text: "第二轮追问" });
        const { input, getByIdCalls, buildCalls } = makeResolveInput({
          projection: {
            thread: baseThread(),
            runs: [
              { id: RUN_1, ordinal: 1, userMessageId: MSG_1 },
              { id: RUN_2, ordinal: 2, userMessageId: MSG_2 },
            ],
            messages: [msg1, msg2],
          },
          acceptedAttempts: [{ runId: RUN_1, nativeThreadId: "native-1" }],
          loadedNativeThreadId: "native-1",
          sameNativeThread: true,
          currentRunOrdinal: 2,
          providerMessage: msg2,
        });

        const result = yield* resolveTurnPersonalContext(input);
        assert.strictEqual(result, "");
        assert.lengthOf(getByIdCalls, 0);
        assert.lengthOf(buildCalls, 0);
      }),
    );

    it.effect("defers injection to turn 2 when turn 1 was a slash command", () =>
      Effect.gen(function* () {
        const msg1 = baseMessage({ id: MSG_1, text: "/model sonnet" });
        const msg2 = baseMessage({ id: MSG_2, text: "现在帮我写代码" });
        const { input, buildCalls } = makeResolveInput({
          projection: {
            thread: baseThread(),
            runs: [
              { id: RUN_1, ordinal: 1, userMessageId: MSG_1 },
              { id: RUN_2, ordinal: 2, userMessageId: MSG_2 },
            ],
            messages: [msg1, msg2],
          },
          acceptedAttempts: [{ runId: RUN_1, nativeThreadId: "native-1" }],
          loadedNativeThreadId: "native-1",
          sameNativeThread: true,
          currentRunOrdinal: 2,
          providerMessage: msg2,
          slashCommand: false,
        });

        const result = yield* resolveTurnPersonalContext(input);
        assert.include(result, "<personal_context>");
        assert.lengthOf(buildCalls, 1);
      }),
    );

    it.effect(
      "defers injection to turn 2 when turn 1 was a cross-thread message or system notification, then skips turn 3",
      () =>
        Effect.gen(function* () {
          const turn1Variants = [
            baseMessage({
              id: MSG_1,
              senderThreadId: ThreadId.make("sender-thread-1"),
              text: "跨线程同步消息",
            }),
            baseMessage({
              id: MSG_1,
              createdBy: "system",
              notification: {
                source: { kind: "background_task" },
                outcome: "completed",
                summary: "CI checks passed",
              },
              text: "系统通知：CI 已通过",
            }),
          ];

          for (const msg1 of turn1Variants) {
            const msg2 = baseMessage({ id: MSG_2, text: "用户首轮正式问题" });
            const msg3 = baseMessage({ id: MSG_3, text: "用户第二轮问题" });
            const runs = [
              { id: RUN_1, ordinal: 1, userMessageId: MSG_1 },
              { id: RUN_2, ordinal: 2, userMessageId: MSG_2 },
              { id: RUN_3, ordinal: 3, userMessageId: MSG_3 },
            ];

            const turn2 = makeResolveInput({
              projection: {
                thread: baseThread(),
                runs,
                messages: [msg1, msg2, msg3],
              },
              acceptedAttempts: [{ runId: RUN_1, nativeThreadId: "native-1" }],
              loadedNativeThreadId: "native-1",
              sameNativeThread: true,
              currentRunOrdinal: 2,
              providerMessage: msg2,
            });
            const turn2Result = yield* resolveTurnPersonalContext(turn2.input);
            assert.include(turn2Result, "<personal_context>");
            assert.lengthOf(turn2.buildCalls, 1);

            const turn3 = makeResolveInput({
              projection: {
                thread: baseThread(),
                runs,
                messages: [msg1, msg2, msg3],
              },
              acceptedAttempts: [
                { runId: RUN_1, nativeThreadId: "native-1" },
                { runId: RUN_2, nativeThreadId: "native-1" },
              ],
              loadedNativeThreadId: "native-1",
              sameNativeThread: true,
              currentRunOrdinal: 3,
              providerMessage: msg3,
            });
            const turn3Result = yield* resolveTurnPersonalContext(turn3.input);
            assert.strictEqual(turn3Result, "");
            assert.lengthOf(turn3.buildCalls, 0);
          }
        }),
    );

    it.effect("still injects when turn 1 failed or had promptDropped before delivery", () =>
      Effect.gen(function* () {
        const msg1 = baseMessage({ id: MSG_1, text: "第一次发送但被丢弃" });
        const { input, buildCalls } = makeResolveInput({
          projection: {
            thread: baseThread(),
            runs: [{ id: RUN_1, ordinal: 1, userMessageId: MSG_1 }],
            messages: [msg1],
          },
          acceptedAttempts: [],
          currentRunOrdinal: 1,
          providerMessage: msg1,
        });

        const result = yield* resolveTurnPersonalContext(input);
        assert.include(result, "<personal_context>");
        assert.lengthOf(buildCalls, 1);
      }),
    );

    it.effect(
      "returns empty string with zero I/O when PersonalMemoryService is Option.none()",
      () =>
        Effect.gen(function* () {
          const { input, getByIdCalls, buildCalls } = makeResolveInput({
            personalMemory: Option.none(),
          });
          const result = yield* resolveTurnPersonalContext(input);
          assert.strictEqual(result, "");
          assert.lengthOf(getByIdCalls, 0);
          assert.lengthOf(buildCalls, 0);
        }),
    );

    it.effect(
      "skips ineligible turns, imported native sessions, and native forks with zero I/O",
      () =>
        Effect.gen(function* () {
          const skippedOverrides: ReadonlyArray<{
            readonly name: string;
            readonly overrides: Partial<ResolveTurnPersonalContextInput>;
          }> = [
            {
              name: "subagent",
              overrides: {
                projection: {
                  thread: baseThread({
                    lineage: {
                      parentThreadId: ThreadId.make("parent-1"),
                      relationshipToParent: "subagent",
                      rootThreadId: ThreadId.make("parent-1"),
                    },
                  }),
                  runs: [{ id: RUN_1, ordinal: 1, userMessageId: MSG_1 }],
                  messages: [baseMessage()],
                },
              },
            },
            {
              name: "slack-relay message",
              overrides: {
                providerMessage: baseMessage({ id: MessageId.make("slack-relay:msg:123") }),
              },
            },
            {
              name: "compact command auto-detected when compact omitted",
              overrides: {
                compact: undefined,
                slashCommand: false,
                providerMessage: baseMessage({ text: "/compact" }),
              },
            },
            {
              name: "manualResume without unsentResumeMessage",
              overrides: {
                manualResume: true,
                unsentResumeMessage: undefined,
              },
            },
            {
              name: "v1_import native session passed from turn start",
              overrides: {
                importedNativeSession: true,
                sameNativeThread: true,
                loadedNativeThreadId: "native-imported",
              },
            },
            {
              name: "native fork without portable fallback",
              overrides: {
                nativeForkTransfer: {
                  id: ContextTransferId.make("fork-1"),
                  commandId: CommandId.make("cmd-fork-1"),
                },
                portableForkFallback: undefined,
              },
            },
          ];

          for (const testCase of skippedOverrides) {
            const { input, getByIdCalls, buildCalls } = makeResolveInput(testCase.overrides);
            const result = yield* resolveTurnPersonalContext(input);
            assert.strictEqual(result, "", `expected "${testCase.name}" to return empty string`);
            assert.lengthOf(getByIdCalls, 0, `expected "${testCase.name}" to do zero project I/O`);
            assert.lengthOf(buildCalls, 0, `expected "${testCase.name}" to do zero memory I/O`);
          }
        }),
    );

    it.effect(
      "gracefully degrades to empty string when PersonalMemoryService or projects fails/defects",
      () =>
        Effect.gen(function* () {
          const memoryFail = makeResolveInput({
            personalMemory: Option.some(
              makeMemoryStub(
                () =>
                  Effect.fail(
                    new PersonalStoreError({
                      operation: "buildTurnContext",
                      cause: new Error("boom"),
                    }),
                  ) as unknown as Effect.Effect<string>,
              ),
            ),
          });
          assert.strictEqual(yield* resolveTurnPersonalContext(memoryFail.input), "");

          const memoryDie = makeResolveInput({
            personalMemory: Option.some(makeMemoryStub(() => Effect.die(new Error("defect")))),
          });
          assert.strictEqual(yield* resolveTurnPersonalContext(memoryDie.input), "");

          const memorySyncThrow = makeResolveInput({
            personalMemory: Option.some(
              makeMemoryStub(() => {
                throw new Error("sync throw");
              }),
            ),
          });
          assert.strictEqual(yield* resolveTurnPersonalContext(memorySyncThrow.input), "");

          const projectFail = makeResolveInput({
            projects: {
              getById: () =>
                Effect.fail(
                  new ProjectOperationError({
                    operation: "read-project",
                    projectId: PROJECT_ID,
                    cause: new Error("db unavailable"),
                  }),
                ),
            },
          });
          assert.strictEqual(yield* resolveTurnPersonalContext(projectFail.input), "");

          const projectDie = makeResolveInput({
            projects: {
              getById: () => Effect.die(new Error("project defect")),
            },
          });
          assert.strictEqual(yield* resolveTurnPersonalContext(projectDie.input), "");
        }),
    );
  });
});
