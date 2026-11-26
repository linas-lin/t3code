import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { PersonalMemoryService } from "./PersonalMemoryService.ts";
import { PersonalReflectionService } from "./PersonalReflectionService.ts";
import {
  MemorySearchMatch,
  PersonalNoteTarget,
  WorkingItem,
  WorkingPriority,
  WorkingUpdateAction,
} from "./personalTypes.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const ReflectionModeSchema = Schema.Literals(["incremental", "daily_compact"]);

const PersonalMemorySearchTool = Tool.make("personal_memory_search", {
  ...shared,
  description: "Search personal memory (guardrails, profile, working, lessons).",
  parameters: Schema.Struct({
    query: Schema.String,
    scope: Schema.optionalKey(
      Schema.String.annotate({ description: "Optional project slug or 'global'." }),
    ),
    limit: Schema.optionalKey(
      Schema.Number.annotate({ description: "Max matches (1-100, default 10)." }),
    ),
  }),
  success: Schema.Struct({
    count: Schema.Number,
    matches: Schema.Array(MemorySearchMatch),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PersonalMemoryNoteTool = Tool.make("personal_memory_note", {
  ...shared,
  description: "Save a note to personal memory (auto-redacts secrets).",
  parameters: Schema.Struct({
    target: PersonalNoteTarget,
    content: Schema.String,
    scope: Schema.optionalKey(
      Schema.String.annotate({ description: "Project slug or 'global' (lesson/working)." }),
    ),
    priority: Schema.optionalKey(WorkingPriority),
    expiresAt: Schema.optionalKey(
      Schema.String.annotate({ description: "ISO expiry for working items." }),
    ),
  }),
  success: Schema.Struct({
    target: PersonalNoteTarget,
    path: Schema.String,
    scope: Schema.String,
    redactedCount: Schema.Number,
    workingId: Schema.NullOr(Schema.String),
  }),
}).annotate(Tool.Destructive, false);

const PersonalWorkingUpdateTool = Tool.make("personal_working_update", {
  ...shared,
  description: "Update a working memory item status.",
  parameters: Schema.Struct({
    id: Schema.String,
    action: WorkingUpdateAction,
  }),
  success: Schema.Struct({
    found: Schema.Boolean,
    item: Schema.NullOr(WorkingItem),
  }),
}).annotate(Tool.Destructive, false);

const PersonalThreadPrivacyTool = Tool.make("personal_thread_privacy", {
  ...shared,
  description: "Toggle incognito opt-out for a thread.",
  parameters: Schema.Struct({
    optOut: Schema.Boolean,
    threadId: Schema.optionalKey(
      Schema.String.annotate({ description: "Defaults to current thread." }),
    ),
  }),
  success: Schema.Struct({
    threadId: Schema.String,
    optOut: Schema.Boolean,
  }),
}).annotate(Tool.Destructive, false);

const PersonalReflectNowTool = Tool.make("personal_reflect_now", {
  ...shared,
  description: "Run personal memory reflection or compaction.",
  parameters: Schema.Struct({
    mode: Schema.optionalKey(ReflectionModeSchema),
    lookbackDays: Schema.optionalKey(
      Schema.Number.annotate({ description: "1-90 days (incremental)." }),
    ),
  }),
  success: Schema.Struct({
    mode: ReflectionModeSchema,
    skipped: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
    scannedThreads: Schema.Number,
    reflectedThreads: Schema.Number,
    updatedFiles: Schema.Array(Schema.String),
    redactedCount: Schema.Number,
    modelUsed: Schema.NullOr(Schema.String),
  }),
}).annotate(Tool.Destructive, false);

export const PersonalToolkit = Toolkit.make(
  PersonalMemorySearchTool,
  PersonalMemoryNoteTool,
  PersonalWorkingUpdateTool,
  PersonalThreadPrivacyTool,
  PersonalReflectNowTool,
);

const requirePersonalMemory = Effect.flatMap(
  Effect.serviceOption(PersonalMemoryService),
  Option.match({
    onNone: () =>
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Personal memory service is unavailable in this environment.",
        }),
      ),
    onSome: Effect.succeed,
  }),
);

const requirePersonalReflection = Effect.flatMap(
  Effect.serviceOption(PersonalReflectionService),
  Option.match({
    onNone: () =>
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Personal reflection service is unavailable in this environment.",
        }),
      ),
    onSome: Effect.succeed,
  }),
);

const toServiceFailure = (err: { readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: err.message,
  });

