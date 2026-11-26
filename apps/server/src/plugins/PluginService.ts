import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";
import * as Mime from "effect/http/Mime";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  type CtPluginManifest,
  isPathWithinRoot,
  isValidPluginId,
  parsePluginManifestJson,
  PLUGIN_MANIFEST_FILENAME,
  type PluginAssetPayload,
  type PluginBackendEndpoint,
  PluginError,
  type PluginInstallRequest,
  type PluginRecordView,
  type PluginRegistryFile,
  type PluginRegistryRecord,
  type PluginUninstallRequest,
  type PluginUpdateRequest,
  type PluginUpdateResult,
  resolveSafePluginSubpath,
  safeParseJson,
  safeStringifyJson,
} from "./pluginContract.ts";
import {
  cloneGitPlugin,
  runPluginBuild,
  updateGitPlugin,
  validateLocalPluginDirectory,
} from "./pluginGitInstaller.ts";
import {
  makePluginProcessManager,
  type PluginProcessManagerOptions,
} from "./pluginProcessManager.ts";

export interface PluginServiceShape {
  readonly list: () => Effect.Effect<ReadonlyArray<PluginRecordView>>;
  readonly install: (input: PluginInstallRequest) => Effect.Effect<PluginRecordView, PluginError>;
  readonly setEnabled: (
    pluginId: string,
    enabled: boolean,
  ) => Effect.Effect<PluginRecordView, PluginError>;
  readonly update: (
    pluginId: string,
    options?: PluginUpdateRequest,
  ) => Effect.Effect<PluginUpdateResult, PluginError>;
  readonly reload: (pluginId: string) => Effect.Effect<PluginRecordView, PluginError>;
  readonly uninstall: (
    pluginId: string,
    options?: PluginUninstallRequest,
  ) => Effect.Effect<{ readonly uninstalled: string }, PluginError>;
  readonly readAsset: (
    pluginId: string,
    assetPath: string,
  ) => Effect.Effect<PluginAssetPayload, PluginError>;
  readonly ensureBackendReady: (
    pluginId: string,
  ) => Effect.Effect<PluginBackendEndpoint, PluginError>;
}

interface LoadedManifestState {
  readonly manifest: CtPluginManifest | null;
  readonly manifestError: string | null;
}

const EXPLICIT_ASSET_MIME_TYPES: Readonly<Record<string, string>> = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function resolveAssetContentType(filePath: string, pathApi: Path.Path): string {
  const ext = pathApi.extname(filePath).toLowerCase();
  const explicit = EXPLICIT_ASSET_MIME_TYPES[ext];
  if (explicit !== undefined) {
    return explicit;
  }
  return Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream");
}

function normalizeRegistryFile(raw: unknown): PluginRegistryRecord[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [];
  }
  const candidate = raw as Partial<PluginRegistryFile>;
  if (!Array.isArray(candidate.plugins)) {
    return [];
  }
  const records: PluginRegistryRecord[] = [];
  const seen = new Set<string>();
  for (const item of candidate.plugins) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Partial<PluginRegistryRecord>;
    if (
      typeof record.id !== "string" ||
      !isValidPluginId(record.id) ||
      seen.has(record.id) ||
      typeof record.rootDir !== "string" ||
      record.rootDir.length === 0 ||
      typeof record.enabled !== "boolean" ||
      typeof record.installedAt !== "string" ||
      typeof record.updatedAt !== "string" ||
      typeof record.reloadNonce !== "number" ||
      !Number.isInteger(record.reloadNonce) ||
      record.reloadNonce < 0 ||
      typeof record.source !== "object" ||
      record.source === null
    ) {
      continue;
    }
    if (record.source.kind === "git" && typeof record.source.url === "string") {
      seen.add(record.id);
      records.push({
        id: record.id,
        source: {
          kind: "git",
          url: record.source.url,
          ...(typeof record.source.ref === "string" ? { ref: record.source.ref } : {}),
          ...(typeof record.source.commit === "string" ? { commit: record.source.commit } : {}),
        },
        rootDir: record.rootDir,
        enabled: record.enabled,
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
        reloadNonce: record.reloadNonce,
      });
    } else if (record.source.kind === "local" && typeof record.source.path === "string") {
      seen.add(record.id);
      records.push({
        id: record.id,
        source: {
          kind: "local",
          path: record.source.path,
        },
        rootDir: record.rootDir,
        enabled: record.enabled,
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
        reloadNonce: record.reloadNonce,
      });
    }
  }
  return records;
}

