import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { buildPersonalContextBlock } from "./personalContext.ts";
import { derivePersonalPaths } from "./personalPaths.ts";
import { createPersonalStore } from "./personalStore.ts";
import type {
  AddNoteInput,
  AddNoteResult,
  MemorySearchInput,
  MemorySearchMatch,
  PersonalContextBuildInput,
  PersonalState,
  PersonalStoreError,
  ReflectionSnapshot,
  ReflectionUpdatesInput,
  ReflectionUpdatesResult,
  WorkingItem,
  WorkingUpdateAction,
} from "./personalTypes.ts";

export interface PersonalMemoryServiceShape {
  /** Builds the bounded `<personal_context>` prompt block. Degrades to `""` on any failure. */
  readonly buildTurnContext: (input: PersonalContextBuildInput) => Effect.Effect<string>;
  readonly searchMemory: (
    input: MemorySearchInput,
  ) => Effect.Effect<ReadonlyArray<MemorySearchMatch>, PersonalStoreError>;
  readonly addNote: (input: AddNoteInput) => Effect.Effect<AddNoteResult, PersonalStoreError>;
  readonly updateWorkingItem: (
    id: string,
    action: WorkingUpdateAction,
  ) => Effect.Effect<WorkingItem | null, PersonalStoreError>;
  readonly setThreadOptOut: (
    threadId: string,
    optOut: boolean,
  ) => Effect.Effect<PersonalState, PersonalStoreError>;
  readonly isThreadOptOut: (threadId: string) => Effect.Effect<boolean, PersonalStoreError>;
  readonly readState: () => Effect.Effect<PersonalState, PersonalStoreError>;
  readonly updateState: (
    updater: (current: PersonalState) => PersonalState,
    reason?: string,
  ) => Effect.Effect<PersonalState, PersonalStoreError>;
  readonly readSnapshotForReflection: () => Effect.Effect<ReflectionSnapshot, PersonalStoreError>;
  /** Atomically applies reflection updates (profile/guardrails/lessons/working/state) in one git snapshot. */
  readonly applyReflectionUpdates: (
    input: ReflectionUpdatesInput,
  ) => Effect.Effect<ReflectionUpdatesResult, PersonalStoreError>;
}

export class PersonalMemoryService extends Context.Service<
  PersonalMemoryService,
  PersonalMemoryServiceShape
>()("t3/personal/PersonalMemoryService") {}

const make = Effect.gen(function* () {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const writeLock = yield* Semaphore.make(1);

  const paths = derivePersonalPaths(baseDir, path);
  const store = createPersonalStore({ paths, fs, path, spawner });
  let initialized = false;

  const ensureReady = Effect.fn("PersonalMemoryService.ensureReady")(function* () {
    if (initialized) {
      return;
    }
    yield* writeLock.withPermit(
      Effect.gen(function* () {
        if (initialized) {
          return;
        }
        yield* store.ensureInitialized();
        initialized = true;
      }),
    );
  });

  const buildTurnContext = Effect.fn("PersonalMemoryService.buildTurnContext")(function* (
    input: PersonalContextBuildInput,
  ) {
    return yield* Effect.gen(function* () {
      yield* ensureReady();
      const state = yield* store.readState();
      if (state.optOutThreadIds.includes(input.threadId)) {
        return "";
      }
      const [guardrails, profile, workingItems] = yield* Effect.all(
        [store.readGuardrails(), store.readProfile(), store.readWorkingItems()],
        { concurrency: "unbounded" },
      );
      return buildPersonalContextBlock({
        input,
        isOptOut: false,
        guardrails,
        profile,
        workingItems,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to build personal turn context; degrading to empty block.", {
          threadId: input.threadId,
          cause,
        }).pipe(Effect.as("")),
      ),
    );
  });

  const searchMemory = Effect.fn("PersonalMemoryService.searchMemory")(function* (
    input: MemorySearchInput,
  ) {
    yield* ensureReady();
    return yield* store.searchMemory(input);
  });

  const addNote = Effect.fn("PersonalMemoryService.addNote")(function* (input: AddNoteInput) {
    return yield* writeLock.withPermit(
      Effect.gen(function* () {
        const result = yield* store.addNote(input);
        initialized = true;
        return result;
      }),
    );
  });

  const updateWorkingItem = Effect.fn("PersonalMemoryService.updateWorkingItem")(function* (
    id: string,
    action: WorkingUpdateAction,
  ) {
    return yield* writeLock.withPermit(
      Effect.gen(function* () {
        const result = yield* store.updateWorkingItemStatus(id, action);
        initialized = true;
        return result;
      }),
    );
  });

  const setThreadOptOut = Effect.fn("PersonalMemoryService.setThreadOptOut")(function* (
    threadId: string,
    optOut: boolean,
  ) {
    return yield* writeLock.withPermit(
      Effect.gen(function* () {
        const result = yield* store.setThreadOptOut(threadId, optOut);
        initialized = true;
        return result;
      }),
    );
  });

  const isThreadOptOut = Effect.fn("PersonalMemoryService.isThreadOptOut")(function* (
    threadId: string,
  ) {
    yield* ensureReady();
    const state = yield* store.readState();
    return state.optOutThreadIds.includes(threadId);
  });

  const readState = Effect.fn("PersonalMemoryService.readState")(function* () {
    yield* ensureReady();
    return yield* store.readState();
  });

  const updateState = Effect.fn("PersonalMemoryService.updateState")(function* (
    updater: (current: PersonalState) => PersonalState,
    reason?: string,
  ) {
    return yield* writeLock.withPermit(
      Effect.gen(function* () {
        const result = yield* store.updateState(updater, reason);
        initialized = true;
        return result;
      }),
    );
  });

  const readSnapshotForReflection = Effect.fn("PersonalMemoryService.readSnapshotForReflection")(
    function* () {
      return yield* writeLock.withPermit(
        Effect.gen(function* () {
          const snapshot = yield* store.readSnapshotForReflection();
          initialized = true;
          return snapshot;
        }),
      );
    },
  );

  const applyReflectionUpdates = Effect.fn("PersonalMemoryService.applyReflectionUpdates")(
    function* (input: ReflectionUpdatesInput) {
      return yield* writeLock.withPermit(
        Effect.gen(function* () {
          const result = yield* store.applyReflectionUpdates(input);
          initialized = true;
          return result;
        }),
      );
    },
  );

  return PersonalMemoryService.of({
    buildTurnContext,
    searchMemory,
    addNote,
    updateWorkingItem,
    setThreadOptOut,
    isThreadOptOut,
    readState,
    updateState,
    readSnapshotForReflection,
    applyReflectionUpdates,
  });
});

export const layer: Layer.Layer<
  PersonalMemoryService,
  never,
  | ServerConfig.ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(PersonalMemoryService, make);
