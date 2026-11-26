import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as PersonalMemoryService from "./PersonalMemoryService.ts";
import {
  PersonalReflectionService,
  type PersonalReflectionServiceShape,
} from "./PersonalReflectionService.ts";
import {
  PersonalReflectionError,
  type ReflectNowInput,
  type ReflectionRunResult,
} from "./personalReflector.ts";
import { REDACTED_VALUE } from "./personalSanitizer.ts";
import type { WorkingItem } from "./personalTypes.ts";

const environmentId = EnvironmentId.make("environment-personal-mcp-test");
const callerThreadId = ThreadId.make("thread-personal-mcp-caller");
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const threadInvocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider-session-personal-mcp-test",
  thread: {
    threadId: callerThreadId,
    providerSessionId: "provider-session-personal-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

const externalClientInvocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client-session-personal-mcp-test",
  thread: undefined,
  client: {
    sessionId: "client-session-personal-mcp-test",
    label: "external-client",
    access: "full-access",
  },
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "personal-mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "personal-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const parseCallToolPayload = (result: McpSchema.CallToolResult): unknown => {
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return decodeJson(text);
};

const callTool = (
  name: string,
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope = threadInvocation,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    return {
      result,
      payload: parseCallToolPayload(result),
    };
  });

const makeBaseServices = () =>
  Layer.mergeAll(
    McpToolAccessTestkit.liveThreadsLayer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-mcp-test-" }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const makePersonalTestLayer = (reflectionImpl?: PersonalReflectionServiceShape) => {
  const withMemory = PersonalMemoryService.layer.pipe(Layer.provideMerge(makeBaseServices()));
  const services =
    reflectionImpl === undefined
      ? withMemory
      : Layer.merge(withMemory, Layer.succeed(PersonalReflectionService, reflectionImpl));

  return McpHttpServer.layerPersonalToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(services),
  );
};

const makeUnavailablePersonalTestLayer = () =>
  McpHttpServer.layerPersonalToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(makeBaseServices()),
  );

