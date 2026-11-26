import {
  isDelegatedAppThread,
  isListedThreadLineage,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { PersonalMemoryService } from "./PersonalMemoryService.ts";
import { normalizeMemoryScope, toProjectSlug } from "./personalPaths.ts";
import {
  PersonalReflectionError,
  buildDailyCompactPrompt,
  buildIncrementalReflectionPrompt,
  extractNewMessagesForReflection,
  formatMessageForReflection,
  hasSubstantiveMemoryForCompact,
  isMalformedReflectionOutput,
  isReflectableThreadMessages,
  parseReflectionOutput,
  pruneExpiredWorkingItems,
  toIsoTimestamp,
  type ParsedReflectionOutput,
  type ReflectNowInput,
  type ReflectionFormattedMessage,
  type ReflectionMode,
  type ReflectionRunResult,
  type ThreadMessageSlice,
} from "./personalReflector.ts";
import { sanitizePersonalText } from "./personalSanitizer.ts";
import type {
  PersonalState,
  ReflectionSnapshot,
  ReflectionUpdatesInput,
  ThreadReflectionCursor,
} from "./personalTypes.ts";

export interface PersonalReflectionServiceShape {
  readonly reflectNow: (
    input?: ReflectNowInput,
  ) => Effect.Effect<ReflectionRunResult, PersonalReflectionError>;
}

export class PersonalReflectionService extends Context.Service<
  PersonalReflectionService,
  PersonalReflectionServiceShape
>()("t3/personal/PersonalReflectionService") {}

export interface PersonalReflectionServiceOptions {
  readonly enableScheduler?: boolean | undefined;
  readonly initialDelayMs?: number | undefined;
  readonly incrementalIntervalMs?: number | undefined;
  readonly dailyCompactIntervalMs?: number | undefined;
}

const MAX_CANDIDATE_THREADS = 12;
const DEFAULT_INITIAL_DELAY_MS = 2 * 60 * 1000;
const DEFAULT_INCREMENTAL_INTERVAL_MS = 3 * 60 * 60 * 1000;
const DEFAULT_DAILY_COMPACT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatModelUsed(selection: ModelSelection): string {
  return `${selection.instanceId}:${selection.model}`;
}

export function isDailyCompactDue(
  snapshot: ReflectionSnapshot,
  nowMs: number,
  nowIso: string,
  intervalMs: number,
): boolean {
  const hasContent =
    hasSubstantiveMemoryForCompact(snapshot) ||
    pruneExpiredWorkingItems(snapshot.workingItems, nowIso).changed;
  if (!hasContent) {
    return false;
  }

  const lastCompact = snapshot.state.lastDailyCompactAt;
  if (lastCompact === null) {
    return true;
  }
  const parsed = DateTime.make(lastCompact);
  if (Option.isNone(parsed)) {
    return true;
  }
  return nowMs - DateTime.toEpochMillis(parsed.value) >= intervalMs;
}

const filterTruncatedReplacements = Effect.fn(
  "PersonalReflectionService.filterTruncatedReplacements",
)(function* (params: {
  readonly mode: ReflectionMode;
  readonly parsed: ParsedReflectionOutput;
  readonly truncatedProfile: boolean;
  readonly truncatedLessonScopes: ReadonlySet<string>;
}) {
  const { mode, parsed, truncatedProfile, truncatedLessonScopes } = params;

  let profile = parsed.profile;
  if (profile !== undefined && truncatedProfile) {
    yield* Effect.logWarning(
      "Rejecting profile_replace from reflection output because profile.md was truncated in prompt.",
      { mode },
    );
    profile = undefined;
  }

  let lessonsReplace: Readonly<Record<string, string>> | undefined;
  if (parsed.lessonsReplace !== undefined) {
    const kept: Record<string, string> = {};
    for (const [scope, content] of Object.entries(parsed.lessonsReplace)) {
      const normalizedScope = normalizeMemoryScope(scope);
      if (truncatedLessonScopes.has(normalizedScope) || truncatedLessonScopes.has(scope)) {
        yield* Effect.logWarning(
          "Rejecting lesson_replace from reflection output because lesson file was truncated or omitted in prompt.",
          { mode, scope: normalizedScope },
        );
        continue;
      }
      kept[normalizedScope] = content;
    }
    if (Object.keys(kept).length > 0) {
      lessonsReplace = kept;
    }
  }

  return { profile, lessonsReplace };
});

const isPersonalReflectionError = Schema.is(PersonalReflectionError);

function reflectionError(
  operation: string,
  detail: string,
): (cause: unknown) => PersonalReflectionError {
  return (cause) =>
    isPersonalReflectionError(cause)
      ? cause
      : new PersonalReflectionError({ operation, detail, cause });
}

const make = Effect.fn("PersonalReflectionService.make")(function* (
  options: PersonalReflectionServiceOptions = {},
) {
  const memory = yield* PersonalMemoryService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projectService = yield* ProjectService.ProjectService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runLock = yield* Semaphore.make(1);
  const inFlightCountRef = yield* Ref.make(0);

  const resolveReflectionModelSelection = Effect.fn(
    "PersonalReflectionService.resolveReflectionModelSelection",
  )(function* (state: PersonalState) {
    if (state.reflectionModelSelection != null) {
      return state.reflectionModelSelection;
    }
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        reflectionError("resolveModelSelection", "Could not read ServerSettings for reflection."),
      ),
    );
    return settings.defaultModelSelection ?? settings.textGenerationModelSelection;
  });

  const invokeReflectionModel = Effect.fn("PersonalReflectionService.invokeReflectionModel")(
    function* (operation: string, prompt: string, modelSelection: ModelSelection) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-personal-reflect-" });
          return yield* textGeneration.generateTranscriptionPostProcessing({
            cwd,
            prompt,
            modelSelection,
          });
        }),
      ).pipe(
        Effect.mapError(
          reflectionError(
            operation,
            `TextGeneration failed while running ${operation} with ${formatModelUsed(modelSelection)}.`,
          ),
        ),
      );
    },
  );

  const resolveProjectMeta = Effect.fn("PersonalReflectionService.resolveProjectMeta")(function* (
    projectId: ProjectId,
    cache: Map<ProjectId, { readonly slug: string; readonly title?: string | undefined }>,
  ) {
    const cached = cache.get(projectId);
    if (cached !== undefined) {
      return cached;
    }
    const projectOpt = yield* projectService.getById(projectId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to resolve project metadata during personal reflection.", {
          projectId,
          cause,
        }).pipe(Effect.as(Option.none())),
      ),
    );
    let meta: { readonly slug: string; readonly title?: string | undefined };
    if (Option.isSome(projectOpt)) {
      const project = projectOpt.value;
      const title = project.title.trim();
      const rootBase = path.basename(project.workspaceRoot);
      const slugSource = title.length > 0 ? title : rootBase.length > 0 ? rootBase : projectId;
      meta = {
        slug: toProjectSlug(slugSource),
        ...(title.length > 0 ? { title } : {}),
      };
    } else {
      meta = { slug: toProjectSlug(projectId) };
    }
    cache.set(projectId, meta);
    return meta;
  });

  const runIncremental = Effect.fn("PersonalReflectionService.runIncremental")(function* (
    snapshot: ReflectionSnapshot,
    now: DateTime.Utc,
    nowIso: string,
    lookbackDays?: number,
  ): Effect.fn.Return<ReflectionRunResult, PersonalReflectionError> {
    const hasLookback =
      lookbackDays !== undefined && Number.isFinite(lookbackDays) && lookbackDays > 0;
    const sinceMs = hasLookback
      ? DateTime.toEpochMillis(now) - Math.floor(lookbackDays * DAY_MS)
      : null;
    const sinceIso =
      sinceMs !== null ? DateTime.formatIso(DateTime.makeUnsafe(sinceMs)) : undefined;

    const listedThreads = yield* threadManagement
      .listProjectThreads({ includeSubagents: false })
      .pipe(
        Effect.mapError(
          reflectionError("listThreads", "Could not list project threads for reflection."),
        ),
      );

    const optOutSet = new Set(snapshot.state.optOutThreadIds);
    const sortedThreads = listedThreads.toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );

    const candidates = sortedThreads
      .filter((entry) => {
        if (optOutSet.has(entry.id)) {
          return false;
        }
        if (!isListedThreadLineage(entry.lineage) || isDelegatedAppThread(entry)) {
          return false;
        }
        if (sinceMs !== null) {
          return DateTime.toEpochMillis(entry.updatedAt) >= sinceMs;
        }
        const existingCursor = snapshot.state.threadCursors[entry.id];
        const updatedAtIso = DateTime.formatIso(entry.updatedAt);
        return existingCursor === undefined || existingCursor.lastUpdatedAt !== updatedAtIso;
      })
      .slice(0, MAX_CANDIDATE_THREADS);

    const projectCache = new Map<
      ProjectId,
      { readonly slug: string; readonly title?: string | undefined }
    >();
    const skippedCursors: Record<string, ThreadReflectionCursor> = {};
    const sliceMetaByThread = new Map<
      string,
      {
        readonly entryUpdatedAtIso: string;
        readonly existingCursor: ThreadReflectionCursor | undefined;
        readonly safeCount: number;
        readonly hasStreaming: boolean;
        readonly isRollback: boolean;
      }
    >();
    const slices: Array<ThreadMessageSlice> = [];
    let scannedThreads = 0;

    for (const entry of candidates) {
      const records = yield* threadManagement.getThreadRecords(entry.id, ["messages"]).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read thread records during personal reflection; skipping.", {
            threadId: entry.id,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (records === null) {
        continue;
      }

      scannedThreads += 1;
      const entryUpdatedAtIso = DateTime.formatIso(entry.updatedAt);
      const existingCursor = snapshot.state.threadCursors[entry.id];
      const firstStreamingIdx = records.messages.findIndex((msg) => msg.streaming === true);
      const hasStreaming = firstStreamingIdx !== -1;
      const safeCount = hasStreaming ? firstStreamingIdx : records.messages.length;
      const isRollback =
        existingCursor !== undefined && records.messages.length < existingCursor.lastMessageCount;
      const startIndex = isRollback
        ? 0
        : Math.max(0, Math.floor(existingCursor?.lastMessageCount ?? 0));
      const preservedLastUpdatedAt =
        existingCursor !== undefined && existingCursor.lastUpdatedAt !== entryUpdatedAtIso
          ? existingCursor.lastUpdatedAt
          : "";

      const makeSkippedCursor = (): ThreadReflectionCursor =>
        hasStreaming
          ? {
              lastMessageCount: safeCount,
              lastUpdatedAt: preservedLastUpdatedAt,
              lastReflectedAt: nowIso,
            }
          : {
              lastMessageCount:
                hasLookback && !isRollback
                  ? Math.max(existingCursor?.lastMessageCount ?? 0, safeCount)
                  : safeCount,
              lastUpdatedAt: entryUpdatedAtIso,
              lastReflectedAt: nowIso,
            };

      if (!isReflectableThreadMessages(records.thread, records.messages)) {
        skippedCursors[entry.id] = makeSkippedCursor();
        continue;
      }

      const extracted = extractNewMessagesForReflection(
        records.messages,
        sinceIso !== undefined
          ? { sinceIso, endIndex: safeCount }
          : { cursorLastCount: startIndex, endIndex: safeCount },
      );
      if (extracted.length === 0) {
        skippedCursors[entry.id] = makeSkippedCursor();
        continue;
      }

      const projectMeta = yield* resolveProjectMeta(entry.projectId, projectCache);
      const formattedMessages: Array<ReflectionFormattedMessage> = [];
      let threadRedacted = 0;

      for (const msg of extracted) {
        const formatted = formatMessageForReflection(msg.text, msg.role);
        threadRedacted += formatted.redactedCount;
        if (formatted.text.length > 0) {
          formattedMessages.push({
            role: msg.role,
            createdAt: toIsoTimestamp(msg.createdAt),
            text: formatted.text,
            redactedCount: formatted.redactedCount,
            originalIndex: msg.originalIndex,
          });
        }
      }

      if (formattedMessages.length === 0) {
        skippedCursors[entry.id] = makeSkippedCursor();
        continue;
      }

      sliceMetaByThread.set(entry.id, {
        entryUpdatedAtIso,
        existingCursor,
        safeCount,
        hasStreaming,
        isRollback,
      });
      slices.push({
        threadId: entry.id,
        title: records.thread.title,
        projectSlug: projectMeta.slug,
        ...(projectMeta.title !== undefined ? { projectTitle: projectMeta.title } : {}),
        updatedAt: entryUpdatedAtIso,
        totalMessageCount: safeCount,
        messages: formattedMessages,
        redactedCount: threadRedacted,
      });
    }

    if (slices.length === 0) {
      let updatedFiles: ReadonlyArray<string> = [];
      if (Object.keys(skippedCursors).length > 0) {
        const cursorResult = yield* memory
          .applyReflectionUpdates({
            reason: "reflection cursor advance",
            statePatch: {
              threadCursors: skippedCursors,
              lastIncrementalAt: nowIso,
            },
          })
          .pipe(
            Effect.mapError(
              reflectionError("applyCursorUpdate", "Failed to persist reflection cursors."),
            ),
          );
        updatedFiles = cursorResult.updatedFiles;
      }
      return {
        mode: "incremental",
        skipped: true,
        reason: "no_new_conversations",
        scannedThreads,
        reflectedThreads: 0,
        updatedFiles,
        redactedCount: 0,
      };
    }

    const modelSelection = yield* resolveReflectionModelSelection(snapshot.state);
    const promptResult = buildIncrementalReflectionPrompt({ snapshot, slices, nowIso });
    const finalPromptSanitized = sanitizePersonalText(promptResult.prompt);
    const promptRedactedCount = promptResult.redactedCount + finalPromptSanitized.redactedCount;

    const cursorsToPersist: Record<string, ThreadReflectionCursor> = { ...skippedCursors };
    const reflectedThreadIds: Array<string> = [];
    let includedSliceRedactedCount = 0;

    for (const slice of slices) {
      const meta = sliceMetaByThread.get(slice.threadId);
      if (meta === undefined) {
        continue;
      }
      const includedEndIndex = promptResult.includedEndIndexByThread.get(slice.threadId);
      if (includedEndIndex === undefined) {
        // Thread did not fit in the bounded prompt; never advance its cursor.
        continue;
      }
      reflectedThreadIds.push(slice.threadId);
      includedSliceRedactedCount += slice.redactedCount;

      const preservedLastUpdatedAt =
        meta.existingCursor !== undefined &&
        meta.existingCursor.lastUpdatedAt !== meta.entryUpdatedAtIso
          ? meta.existingCursor.lastUpdatedAt
          : "";

      if (promptResult.fullyIncludedThreadIds.has(slice.threadId)) {
        if (meta.hasStreaming) {
          cursorsToPersist[slice.threadId] = {
            lastMessageCount: meta.safeCount,
            lastUpdatedAt: preservedLastUpdatedAt,
            lastReflectedAt: nowIso,
          };
        } else {
          const nextCount =
            hasLookback && !meta.isRollback
              ? Math.max(meta.existingCursor?.lastMessageCount ?? 0, meta.safeCount)
              : meta.safeCount;
          cursorsToPersist[slice.threadId] = {
            lastMessageCount: nextCount,
            lastUpdatedAt: meta.entryUpdatedAtIso,
            lastReflectedAt: nowIso,
          };
        }
      } else {
        const nextCount =
          hasLookback && !meta.isRollback
            ? Math.min(
                meta.safeCount,
                Math.max(meta.existingCursor?.lastMessageCount ?? 0, includedEndIndex),
              )
            : Math.min(meta.safeCount, includedEndIndex);
        cursorsToPersist[slice.threadId] = {
          lastMessageCount: nextCount,
          lastUpdatedAt: preservedLastUpdatedAt,
          lastReflectedAt: nowIso,
        };
      }
    }

    if (reflectedThreadIds.length === 0) {
      return {
        mode: "incremental",
        skipped: true,
        reason: "no_new_conversations",
        scannedThreads,
        reflectedThreads: 0,
        updatedFiles: [],
        redactedCount: promptRedactedCount,
      };
    }

    const generated = yield* invokeReflectionModel(
      "generateIncrementalReflection",
      finalPromptSanitized.text,
      modelSelection,
    );

    const parsed = parseReflectionOutput(generated.transcription, nowIso);
    if (isMalformedReflectionOutput(generated.transcription, parsed)) {
      yield* Effect.logWarning(
        "Personal incremental reflection returned malformed XML tags; skipping persistence and cursor advance.",
        {
          modelUsed: formatModelUsed(modelSelection),
          reflectedThreads: reflectedThreadIds.length,
        },
      );
      return {
        mode: "incremental",
        skipped: true,
        reason: "malformed_reflection_output",
        scannedThreads,
        reflectedThreads: 0,
        updatedFiles: [],
        redactedCount: includedSliceRedactedCount + promptRedactedCount,
        modelUsed: formatModelUsed(modelSelection),
      };
    }

    const safeReplacements = yield* filterTruncatedReplacements({
      mode: "incremental",
      parsed,
      truncatedProfile: promptResult.truncatedProfile,
      truncatedLessonScopes: promptResult.truncatedLessonScopes,
    });

    const updates: ReflectionUpdatesInput = {
      reason: hasLookback
        ? `incremental reflection (lookback ${lookbackDays}d, ${reflectedThreadIds.length} threads)`
        : `incremental reflection (${reflectedThreadIds.length} threads)`,
      ...(safeReplacements.profile !== undefined ? { profile: safeReplacements.profile } : {}),
      ...(safeReplacements.lessonsReplace !== undefined
        ? { lessonsReplace: safeReplacements.lessonsReplace }
        : {}),
      ...(parsed.lessonsAppend !== undefined ? { lessonsAppend: parsed.lessonsAppend } : {}),
      ...(parsed.workingClosures.length > 0 ? { workingClosures: parsed.workingClosures } : {}),
      ...(parsed.workingItemsUpsert !== undefined
        ? { workingItemsUpsert: parsed.workingItemsUpsert }
        : {}),
      ...(snapshot.contentHashes !== undefined
        ? {
            expectedBaseHashes: {
              profile: snapshot.contentHashes.profile,
              lessons: snapshot.contentHashes.lessons,
            },
          }
        : {}),
      reflectedThreadIds,
      statePatch: {
        threadCursors: cursorsToPersist,
        lastIncrementalAt: nowIso,
      },
    };

    const applied = yield* memory
      .applyReflectionUpdates(updates)
      .pipe(
        Effect.mapError(
          reflectionError(
            "applyIncrementalUpdates",
            "Failed to persist incremental reflection updates.",
          ),
        ),
      );

    return {
      mode: "incremental",
      skipped: false,
      scannedThreads,
      reflectedThreads: reflectedThreadIds.length,
      updatedFiles: applied.updatedFiles,
      redactedCount: includedSliceRedactedCount + promptRedactedCount + applied.redactedCount,
      modelUsed: formatModelUsed(modelSelection),
    };
  });

  const runDailyCompact = Effect.fn("PersonalReflectionService.runDailyCompact")(function* (
    snapshot: ReflectionSnapshot,
    nowIso: string,
  ): Effect.fn.Return<ReflectionRunResult, PersonalReflectionError> {
    const pruned = pruneExpiredWorkingItems(snapshot.workingItems, nowIso);
    const effectiveSnapshot: ReflectionSnapshot = pruned.changed
      ? { ...snapshot, workingItems: pruned.items }
      : snapshot;

    if (!hasSubstantiveMemoryForCompact(effectiveSnapshot)) {
      let updatedFiles: ReadonlyArray<string> = [];
      let redactedCount = 0;
      if (pruned.changed) {
        const appliedPrune = yield* memory
          .applyReflectionUpdates({
            reason: "daily compact prune expired working items",
            pruneExpiredNowIso: nowIso,
            statePatch: { lastDailyCompactAt: nowIso },
          })
          .pipe(
            Effect.mapError(
              reflectionError(
                "applyDailyCompactPrune",
                "Failed to persist pruned working items during daily compact.",
              ),
            ),
          );
        updatedFiles = appliedPrune.updatedFiles;
        redactedCount = appliedPrune.redactedCount;
      }
      return {
        mode: "daily_compact",
        skipped: true,
        reason: "empty_memory",
        scannedThreads: 0,
        reflectedThreads: 0,
        updatedFiles,
        redactedCount,
      };
    }

    const modelSelection = yield* resolveReflectionModelSelection(snapshot.state);
    const promptResult = buildDailyCompactPrompt({ snapshot: effectiveSnapshot, nowIso });
    const finalPromptSanitized = sanitizePersonalText(promptResult.prompt);
    const promptRedactedCount = promptResult.redactedCount + finalPromptSanitized.redactedCount;

    const generated = yield* invokeReflectionModel(
      "generateDailyCompact",
      finalPromptSanitized.text,
      modelSelection,
    );

    const parsed = parseReflectionOutput(generated.transcription, nowIso);
    if (isMalformedReflectionOutput(generated.transcription, parsed)) {
      yield* Effect.logWarning(
        "Personal daily compact returned malformed XML tags; skipping persistence.",
        { modelUsed: formatModelUsed(modelSelection) },
      );
      return {
        mode: "daily_compact",
        skipped: true,
        reason: "malformed_reflection_output",
        scannedThreads: 0,
        reflectedThreads: 0,
        updatedFiles: [],
        redactedCount: promptRedactedCount,
        modelUsed: formatModelUsed(modelSelection),
      };
    }

    const safeReplacements = yield* filterTruncatedReplacements({
      mode: "daily_compact",
      parsed,
      truncatedProfile: promptResult.truncatedProfile,
      truncatedLessonScopes: promptResult.truncatedLessonScopes,
    });

    const updates: ReflectionUpdatesInput = {
      reason: "daily compact",
      ...(safeReplacements.profile !== undefined ? { profile: safeReplacements.profile } : {}),
      ...(safeReplacements.lessonsReplace !== undefined
        ? { lessonsReplace: safeReplacements.lessonsReplace }
        : {}),
      ...(parsed.lessonsAppend !== undefined ? { lessonsAppend: parsed.lessonsAppend } : {}),
      pruneExpiredNowIso: nowIso,
      ...(parsed.workingClosures.length > 0 ? { workingClosures: parsed.workingClosures } : {}),
      ...(parsed.workingItemsUpsert !== undefined
        ? { workingItemsUpsert: parsed.workingItemsUpsert }
        : {}),
      ...(snapshot.contentHashes !== undefined
        ? {
            expectedBaseHashes: {
              profile: snapshot.contentHashes.profile,
              lessons: snapshot.contentHashes.lessons,
            },
          }
        : {}),
      statePatch: {
        lastDailyCompactAt: nowIso,
      },
    };

    const applied = yield* memory
      .applyReflectionUpdates(updates)
      .pipe(
        Effect.mapError(
          reflectionError(
            "applyDailyCompactUpdates",
            "Failed to persist daily compact reflection updates.",
          ),
        ),
      );

    return {
      mode: "daily_compact",
      skipped: false,
      scannedThreads: 0,
      reflectedThreads: 0,
      updatedFiles: applied.updatedFiles,
      redactedCount: promptRedactedCount + applied.redactedCount,
      modelUsed: formatModelUsed(modelSelection),
    };
  });

  const executeReflection = Effect.fn("PersonalReflectionService.executeReflection")(function* (
    input?: ReflectNowInput,
  ): Effect.fn.Return<ReflectionRunResult, PersonalReflectionError> {
    const mode: ReflectionMode = input?.mode ?? "incremental";
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const snapshot = yield* memory
      .readSnapshotForReflection()
      .pipe(
        Effect.mapError(
          reflectionError("readSnapshot", "Failed to read personal memory snapshot."),
        ),
      );

    if (mode === "daily_compact") {
      return yield* runDailyCompact(snapshot, nowIso);
    }
    return yield* runIncremental(snapshot, now, nowIso, input?.lookbackDays);
  });

  const reflectNow: PersonalReflectionServiceShape["reflectNow"] = Effect.fn(
    "PersonalReflectionService.reflectNow",
  )(function* (input?: ReflectNowInput) {
    return yield* Effect.acquireUseRelease(
      Ref.update(inFlightCountRef, (count) => count + 1),
      () => runLock.withPermit(executeReflection(input)),
      () => Ref.update(inFlightCountRef, (count) => Math.max(0, count - 1)),
    );
  });

  const reflectIfIdle = Effect.fn("PersonalReflectionService.reflectIfIdle")(function* (
    input: ReflectNowInput,
  ): Effect.fn.Return<ReflectionRunResult, PersonalReflectionError> {
    const mode: ReflectionMode = input.mode ?? "incremental";
    return yield* Effect.acquireUseRelease(
      Ref.modify(inFlightCountRef, (count) =>
        count > 0 ? ([false, count] as const) : ([true, count + 1] as const),
      ),
      (acquired) =>
        acquired
          ? runLock.withPermit(executeReflection(input))
          : Effect.succeed({
              mode,
              skipped: true,
              reason: "already_running",
              scannedThreads: 0,
              reflectedThreads: 0,
              updatedFiles: [],
              redactedCount: 0,
            } satisfies ReflectionRunResult),
      (acquired) =>
        acquired ? Ref.update(inFlightCountRef, (count) => Math.max(0, count - 1)) : Effect.void,
    );
  });

  const enableScheduler = options.enableScheduler ?? true;
  if (enableScheduler) {
    const initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
    const incrementalIntervalMs = Math.max(
      10,
      options.incrementalIntervalMs ?? DEFAULT_INCREMENTAL_INTERVAL_MS,
    );
    const dailyCompactIntervalMs = Math.max(
      10,
      options.dailyCompactIntervalMs ?? DEFAULT_DAILY_COMPACT_INTERVAL_MS,
    );

    const runScheduledTick = Effect.fn("PersonalReflectionService.scheduledTick")(function* () {
      const incrementalResult = yield* reflectIfIdle({ mode: "incremental" }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Scheduled incremental personal reflection failed.", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (incrementalResult !== null && incrementalResult.reason === "already_running") {
        return;
      }

      const snapshot = yield* memory.readSnapshotForReflection().pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read snapshot for scheduled daily compact.", {
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (snapshot === null) {
        return;
      }

      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const nowIso = DateTime.formatIso(now);
      if (isDailyCompactDue(snapshot, nowMs, nowIso, dailyCompactIntervalMs)) {
        yield* reflectIfIdle({ mode: "daily_compact" }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Scheduled daily personal compact failed.", { cause }).pipe(
              Effect.asVoid,
            ),
          ),
        );
      }
    });

    const schedulerLoop = Effect.gen(function* () {
      if (initialDelayMs > 0) {
        yield* Effect.sleep(Duration.millis(initialDelayMs));
      }
      while (true) {
        const exit = yield* Effect.exit(runScheduledTick());
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterrupts(exit.cause)) {
            return yield* Effect.failCause(exit.cause);
          }
          yield* Effect.logWarning("Unexpected personal reflection scheduler failure.", {
            cause: exit.cause,
          });
        }
        yield* Effect.sleep(Duration.millis(incrementalIntervalMs));
      }
    });

    yield* Effect.forkScoped(schedulerLoop);
  }

  return PersonalReflectionService.of({
    reflectNow,
  });
});

export const makeLayer = (
  options: PersonalReflectionServiceOptions = {},
): Layer.Layer<
  PersonalReflectionService,
  never,
  | PersonalMemoryService
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
  | TextGeneration.TextGeneration
  | ServerSettings.ServerSettingsService
  | FileSystem.FileSystem
  | Path.Path
> => Layer.effect(PersonalReflectionService, make(options));

export const layer = makeLayer({ enableScheduler: true });
