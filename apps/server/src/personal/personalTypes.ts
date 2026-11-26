import { ModelSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const WorkingPriority = Schema.Literals(["high", "medium", "low"]);
export type WorkingPriority = typeof WorkingPriority.Type;

export const WorkingStatus = Schema.Literals(["open", "done", "dismissed"]);
export type WorkingStatus = typeof WorkingStatus.Type;

export const WorkingUpdateAction = Schema.Literals(["reminded", "done", "dismiss"]);
export type WorkingUpdateAction = typeof WorkingUpdateAction.Type;

export const WorkingItem = Schema.Struct({
  id: Schema.String,
  priority: WorkingPriority,
  scope: Schema.String,
  reminded: Schema.Boolean,
  status: WorkingStatus,
  expiresAt: Schema.NullOr(Schema.String),
  sourceThreadIds: Schema.Array(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  summary: Schema.String,
});
export type WorkingItem = typeof WorkingItem.Type;

export const ThreadReflectionCursor = Schema.Struct({
  lastMessageCount: Schema.Number,
  lastUpdatedAt: Schema.String,
  lastReflectedAt: Schema.String,
});
export type ThreadReflectionCursor = typeof ThreadReflectionCursor.Type;

export const PersonalState = Schema.Struct({
  version: Schema.Literal(1),
  reflectionModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  threadCursors: Schema.Record(Schema.String, ThreadReflectionCursor),
  optOutThreadIds: Schema.Array(Schema.String),
  lastIncrementalAt: Schema.NullOr(Schema.String),
  lastDailyCompactAt: Schema.NullOr(Schema.String),
});
export type PersonalState = typeof PersonalState.Type;

export const DEFAULT_PERSONAL_STATE: PersonalState = {
  version: 1,
  reflectionModelSelection: null,
  threadCursors: {},
  optOutThreadIds: [],
  lastIncrementalAt: null,
  lastDailyCompactAt: null,
};

export const PersonalNoteTarget = Schema.Literals(["profile", "guardrails", "lesson", "working"]);
export type PersonalNoteTarget = typeof PersonalNoteTarget.Type;

export const MemorySearchMatch = Schema.Struct({
  source: Schema.String,
  scope: Schema.String,
  line: Schema.Number,
  snippet: Schema.String,
  score: Schema.Number,
});
export type MemorySearchMatch = typeof MemorySearchMatch.Type;

export const PersonalContextBuildInput = Schema.Struct({
  threadId: Schema.String,
  projectSlug: Schema.optional(Schema.NullOr(Schema.String)),
  projectTitle: Schema.optional(Schema.NullOr(Schema.String)),
  nowIso: Schema.String,
  maxBytes: Schema.optional(Schema.Number),
});
export type PersonalContextBuildInput = typeof PersonalContextBuildInput.Type;

export class PersonalStoreError extends Schema.TaggedError<
  PersonalStoreError,
  { readonly brand: unique symbol }
>()("PersonalStoreError", {
  operation: Schema.String,
  targetPath: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const suffix = this.targetPath === undefined ? "" : ` (${this.targetPath})`;
    return `Personal memory store operation "${this.operation}" failed${suffix}.`;
  }
}

export interface MemorySearchInput {
  readonly query: string;
  readonly scope?: string | null | undefined;
  readonly limit?: number | undefined;
}

export interface AddNoteInput {
  readonly target: PersonalNoteTarget;
  readonly content: string;
  readonly scope?: string | null | undefined;
  readonly priority?: WorkingPriority | undefined;
  readonly expiresAt?: string | null | undefined;
  readonly sourceThreadId?: string | null | undefined;
}

export interface AddNoteResult {
  readonly target: PersonalNoteTarget;
  readonly path: string;
  readonly scope: string;
  readonly redactedCount: number;
  readonly workingItem?: WorkingItem | undefined;
}

export interface WorkingItemUpsertInput {
  readonly id?: string | undefined;
  readonly priority?: WorkingPriority | undefined;
  readonly scope?: string | null | undefined;
  readonly reminded?: boolean | undefined;
  readonly status?: WorkingStatus | undefined;
  readonly expiresAt?: string | null | undefined;
  readonly sourceThreadIds?: ReadonlyArray<string> | undefined;
  readonly summary: string;
}

export interface WorkingClosureInput {
  readonly id: string;
  readonly status: "done" | "dismissed";
}

export interface ReflectionContentHashes {
  readonly profile: string;
  readonly lessons: Readonly<Record<string, string>>;
}

export interface ReflectionExpectedBaseHashes {
  readonly profile?: string | undefined;
  readonly lessons?: Readonly<Record<string, string>> | undefined;
}

export interface ReflectionSnapshot {
  readonly guardrails: string;
  readonly profile: string;
  readonly workingItems: ReadonlyArray<WorkingItem>;
  readonly lessons: Readonly<Record<string, string>>;
  readonly state: PersonalState;
  readonly contentHashes?: ReflectionContentHashes | undefined;
}

export interface ReflectionUpdatesInput {
  readonly reason?: string | undefined;
  readonly profile?: string | undefined;
  readonly guardrailsAppend?: ReadonlyArray<string> | undefined;
  readonly lessonsReplace?: Readonly<Record<string, string>> | undefined;
  readonly lessonsAppend?: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
  readonly workingItemsReplace?: ReadonlyArray<WorkingItem> | undefined;
  readonly workingItemsUpsert?: ReadonlyArray<WorkingItemUpsertInput> | undefined;
  readonly workingClosures?: ReadonlyArray<WorkingClosureInput> | undefined;
  readonly pruneExpiredNowIso?: string | undefined;
  readonly expectedBaseHashes?: ReflectionExpectedBaseHashes | undefined;
  readonly reflectedThreadIds?: ReadonlyArray<string> | undefined;
  readonly statePatch?: Partial<Omit<PersonalState, "version">> | undefined;
}

export interface ReflectionUpdatesResult {
  readonly updatedFiles: ReadonlyArray<string>;
  readonly redactedCount: number;
  readonly state: PersonalState;
}
