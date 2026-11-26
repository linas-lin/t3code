import {
  isCompactionCommandMessage,
  isDelegatedAppThread,
  isListedThreadLineage,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type Project,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import { isSlashCommandMessage as defaultIsSlashCommandMessage } from "../orchestration-v2/ContextHandoffDelivery.ts";
import type { ProjectOperationError } from "../project/ProjectService.ts";
import type { PersonalMemoryServiceShape } from "./PersonalMemoryService.ts";
import { toProjectSlug } from "./personalPaths.ts";

const SLACK_RELAY_MESSAGE_ID_PREFIX = "slack-relay:";

export type PersonalContextEligibleMessageFields = Pick<
  OrchestrationV2ConversationMessage,
  | "id"
  | "createdBy"
  | "scheduledTaskId"
  | "senderThreadId"
  | "linkedSender"
  | "notification"
  | "delegatedCompletion"
  | "idleCompaction"
  | "workflowScript"
>;

export type PersonalContextHistoryMessage = PersonalContextEligibleMessageFields &
  Pick<OrchestrationV2ConversationMessage, "role" | "text"> & {
    readonly attachments?: OrchestrationV2ConversationMessage["attachments"] | undefined;
  };

function isEligiblePersonalContextMessage(message: PersonalContextEligibleMessageFields): boolean {
  if (message.createdBy !== "user") return false;
  if (message.scheduledTaskId !== undefined) return false;
  if (message.senderThreadId !== undefined) return false;
  if (message.linkedSender !== undefined) return false;
  if (message.notification !== undefined) return false;
  if (message.delegatedCompletion !== undefined) return false;
  if (message.idleCompaction !== undefined) return false;
  if (message.workflowScript === true) return false;
  if (message.id.startsWith(SLACK_RELAY_MESSAGE_ID_PREFIX)) return false;
  return true;
}

export interface PersonalContextTurnEligibilityInput {
  readonly thread: Pick<OrchestrationV2AppThread, "lineage" | "delegatedFrom" | "workflowRun">;
  readonly providerMessage: PersonalContextEligibleMessageFields;
  readonly slashCommand: boolean;
  readonly compact?: boolean | undefined;
  readonly manualResume: boolean;
  readonly unsentResumeMessage?: unknown | undefined;
}

/**
 * Pure eligibility predicate deciding whether a turn is a direct top-level user prompt
 * eligible to receive the `<personal_context>` block.
 */
export function isEligiblePersonalContextTurn(input: PersonalContextTurnEligibilityInput): boolean {
  const { thread, providerMessage, slashCommand, manualResume, unsentResumeMessage } = input;
  if (!isListedThreadLineage(thread.lineage)) return false;
  if (isDelegatedAppThread(thread)) return false;
  if (thread.workflowRun != null) return false;
  if (!isEligiblePersonalContextMessage(providerMessage)) return false;
  if (slashCommand) return false;
  if (input.compact === true) return false;
  if (manualResume && unsentResumeMessage === undefined) return false;
  return true;
}

export interface HasDeliveredPromptOnNativeThreadInput {
  readonly acceptedAttempts: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "runId" | "nativeThreadId">
  >;
  readonly loadedNativeThreadId: string | null | undefined;
  readonly sameNativeThread: boolean;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "userMessageId">>;
  readonly messages: ReadonlyArray<PersonalContextHistoryMessage>;
  readonly currentRunOrdinal: number;
  readonly isSlashCommandMessage?: (
    message: Pick<OrchestrationV2ConversationMessage, "role" | "text">,
  ) => boolean;
  readonly importedNativeSession?: boolean | undefined;
  readonly nativeForkTransfer?: unknown | undefined;
  readonly portableForkFallback?: unknown | undefined;
}

/**
 * Returns `true` when the active native provider session already carries prior conversational
 * history from an eligible user prompt (an earlier delivered eligible non-slash user turn,
 * an imported v1 native session, or a native fork that did not fall back to portable handoff).
 */
export function hasDeliveredPromptOnNativeThread(
  input: HasDeliveredPromptOnNativeThreadInput,
): boolean {
  if (input.importedNativeSession === true) {
    return true;
  }
  if (input.nativeForkTransfer !== undefined && input.portableForkFallback === undefined) {
    return true;
  }
  if (input.acceptedAttempts.length === 0) {
    return false;
  }

  const isSlashCommand = input.isSlashCommandMessage ?? defaultIsSlashCommandMessage;
  const hasRecordedNativeThreadId = input.acceptedAttempts.some(
    (attempt) => attempt.nativeThreadId !== undefined,
  );
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const messagesById = new Map(input.messages.map((message) => [message.id, message]));

  for (const attempt of input.acceptedAttempts) {
    const onCurrentNativeThread =
      attempt.nativeThreadId !== undefined
        ? input.loadedNativeThreadId != null &&
          attempt.nativeThreadId === input.loadedNativeThreadId
        : input.sameNativeThread && !hasRecordedNativeThreadId;
    if (!onCurrentNativeThread) {
      continue;
    }

    const sourceRun = runsById.get(attempt.runId);
    if (sourceRun === undefined || sourceRun.ordinal >= input.currentRunOrdinal) {
      continue;
    }

    const sourceMessage = messagesById.get(sourceRun.userMessageId);
    if (
      sourceMessage !== undefined &&
      (!isEligiblePersonalContextMessage(sourceMessage) ||
        isSlashCommand(sourceMessage) ||
        isCompactionCommandMessage(sourceMessage))
    ) {
      continue;
    }

    return true;
  }

  return false;
}

export interface ResolveTurnPersonalContextInput {
  readonly personalMemory: Option.Option<PersonalMemoryServiceShape>;
  readonly projects: {
    readonly getById: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<
      Option.Option<Pick<Project, "title" | "workspaceRoot">>,
      ProjectOperationError
    >;
  };
  readonly pathService: Pick<Path.Path, "basename">;
  readonly nowIso: string;
  readonly projection: {
    readonly thread: Pick<
      OrchestrationV2AppThread,
      "id" | "projectId" | "lineage" | "delegatedFrom" | "workflowRun"
    >;
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "userMessageId">>;
    readonly messages: ReadonlyArray<PersonalContextHistoryMessage>;
  };
  readonly acceptedAttempts: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "runId" | "nativeThreadId">
  >;
  readonly loadedNativeThreadId: string | null | undefined;
  readonly sameNativeThread: boolean;
  readonly currentRunOrdinal: number;
  readonly providerMessage: Pick<
    OrchestrationV2ConversationMessage,
    | "id"
    | "role"
    | "text"
    | "attachments"
    | "createdBy"
    | "scheduledTaskId"
    | "senderThreadId"
    | "linkedSender"
    | "notification"
    | "delegatedCompletion"
    | "idleCompaction"
    | "workflowScript"
  >;
  readonly slashCommand: boolean;
  readonly compact?: boolean | undefined;
  readonly manualResume: boolean;
  readonly unsentResumeMessage?: unknown | undefined;
  readonly importedNativeSession?: boolean | undefined;
  readonly nativeForkTransfer?: unknown | undefined;
  readonly portableForkFallback?: unknown | undefined;
  readonly isSlashCommandMessage?: (
    message: Pick<OrchestrationV2ConversationMessage, "role" | "text">,
  ) => boolean;
}

/**
 * Resolves the `<personal_context>` prompt prefix for a provider turn start.
 * Performs zero I/O when `PersonalMemoryService` is absent, the turn is ineligible,
 * or the native session already has delivered eligible user history; degrades to `""` on any failure.
 */
export const resolveTurnPersonalContext = (
  input: ResolveTurnPersonalContextInput,
): Effect.Effect<string> => {
  if (Option.isNone(input.personalMemory)) {
    return Effect.succeed("");
  }

  return Effect.gen(function* () {
    const compact = input.compact ?? isCompactionCommandMessage(input.providerMessage);
    if (
      !isEligiblePersonalContextTurn({
        thread: input.projection.thread,
        providerMessage: input.providerMessage,
        slashCommand: input.slashCommand,
        compact,
        manualResume: input.manualResume,
        unsentResumeMessage: input.unsentResumeMessage,
      })
    ) {
      return "";
    }

    if (
      hasDeliveredPromptOnNativeThread({
        acceptedAttempts: input.acceptedAttempts,
        loadedNativeThreadId: input.loadedNativeThreadId,
        sameNativeThread: input.sameNativeThread,
        runs: input.projection.runs,
        messages: input.projection.messages,
        currentRunOrdinal: input.currentRunOrdinal,
        ...(input.isSlashCommandMessage === undefined
          ? {}
          : { isSlashCommandMessage: input.isSlashCommandMessage }),
        importedNativeSession: input.importedNativeSession === true,
        nativeForkTransfer: input.nativeForkTransfer,
        portableForkFallback: input.portableForkFallback,
      })
    ) {
      return "";
    }

    const projectOption = yield* input.projects.getById(input.projection.thread.projectId, {
      includeDeleted: true,
    });
    const project = Option.getOrUndefined(projectOption);
    const trimmedTitle = project?.title?.trim() ?? "";
    const workspaceName = project?.workspaceRoot
      ? input.pathService.basename(project.workspaceRoot)
      : "";
    const projectSlug = toProjectSlug(
      trimmedTitle || workspaceName || input.projection.thread.projectId,
    );

    const memory = Option.getOrThrow(input.personalMemory);
    return yield* memory.buildTurnContext({
      threadId: input.projection.thread.id,
      projectSlug,
      projectTitle: project?.title ?? null,
      nowIso: input.nowIso,
    });
  }).pipe(Effect.catchCause(() => Effect.succeed("")));
};