describe("personalMcp", () => {
  it.effect(
    "personal_memory_note writes all targets, captures caller threadId, and redacts secrets",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const memory = yield* PersonalMemoryService.PersonalMemoryService;

        const profileCall = yield* callTool("personal_memory_note", {
          target: "profile",
          content: "回答直接给结论，避免寒暄。",
        });
        expect(profileCall.result.isError).not.toBe(true);
        const profileData = profileCall.payload as {
          readonly target: string;
          readonly path: string;
          readonly scope: string;
          readonly redactedCount: number;
          readonly workingId: string | null;
        };
        expect(profileData.target).toBe("profile");
        expect(profileData.scope).toBe("global");
        expect(profileData.redactedCount).toBe(0);
        expect(profileData.workingId).toBeNull();
        expect(yield* fs.readFileString(profileData.path)).toContain("回答直接给结论");

        const guardrailCall = yield* callTool("personal_memory_note", {
          target: "guardrails",
          content: "发布脚本禁止硬编码 ghp_1234567890abcdef1234567890abcdef1234 凭据。",
        });
        expect(guardrailCall.result.isError).not.toBe(true);
        const guardrailData = guardrailCall.payload as {
          readonly target: string;
          readonly path: string;
          readonly scope: string;
          readonly redactedCount: number;
          readonly workingId: string | null;
        };
        expect(guardrailData.target).toBe("guardrails");
        expect(guardrailData.scope).toBe("global");
        expect(guardrailData.redactedCount).toBeGreaterThan(0);
        expect(guardrailData.workingId).toBeNull();
        const guardrailContent = yield* fs.readFileString(guardrailData.path);
        expect(guardrailContent).toContain(REDACTED_VALUE);
        expect(guardrailContent).not.toContain("ghp_1234567890abcdef1234567890abcdef1234");

        const lessonCall = yield* callTool("personal_memory_note", {
          target: "lesson",
          scope: "CT Studio",
          content: "执行 vp test 前确认已同步 agentContextBudget.json。",
        });
        expect(lessonCall.result.isError).not.toBe(true);
        const lessonData = lessonCall.payload as {
          readonly target: string;
          readonly path: string;
          readonly scope: string;
          readonly redactedCount: number;
          readonly workingId: string | null;
        };
        expect(lessonData.target).toBe("lesson");
        expect(lessonData.scope).toBe("ct-studio");
        expect(lessonData.workingId).toBeNull();
        expect(yield* fs.readFileString(lessonData.path)).toContain("agentContextBudget.json");

        const workingCall = yield* callTool("personal_memory_note", {
          target: "working",
          scope: "ct-studio",
          priority: "high",
          expiresAt: "2026-12-01T23:59:59.000Z",
          content: "跟进 Personal Agent Phase 1 PR review",
        });
        expect(workingCall.result.isError).not.toBe(true);
        const workingData = workingCall.payload as {
          readonly target: string;
          readonly path: string;
          readonly scope: string;
          readonly redactedCount: number;
          readonly workingId: string | null;
        };
        expect(workingData.target).toBe("working");
        expect(workingData.scope).toBe("ct-studio");
        expect(workingData.workingId).toBeTruthy();

        const snapshot = yield* memory.readSnapshotForReflection();
        const created = snapshot.workingItems.find((item) => item.id === workingData.workingId);
        expect(created).toBeDefined();
        expect(created?.priority).toBe("high");
        expect(created?.expiresAt).toBe("2026-12-01T23:59:59.000Z");
        expect(created?.sourceThreadIds).toEqual([callerThreadId]);

        const emptyCall = yield* callTool("personal_memory_note", {
          target: "profile",
          content: "   ",
        });
        expect(emptyCall.result.isError).toBe(true);
        expect(emptyCall.payload).toMatchObject({
          _tag: "OrchestratorMcpFailure",
          code: "invalid_request",
        });
      }).pipe(Effect.provide(makePersonalTestLayer())),
  );

  it.effect("personal_memory_search returns ranked matches with scope filtering and limit", () =>
    Effect.gen(function* () {
      yield* callTool("personal_memory_note", {
        target: "lesson",
        scope: "alpha-app",
        content: "deploy-checklist: alpha-app uses blue-green rollout",
      });
      yield* callTool("personal_memory_note", {
        target: "lesson",
        scope: "beta-app",
        content: "deploy-checklist: beta-app uses canary rollout",
      });
      yield* callTool("personal_memory_note", {
        target: "lesson",
        scope: "global",
        content: "deploy-checklist: verify health endpoint after rollout",
      });

      const scopedSearch = yield* callTool("personal_memory_search", {
        query: "deploy-checklist",
        scope: "alpha-app",
      });
      expect(scopedSearch.result.isError).not.toBe(true);
      const scopedData = scopedSearch.payload as {
        readonly count: number;
        readonly matches: ReadonlyArray<{
          readonly source: string;
          readonly scope: string;
          readonly snippet: string;
        }>;
      };
      expect(scopedData.count).toBe(scopedData.matches.length);
      expect(scopedData.count).toBeGreaterThanOrEqual(2);
      expect(scopedData.matches.some((m) => m.scope === "alpha-app")).toBe(true);
      expect(scopedData.matches.some((m) => m.scope === "beta-app")).toBe(false);

      const limitedSearch = yield* callTool("personal_memory_search", {
        query: "deploy-checklist",
        limit: 1,
      });
      expect(limitedSearch.result.isError).not.toBe(true);
      const limitedData = limitedSearch.payload as {
        readonly count: number;
        readonly matches: ReadonlyArray<unknown>;
      };
      expect(limitedData.count).toBe(1);
      expect(limitedData.matches).toHaveLength(1);

      const badLimit = yield* callTool("personal_memory_search", {
        query: "deploy-checklist",
        limit: 0,
      });
      expect(badLimit.result.isError).toBe(true);
      expect(badLimit.payload).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "invalid_request",
      });
    }).pipe(Effect.provide(makePersonalTestLayer())),
  );

  it.effect("personal_working_update handles reminded, done, dismiss, and missing id", () =>
    Effect.gen(function* () {
      const firstNote = yield* callTool("personal_memory_note", {
        target: "working",
        content: "验证 MCP 回归测试",
      });
      const firstId = (firstNote.payload as { readonly workingId: string }).workingId;

      const secondNote = yield* callTool("personal_memory_note", {
        target: "working",
        content: "临时待办将被关闭",
      });
      const secondId = (secondNote.payload as { readonly workingId: string }).workingId;

      const reminded = yield* callTool("personal_working_update", {
        id: firstId,
        action: "reminded",
      });
      expect(reminded.result.isError).not.toBe(true);
      expect(reminded.payload).toMatchObject({
        found: true,
        item: {
          id: firstId,
          reminded: true,
          status: "open",
        },
      });

      const done = yield* callTool("personal_working_update", {
        id: firstId,
        action: "done",
      });
      expect(done.result.isError).not.toBe(true);
      expect(done.payload).toMatchObject({
        found: true,
        item: {
          id: firstId,
          reminded: true,
          status: "done",
        },
      });

      const dismissed = yield* callTool("personal_working_update", {
        id: secondId,
        action: "dismiss",
      });
      expect(dismissed.result.isError).not.toBe(true);
      expect(dismissed.payload).toMatchObject({
        found: true,
        item: {
          id: secondId,
          reminded: true,
          status: "dismissed",
        },
      });

      const missing = yield* callTool("personal_working_update", {
        id: "w-non-existent",
        action: "done",
      });
      expect(missing.result.isError).not.toBe(true);
      expect(missing.payload).toEqual({
        found: false,
        item: null,
      } satisfies { readonly found: boolean; readonly item: WorkingItem | null });
    }).pipe(Effect.provide(makePersonalTestLayer())),
  );

  it.effect(
    "personal_thread_privacy defaults to caller threadId and rejects missing threadId for outside clients",
    () =>
      Effect.gen(function* () {
        const memory = yield* PersonalMemoryService.PersonalMemoryService;

        const enableCurrent = yield* callTool("personal_thread_privacy", {
          optOut: true,
        });
        expect(enableCurrent.result.isError).not.toBe(true);
        expect(enableCurrent.payload).toEqual({
          threadId: callerThreadId,
          optOut: true,
        });
        expect(yield* memory.isThreadOptOut(callerThreadId)).toBe(true);

        const disableCurrent = yield* callTool("personal_thread_privacy", {
          optOut: false,
        });
        expect(disableCurrent.result.isError).not.toBe(true);
        expect(disableCurrent.payload).toEqual({
          threadId: callerThreadId,
          optOut: false,
        });
        expect(yield* memory.isThreadOptOut(callerThreadId)).toBe(false);

        const explicitTarget = yield* callTool(
          "personal_thread_privacy",
          {
            optOut: true,
            threadId: "thread-explicit-optout",
          },
          externalClientInvocation,
        );
        expect(explicitTarget.result.isError).not.toBe(true);
        expect(explicitTarget.payload).toEqual({
          threadId: "thread-explicit-optout",
          optOut: true,
        });
        expect(yield* memory.isThreadOptOut("thread-explicit-optout")).toBe(true);

        const missingThread = yield* callTool(
          "personal_thread_privacy",
          { optOut: true },
          externalClientInvocation,
        );
        expect(missingThread.result.isError).toBe(true);
        expect(missingThread.payload).toMatchObject({
          _tag: "OrchestratorMcpFailure",
          code: "invalid_request",
        });
      }).pipe(Effect.provide(makePersonalTestLayer())),
  );

  it.effect(
    "personal_memory_note rejects writes from an opted-out (private) thread without persisting notes or leaking threadId",
    () =>
      Effect.gen(function* () {
        const memory = yield* PersonalMemoryService.PersonalMemoryService;

        const optOutResult = yield* callTool("personal_thread_privacy", { optOut: true });
        expect(optOutResult.result.isError).not.toBe(true);
        expect(yield* memory.isThreadOptOut(callerThreadId)).toBe(true);

        const targets = ["profile", "guardrails", "lesson", "working"] as const;
        for (const target of targets) {
          const blocked = yield* callTool("personal_memory_note", {
            target,
            content: `秘密内容-${target}`,
            ...(target === "working" ? { priority: "high" } : {}),
          });
          expect(blocked.result.isError).toBe(true);
          expect(blocked.payload).toEqual({
            _tag: "OrchestratorMcpFailure",
            code: "invalid_request",
            message:
              "Current thread is marked private (opt-out); personal memory notes are disabled for this thread.",
          });
        }

        const snapshot = yield* memory.readSnapshotForReflection();
        expect(snapshot.profile).not.toContain("秘密内容");
        expect(snapshot.guardrails).not.toContain("秘密内容");
        expect(Object.values(snapshot.lessons).join("\n")).not.toContain("秘密内容");
        expect(snapshot.workingItems).toHaveLength(0);

        // Once opt-out is turned off, notes work again for the thread.
        const optInResult = yield* callTool("personal_thread_privacy", { optOut: false });
        expect(optInResult.result.isError).not.toBe(true);
        const allowed = yield* callTool("personal_memory_note", {
          target: "profile",
          content: "关闭无痕后正常写入。",
        });
        expect(allowed.result.isError).not.toBe(true);
      }).pipe(Effect.provide(makePersonalTestLayer())),
  );

  it.effect(
    "personal_thread_privacy blocks a thread session from changing a different thread's privacy state",
    () =>
      Effect.gen(function* () {
        const memory = yield* PersonalMemoryService.PersonalMemoryService;
        const otherThreadId = "thread-other-victim";

        // Seed another thread as opted-out via external client.
        const seed = yield* callTool(
          "personal_thread_privacy",
          { optOut: true, threadId: otherThreadId },
          externalClientInvocation,
        );
        expect(seed.result.isError).not.toBe(true);
        expect(yield* memory.isThreadOptOut(otherThreadId)).toBe(true);

        // Caller thread attempting to toggle another thread's privacy must be rejected.
        const crossThreadAttempt = yield* callTool("personal_thread_privacy", {
          optOut: false,
          threadId: otherThreadId,
        });
        expect(crossThreadAttempt.result.isError).toBe(true);
        expect(crossThreadAttempt.payload).toEqual({
          _tag: "OrchestratorMcpFailure",
          code: "invalid_request",
          message: "Cannot change privacy state for a different thread from this session.",
        });
        // Target thread's privacy state must remain untouched.
        expect(yield* memory.isThreadOptOut(otherThreadId)).toBe(true);

        // Passing the caller's own threadId explicitly is still permitted.
        const sameThreadExplicit = yield* callTool("personal_thread_privacy", {
          optOut: true,
          threadId: callerThreadId,
        });
        expect(sameThreadExplicit.result.isError).not.toBe(true);
        expect(sameThreadExplicit.payload).toEqual({
          threadId: callerThreadId,
          optOut: true,
        });
        expect(yield* memory.isThreadOptOut(callerThreadId)).toBe(true);
      }).pipe(Effect.provide(makePersonalTestLayer())),
  );

  it.effect(
    "personal_reflect_now invokes PersonalReflectionService, validates lookbackDays, and maps errors",
    () => {
      const receivedInputs: Array<ReflectNowInput | undefined> = [];
      let shouldFail = false;

      const mockReflection: PersonalReflectionServiceShape = {
        reflectNow: (input) => {
          receivedInputs.push(input);
          if (shouldFail) {
            return Effect.fail(
              new PersonalReflectionError({
                operation: "generateIncrementalReflection",
                detail: "mock reflection backend failed",
              }),
            );
          }
          const mode = input?.mode ?? "incremental";
          return Effect.succeed({
            mode,
            skipped: false,
            scannedThreads: mode === "incremental" ? 4 : 0,
            reflectedThreads: mode === "incremental" ? 2 : 0,
            updatedFiles: ["/tmp/personal/profile.md"],
            redactedCount: 1,
            modelUsed: "codex:gpt-5",
          } satisfies ReflectionRunResult);
        },
      };

      return Effect.gen(function* () {
        const incremental = yield* callTool("personal_reflect_now", {
          mode: "incremental",
          lookbackDays: 7,
        });
        expect(incremental.result.isError).not.toBe(true);
        expect(incremental.payload).toEqual({
          mode: "incremental",
          skipped: false,
          reason: null,
          scannedThreads: 4,
          reflectedThreads: 2,
          updatedFiles: ["/tmp/personal/profile.md"],
          redactedCount: 1,
          modelUsed: "codex:gpt-5",
        });
        expect(receivedInputs[0]).toEqual({ mode: "incremental", lookbackDays: 7 });

        const compact = yield* callTool("personal_reflect_now", {
          mode: "daily_compact",
        });
        expect(compact.result.isError).not.toBe(true);
        expect(compact.payload).toMatchObject({
          mode: "daily_compact",
          skipped: false,
          reason: null,
          modelUsed: "codex:gpt-5",
        });

        for (const invalidDays of [0, -3, 91, 2.5]) {
          const invalid = yield* callTool("personal_reflect_now", {
            lookbackDays: invalidDays,
          });
          expect(invalid.result.isError).toBe(true);
          expect(invalid.payload).toMatchObject({
            _tag: "OrchestratorMcpFailure",
            code: "invalid_request",
          });
        }
        expect(receivedInputs).toHaveLength(2);

        shouldFail = true;
        const failed = yield* callTool("personal_reflect_now", {});
        expect(failed.result.isError).toBe(true);
        expect(failed.payload).toMatchObject({
          _tag: "OrchestratorMcpFailure",
          code: "orchestration_error",
          message: expect.stringContaining("mock reflection backend failed"),
        });
      }).pipe(Effect.provide(makePersonalTestLayer(mockReflection)));
    },
  );

  it.effect(
    "all 5 tools degrade to OrchestratorMcpFailure when PersonalMemoryService / PersonalReflectionService are absent",
    () =>
      Effect.gen(function* () {
        const calls = [
          yield* callTool("personal_memory_search", { query: "test" }),
          yield* callTool("personal_memory_note", { target: "profile", content: "note" }),
          yield* callTool("personal_working_update", { id: "w-1", action: "done" }),
          yield* callTool("personal_thread_privacy", { optOut: true }),
          yield* callTool("personal_reflect_now", {}),
        ];

        for (const call of calls) {
          expect(call.result.isError).toBe(true);
          expect(call.payload).toMatchObject({
            _tag: "OrchestratorMcpFailure",
            code: "orchestration_error",
            message: expect.stringContaining("unavailable"),
          });
        }
      }).pipe(Effect.provide(makeUnavailablePersonalTestLayer())),
  );

  it.effect("registers all 5 tools without anthropic/alwaysLoad and with expected hints", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const byName = new Map(server.tools.map(({ tool }) => [tool.name, tool]));
      expect([...byName.keys()].toSorted()).toEqual([
        "personal_memory_note",
        "personal_memory_search",
        "personal_reflect_now",
        "personal_thread_privacy",
        "personal_working_update",
      ]);

      for (const tool of byName.values()) {
        expect(tool._meta?.["anthropic/alwaysLoad"]).toBeUndefined();
        expect(tool.annotations?.destructiveHint).toBe(false);
      }
      expect(byName.get("personal_memory_search")?.annotations?.readOnlyHint).toBe(true);
    }).pipe(Effect.provide(makeUnavailablePersonalTestLayer())),
  );
});