const makePluginService = Effect.fn("PluginService.make")(function* (
  processOptions?: PluginProcessManagerOptions,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathApi = yield* Path.Path;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const processManager = yield* makePluginProcessManager(processOptions);
  const runtimeContext = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
  >();
  const withRuntime = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner>,
  ): Effect.Effect<A, E> => Effect.provideContext(effect, runtimeContext);

  const pluginsDir = pathApi.join(serverConfig.stateDir, "plugins");
  const registryPath = pathApi.join(pluginsDir, "registry.json");
  const installedDir = pathApi.join(pluginsDir, "installed");
  const stagingDir = pathApi.join(pluginsDir, ".staging");
  const pluginDataBaseDir = pathApi.join(serverConfig.stateDir, "plugin-data");

  yield* Effect.all(
    [
      fs.makeDirectory(pluginsDir, { recursive: true, mode: 0o700 }),
      fs.makeDirectory(installedDir, { recursive: true, mode: 0o700 }),
      fs.makeDirectory(pluginDataBaseDir, { recursive: true, mode: 0o700 }),
    ],
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.ignore);

  const mutationLock = Semaphore.makeUnsafe(1);
  const records = new Map<string, PluginRegistryRecord>();
  const manifestCache = new Map<string, LoadedManifestState>();

  const pluginDataDirFor = (pluginId: string): string => pathApi.join(pluginDataBaseDir, pluginId);

  const readManifestFromDisk = Effect.fn("PluginService.readManifestFromDisk")(function* (
    rootDir: string,
    expectedId?: string,
  ): Effect.fn.Return<LoadedManifestState> {
    const manifestPath = pathApi.join(rootDir, PLUGIN_MANIFEST_FILENAME);
    const exists = yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return {
        manifest: null,
        manifestError: `Missing ${PLUGIN_MANIFEST_FILENAME} in ${rootDir}`,
      };
    }
    const rawText = yield* fs.readFileString(manifestPath).pipe(
      Effect.map((content) => ({ ok: true as const, content })),
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false as const,
          error: `Failed to read ${PLUGIN_MANIFEST_FILENAME}: ${cause.message}`,
        }),
      ),
    );
    if (!rawText.ok) {
      return { manifest: null, manifestError: rawText.error };
    }

    const parsed = parsePluginManifestJson(rawText.content);
    if (!parsed.ok) {
      return { manifest: null, manifestError: parsed.error };
    }
    if (expectedId !== undefined && parsed.manifest.id !== expectedId) {
      return {
        manifest: null,
        manifestError: `Manifest id "${parsed.manifest.id}" does not match installed plugin id "${expectedId}".`,
      };
    }
    return { manifest: parsed.manifest, manifestError: null };
  });

  const checkUiReady = Effect.fn("PluginService.checkUiReady")(function* (
    rootDir: string,
    manifest: CtPluginManifest | null,
  ) {
    if (!manifest?.ui) {
      return false;
    }
    const entryResolved = yield* resolveSafePluginSubpath(
      rootDir,
      manifest.ui.entry,
      "ui.entry",
      fs,
      pathApi,
      { requireExisting: true },
    ).pipe(Effect.option);
    if (Option.isNone(entryResolved)) {
      return false;
    }
    const entryStat = yield* fs
      .stat(entryResolved.value.resolvedPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (!entryStat || entryStat.type !== "File") {
      return false;
    }

    if (manifest.ui.css !== undefined) {
      const cssResolved = yield* resolveSafePluginSubpath(
        rootDir,
        manifest.ui.css,
        "ui.css",
        fs,
        pathApi,
        { requireExisting: true },
      ).pipe(Effect.option);
      if (Option.isNone(cssResolved)) {
        return false;
      }
      const cssStat = yield* fs
        .stat(cssResolved.value.resolvedPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!cssStat || cssStat.type !== "File") {
        return false;
      }
    }

    return true;
  });

  const persistRegistry = Effect.fn("PluginService.persistRegistry")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const randomSuffix = Buffer.from(yield* secureRandom.randomBytes(4)).toString("hex");
    const payload: PluginRegistryFile = {
      version: 1,
      plugins: [...records.values()],
    };
    yield* fs.makeDirectory(pluginsDir, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(
        (cause) =>
          new PluginError({
            code: "internal_error",
            message: `Failed to create plugins directory: ${cause.message}`,
            status: 500,
          }),
      ),
    );
    const tmpPath = `${registryPath}.${nowMs}.${randomSuffix}.tmp`;
    yield* fs.writeFileString(tmpPath, safeStringifyJson(payload), { mode: 0o600 }).pipe(
      Effect.andThen(fs.rename(tmpPath, registryPath)),
      Effect.mapError(
        (cause) =>
          new PluginError({
            code: "internal_error",
            message: `Failed to persist plugin registry: ${cause.message}`,
            status: 500,
          }),
      ),
    );
  });

  const toRecordView = Effect.fn("PluginService.toRecordView")(function* (
    record: PluginRegistryRecord,
  ): Effect.fn.Return<PluginRecordView> {
    const cached =
      manifestCache.get(record.id) ?? (yield* readManifestFromDisk(record.rootDir, record.id));
    manifestCache.set(record.id, cached);

    const uiReady = yield* checkUiReady(record.rootDir, cached.manifest);
    const backend = processManager.getStatus(record.id, cached.manifest?.backend);
    return {
      id: record.id,
      source: record.source,
      rootDir: record.rootDir,
      enabled: record.enabled,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      reloadNonce: record.reloadNonce,
      manifest: cached.manifest,
      manifestError: cached.manifestError,
      uiReady,
      backend,
    };
  });

  const maybeStartStartupBackend = Effect.fn("PluginService.maybeStartStartupBackend")(function* (
    record: PluginRegistryRecord,
    manifest: CtPluginManifest | null,
  ) {
    if (!record.enabled || !manifest?.backend || manifest.backend.activation !== "startup") {
      return;
    }
    yield* processManager
      .ensureRunning({
        pluginId: record.id,
        rootDir: record.rootDir,
        dataDir: pluginDataDirFor(record.id),
        backend: manifest.backend,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Failed to start startup backend for plugin "${record.id}".`, {
            pluginId: record.id,
            error: error.message,
          }),
        ),
      );
  });

  const requireRecord = Effect.fn("PluginService.requireRecord")(function* (pluginId: string) {
    if (!isValidPluginId(pluginId)) {
      return yield* new PluginError({
        code: "invalid_request",
        message: `Invalid plugin id "${pluginId}".`,
        status: 400,
      });
    }
    const record = records.get(pluginId);
    if (!record) {
      return yield* new PluginError({
        code: "not_found",
        message: `Plugin "${pluginId}" is not installed.`,
        status: 404,
      });
    }
    return record;
  });

  // Hydrate persisted registry on service startup.
  const registryExists = yield* fs.exists(registryPath).pipe(Effect.orElseSucceed(() => false));
  if (registryExists) {
    const rawRegistry = yield* fs.readFileString(registryPath).pipe(Effect.orElseSucceed(() => ""));
    const loadedRecords = normalizeRegistryFile(safeParseJson<unknown>(rawRegistry, {}));
    for (const record of loadedRecords) {
      records.set(record.id, record);
      const manifestState = yield* readManifestFromDisk(record.rootDir, record.id);
      manifestCache.set(record.id, manifestState);
    }
  }

  // Ensure every plugin backend child process stops gracefully when CT Code server shuts down.
  yield* Effect.addFinalizer(() => processManager.stopAll());

  // Launch enabled `startup` plugin backends in the background so server boot is never blocked.
  for (const record of records.values()) {
    const manifestState = manifestCache.get(record.id);
    if (record.enabled && manifestState?.manifest?.backend?.activation === "startup") {
      yield* maybeStartStartupBackend(record, manifestState.manifest).pipe(Effect.forkScoped);
    }
  }

  const list: PluginServiceShape["list"] = Effect.fn("PluginService.list")(function* () {
    const current = [...records.values()];
    return yield* Effect.forEach(current, (record) => toRecordView(record), {
      concurrency: 4,
    });
  });

  const install: PluginServiceShape["install"] = Effect.fn("PluginService.install")(function* (
    input: PluginInstallRequest,
  ) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const nowIso = DateTime.formatIso(yield* DateTime.now);

        if (input.source === "local") {
          const rootDir = yield* withRuntime(validateLocalPluginDirectory(input.path));
          const loaded = yield* readManifestFromDisk(rootDir);
          if (!loaded.manifest) {
            return yield* new PluginError({
              code: "invalid_manifest",
              message: loaded.manifestError ?? `Invalid ${PLUGIN_MANIFEST_FILENAME}.`,
              status: 400,
            });
          }
          const pluginId = loaded.manifest.id;
          if (records.has(pluginId)) {
            return yield* new PluginError({
              code: "conflict",
              message: `Plugin "${pluginId}" is already installed.`,
              status: 409,
            });
          }

          yield* fs
            .makeDirectory(pluginDataDirFor(pluginId), { recursive: true, mode: 0o700 })
            .pipe(Effect.ignore);

          if (input.runBuild === true && loaded.manifest.build?.command) {
            yield* withRuntime(
              runPluginBuild({
                rootDir,
                command: loaded.manifest.build.command,
              }),
            );
          }

          const refreshed = yield* readManifestFromDisk(rootDir, pluginId);
          const record: PluginRegistryRecord = {
            id: pluginId,
            source: { kind: "local", path: rootDir },
            rootDir,
            enabled: true,
            installedAt: nowIso,
            updatedAt: nowIso,
            reloadNonce: 0,
          };
          records.set(pluginId, record);
          manifestCache.set(pluginId, refreshed);
          yield* persistRegistry();
          yield* maybeStartStartupBackend(record, refreshed.manifest);
          return yield* toRecordView(record);
        }

        if (input.source === "git") {
          yield* fs.makeDirectory(stagingDir, { recursive: true, mode: 0o700 }).pipe(
            Effect.mapError(
              (cause) =>
                new PluginError({
                  code: "internal_error",
                  message: `Failed to create plugin staging directory: ${cause.message}`,
                  status: 500,
                }),
            ),
          );
          const stagingName = `clone-${Buffer.from(yield* secureRandom.randomBytes(8)).toString("hex")}`;
          const tempDir = pathApi.join(stagingDir, stagingName);
          const cleanupTemp = fs
            .remove(tempDir, { recursive: true, force: true })
            .pipe(Effect.ignore);

          const cloned = yield* withRuntime(
            cloneGitPlugin({
              url: input.url,
              ref: input.ref,
              destinationDir: tempDir,
            }),
          ).pipe(Effect.tapError(() => cleanupTemp));

          const loaded = yield* readManifestFromDisk(tempDir);
          if (!loaded.manifest) {
            yield* cleanupTemp;
            return yield* new PluginError({
              code: "invalid_manifest",
              message: loaded.manifestError ?? `Invalid ${PLUGIN_MANIFEST_FILENAME}.`,
              status: 400,
            });
          }

          const pluginId = loaded.manifest.id;
          if (records.has(pluginId)) {
            yield* cleanupTemp;
            return yield* new PluginError({
              code: "conflict",
              message: `Plugin "${pluginId}" is already installed.`,
              status: 409,
            });
          }

          const targetDir = pathApi.join(installedDir, pluginId);
          yield* fs.remove(targetDir, { recursive: true, force: true }).pipe(Effect.ignore);
          yield* fs.rename(tempDir, targetDir).pipe(
            Effect.tapError(() => cleanupTemp),
            Effect.mapError(
              (cause) =>
                new PluginError({
                  code: "internal_error",
                  message: `Failed to move cloned plugin into place: ${cause.message}`,
                  status: 500,
                }),
            ),
          );

          const realTargetDir = yield* fs
            .realPath(targetDir)
            .pipe(Effect.orElseSucceed(() => targetDir));

          if (input.runBuild === true && loaded.manifest.build?.command) {
            yield* withRuntime(
              runPluginBuild({
                rootDir: realTargetDir,
                command: loaded.manifest.build.command,
              }),
            ).pipe(
              Effect.tapError(() =>
                fs.remove(realTargetDir, { recursive: true, force: true }).pipe(Effect.ignore),
              ),
            );
          }

          yield* fs
            .makeDirectory(pluginDataDirFor(pluginId), { recursive: true, mode: 0o700 })
            .pipe(Effect.ignore);

          const refreshed = yield* readManifestFromDisk(realTargetDir, pluginId);
          const record: PluginRegistryRecord = {
            id: pluginId,
            source: {
              kind: "git",
              url: cloned.url,
              ...(cloned.ref !== undefined ? { ref: cloned.ref } : {}),
              ...(cloned.commit !== undefined ? { commit: cloned.commit } : {}),
            },
            rootDir: realTargetDir,
            enabled: true,
            installedAt: nowIso,
            updatedAt: nowIso,
            reloadNonce: 0,
          };
          records.set(pluginId, record);
          manifestCache.set(pluginId, refreshed);
          yield* persistRegistry();
          yield* maybeStartStartupBackend(record, refreshed.manifest);
          return yield* toRecordView(record);
        }

        return yield* new PluginError({
          code: "invalid_request",
          message: 'Install request must specify source "git" or "local".',
          status: 400,
        });
      }),
    );
  });

  const setEnabled: PluginServiceShape["setEnabled"] = Effect.fn("PluginService.setEnabled")(
    function* (pluginId: string, enabled: boolean) {
      return yield* mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* requireRecord(pluginId);
          const nowIso = DateTime.formatIso(yield* DateTime.now);
          const updatedRecord: PluginRegistryRecord = {
            ...existing,
            enabled,
            updatedAt: nowIso,
          };
          records.set(pluginId, updatedRecord);
          yield* persistRegistry();

          if (!enabled) {
            yield* processManager.stop(pluginId);
          } else {
            const cached =
              manifestCache.get(pluginId) ??
              (yield* readManifestFromDisk(updatedRecord.rootDir, pluginId));
            manifestCache.set(pluginId, cached);
            yield* maybeStartStartupBackend(updatedRecord, cached.manifest);
          }

          return yield* toRecordView(updatedRecord);
        }),
      );
    },
  );

  const update: PluginServiceShape["update"] = Effect.fn("PluginService.update")(function* (
    pluginId: string,
    options?: PluginUpdateRequest,
  ) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* requireRecord(pluginId);
        if (existing.source.kind !== "git") {
          return yield* new PluginError({
            code: "invalid_request",
            message: `Plugin "${pluginId}" is installed from a local directory and cannot be git-updated.`,
            status: 400,
          });
        }

        const wasActive = processManager.isActive(pluginId);
        const gitResult = yield* withRuntime(
          updateGitPlugin({
            repoDir: existing.rootDir,
            ref: existing.source.ref,
          }),
        );

        const loaded = yield* readManifestFromDisk(existing.rootDir, pluginId);
        if (options?.runBuild === true && loaded.manifest?.build?.command) {
          yield* withRuntime(
            runPluginBuild({
              rootDir: existing.rootDir,
              command: loaded.manifest.build.command,
            }),
          );
        }

        const refreshed = yield* readManifestFromDisk(existing.rootDir, pluginId);
        manifestCache.set(pluginId, refreshed);

        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const updatedRecord: PluginRegistryRecord = {
          ...existing,
          source: {
            ...existing.source,
            ...(gitResult.commit !== undefined ? { commit: gitResult.commit } : {}),
          },
          updatedAt: nowIso,
          reloadNonce:
            gitResult.updated || options?.runBuild === true
              ? existing.reloadNonce + 1
              : existing.reloadNonce,
        };
        records.set(pluginId, updatedRecord);
        yield* persistRegistry();

        if (!updatedRecord.enabled || !refreshed.manifest?.backend) {
          yield* processManager.stop(pluginId);
        } else if (wasActive || refreshed.manifest.backend.activation === "startup") {
          yield* processManager
            .restart({
              pluginId,
              rootDir: updatedRecord.rootDir,
              dataDir: pluginDataDirFor(pluginId),
              backend: refreshed.manifest.backend,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `Failed to restart backend for plugin "${pluginId}" after update.`,
                  {
                    pluginId,
                    error: error.message,
                  },
                ),
              ),
            );
        }

        const view = yield* toRecordView(updatedRecord);
        return {
          plugin: view,
          updated: gitResult.updated,
          ...(gitResult.commit !== undefined ? { commit: gitResult.commit } : {}),
        } satisfies PluginUpdateResult;
      }),
    );
  });

  const reload: PluginServiceShape["reload"] = Effect.fn("PluginService.reload")(function* (
    pluginId: string,
  ) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* requireRecord(pluginId);
        const wasActive = processManager.isActive(pluginId);
        const refreshed = yield* readManifestFromDisk(existing.rootDir, pluginId);
        manifestCache.set(pluginId, refreshed);

        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const updatedRecord: PluginRegistryRecord = {
          ...existing,
          updatedAt: nowIso,
          reloadNonce: existing.reloadNonce + 1,
        };
        records.set(pluginId, updatedRecord);
        yield* persistRegistry();

        if (!updatedRecord.enabled || !refreshed.manifest?.backend) {
          yield* processManager.stop(pluginId);
        } else if (wasActive || refreshed.manifest.backend.activation === "startup") {
          yield* processManager
            .restart({
              pluginId,
              rootDir: updatedRecord.rootDir,
              dataDir: pluginDataDirFor(pluginId),
              backend: refreshed.manifest.backend,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(`Failed to restart backend for plugin "${pluginId}" on reload.`, {
                  pluginId,
                  error: error.message,
                }),
              ),
            );
        }

        return yield* toRecordView(updatedRecord);
      }),
    );
  });

  const uninstall: PluginServiceShape["uninstall"] = Effect.fn("PluginService.uninstall")(
    function* (pluginId: string, options?: PluginUninstallRequest) {
      return yield* mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* requireRecord(pluginId);
          yield* processManager.stop(pluginId);

          records.delete(pluginId);
          manifestCache.delete(pluginId);
          yield* persistRegistry();

          if (existing.source.kind === "git") {
            const realInstalledBase = yield* fs
              .realPath(installedDir)
              .pipe(Effect.orElseSucceed(() => installedDir));
            const resolvedTarget = pathApi.resolve(realInstalledBase, pluginId);
            if (
              resolvedTarget !== realInstalledBase &&
              isPathWithinRoot(realInstalledBase, resolvedTarget, pathApi.sep)
            ) {
              yield* fs
                .remove(resolvedTarget, { recursive: true, force: true })
                .pipe(Effect.ignore);
            }
          }

          if (options?.removeData === true) {
            const realDataBase = yield* fs
              .realPath(pluginDataBaseDir)
              .pipe(Effect.orElseSucceed(() => pluginDataBaseDir));
            const resolvedDataDir = pathApi.resolve(realDataBase, pluginId);
            if (
              resolvedDataDir !== realDataBase &&
              isPathWithinRoot(realDataBase, resolvedDataDir, pathApi.sep)
            ) {
              yield* fs
                .remove(resolvedDataDir, { recursive: true, force: true })
                .pipe(Effect.ignore);
            }
          }

          return { uninstalled: pluginId };
        }),
      );
    },
  );

  const readAsset: PluginServiceShape["readAsset"] = Effect.fn("PluginService.readAsset")(
    function* (pluginId: string, rawAssetPath: string) {
      const record = yield* requireRecord(pluginId);
      let decodedPath: string;
      const decodeResult = yield* Effect.try({
        try: () => decodeURIComponent(rawAssetPath),
        catch: () =>
          new PluginError({
            code: "invalid_request",
            message: "Malformed URL encoding in plugin asset path.",
            status: 400,
          }),
      });
      decodedPath = decodeResult;

      const resolved = yield* resolveSafePluginSubpath(
        record.rootDir,
        decodedPath,
        "asset path",
        fs,
        pathApi,
        { requireExisting: true },
      );

      const info = yield* fs.stat(resolved.resolvedPath).pipe(
        Effect.mapError(
          () =>
            new PluginError({
              code: "not_found",
              message: `Plugin asset not found: ${resolved.normalized}`,
              status: 404,
            }),
        ),
      );
      if (info.type !== "File") {
        return yield* new PluginError({
          code: "not_found",
          message: `Plugin asset is not a file: ${resolved.normalized}`,
          status: 404,
        });
      }

      const bytes = yield* fs.readFile(resolved.resolvedPath).pipe(
        Effect.mapError(
          (cause) =>
            new PluginError({
              code: "internal_error",
              message: `Failed to read plugin asset: ${cause.message}`,
              status: 500,
            }),
        ),
      );

      return {
        bytes,
        contentType: resolveAssetContentType(resolved.resolvedPath, pathApi),
        filePath: resolved.resolvedPath,
      } satisfies PluginAssetPayload;
    },
  );

  const ensureBackendReady: PluginServiceShape["ensureBackendReady"] = Effect.fn(
    "PluginService.ensureBackendReady",
  )(function* (pluginId: string) {
    const record = yield* requireRecord(pluginId);
    if (!record.enabled) {
      return yield* new PluginError({
        code: "forbidden",
        message: `Plugin "${pluginId}" is disabled.`,
        status: 403,
      });
    }

    const cached =
      manifestCache.get(pluginId) ?? (yield* readManifestFromDisk(record.rootDir, pluginId));
    manifestCache.set(pluginId, cached);

    if (!cached.manifest) {
      return yield* new PluginError({
        code: "invalid_manifest",
        message: cached.manifestError ?? `Plugin "${pluginId}" has an invalid manifest.`,
        status: 400,
      });
    }
    if (!cached.manifest.backend) {
      return yield* new PluginError({
        code: "not_found",
        message: `Plugin "${pluginId}" does not configure a backend.`,
        status: 404,
      });
    }

    return yield* processManager.ensureRunning({
      pluginId,
      rootDir: record.rootDir,
      dataDir: pluginDataDirFor(pluginId),
      backend: cached.manifest.backend,
    });
  });

  return PluginService.of({
    list,
    install,
    setEnabled,
    update,
    reload,
    uninstall,
    readAsset,
    ensureBackendReady,
  });
});

export class PluginService extends Context.Service<PluginService, PluginServiceShape>()(
  "t3/plugins/PluginService",
) {
  static readonly layer = Layer.effect(PluginService, makePluginService());

  static readonly layerWithOptions = (options?: PluginProcessManagerOptions) =>
    Layer.effect(PluginService, makePluginService(options));
}

export type PluginServiceRequirements =
  | ServerConfig.ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | ProcessRunner.ProcessRunner
  | NetService.NetService
  | SecureRandom.SecureRandom;