export const layerPersonalHandlers = McpToolAccess.toLayer(PersonalToolkit, {
  personal_memory_search: McpToolAccess.reads(({ query, scope, limit }) =>
    Effect.gen(function* () {
      if (
        limit !== undefined &&
        (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "limit must be an integer between 1 and 100.",
        });
      }
      const memory = yield* requirePersonalMemory;
      const matches = yield* memory
        .searchMemory({
          query,
          ...(scope === undefined ? {} : { scope }),
          ...(limit === undefined ? {} : { limit }),
        })
        .pipe(Effect.mapError(toServiceFailure));
      return {
        count: matches.length,
        matches: [...matches],
      };
    }),
  ),
  personal_memory_note: McpToolAccess.writes(({ target, content, scope, priority, expiresAt }) =>
    Effect.gen(function* () {
      if (content.trim().length === 0) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "content must not be empty.",
        });
      }
      const memory = yield* requirePersonalMemory;
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const sourceThreadId = invocation.thread?.threadId;
      if (sourceThreadId !== undefined) {
        const isOptOut = yield* memory
          .isThreadOptOut(sourceThreadId)
          .pipe(Effect.mapError(toServiceFailure));
        if (isOptOut) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Current thread is marked private (opt-out); personal memory notes are disabled for this thread.",
          });
        }
      }
      const normalizedExpiresAt =
        expiresAt === undefined
          ? undefined
          : expiresAt.trim().length === 0
            ? null
            : expiresAt.trim();
      const result = yield* memory
        .addNote({
          target,
          content,
          ...(scope === undefined ? {} : { scope }),
          ...(priority === undefined ? {} : { priority }),
          ...(normalizedExpiresAt === undefined ? {} : { expiresAt: normalizedExpiresAt }),
          ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
        })
        .pipe(Effect.mapError(toServiceFailure));
      return {
        target: result.target,
        path: result.path,
        scope: result.scope,
        redactedCount: result.redactedCount,
        workingId: result.workingItem?.id ?? null,
      };
    }),
  ),
  personal_working_update: McpToolAccess.writes(({ id, action }) =>
    Effect.gen(function* () {
      const trimmedId = id.trim();
      if (trimmedId.length === 0) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "id must not be empty.",
        });
      }
      const memory = yield* requirePersonalMemory;
      const item = yield* memory
        .updateWorkingItem(trimmedId, action)
        .pipe(Effect.mapError(toServiceFailure));
      return {
        found: item !== null,
        item,
      };
    }),
  ),
  personal_thread_privacy: McpToolAccess.writes(({ optOut, threadId }) =>
    Effect.gen(function* () {
      const trimmedThreadId = threadId?.trim();
      if (threadId !== undefined && trimmedThreadId === "") {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "threadId must not be empty.",
        });
      }
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const callerThreadId = invocation.thread?.threadId;
      if (
        callerThreadId !== undefined &&
        trimmedThreadId !== undefined &&
        trimmedThreadId !== callerThreadId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Cannot change privacy state for a different thread from this session.",
        });
      }
      const resolvedThreadId = trimmedThreadId ?? callerThreadId;
      if (resolvedThreadId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "threadId is required when not called from a T3 thread.",
        });
      }
      const memory = yield* requirePersonalMemory;
      yield* memory
        .setThreadOptOut(resolvedThreadId, optOut)
        .pipe(Effect.mapError(toServiceFailure));
      return {
        threadId: resolvedThreadId,
        optOut,
      };
    }),
  ),
  personal_reflect_now: McpToolAccess.writes(({ mode, lookbackDays }) =>
    Effect.gen(function* () {
      if (
        lookbackDays !== undefined &&
        (!Number.isFinite(lookbackDays) ||
          !Number.isInteger(lookbackDays) ||
          lookbackDays < 1 ||
          lookbackDays > 90)
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "lookbackDays must be an integer between 1 and 90.",
        });
      }
      const reflection = yield* requirePersonalReflection;
      const result = yield* reflection
        .reflectNow({
          ...(mode === undefined ? {} : { mode }),
          ...(lookbackDays === undefined ? {} : { lookbackDays }),
        })
        .pipe(Effect.mapError(toServiceFailure));
      return {
        mode: result.mode,
        skipped: result.skipped,
        reason: result.reason ?? null,
        scannedThreads: result.scannedThreads,
        reflectedThreads: result.reflectedThreads,
        updatedFiles: [...result.updatedFiles],
        redactedCount: result.redactedCount,
        modelUsed: result.modelUsed ?? null,
      };
    }),
  ),
});
