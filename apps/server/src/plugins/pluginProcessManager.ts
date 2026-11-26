import * as NetService from "@t3tools/shared/Net";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  type CtPluginBackendConfig,
  type PluginBackendEndpoint,
  type PluginBackendStateView,
  type PluginBackendStatus,
  PluginError,
  resolveSafePluginSubpath,
} from "./pluginContract.ts";
import { resolvePluginExecutable } from "./pluginGitInstaller.ts";

const PLUGIN_BACKEND_HOST = "127.0.0.1" as const;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const HEALTHCHECK_POLL_INTERVAL_MS = 80;
const HEALTHCHECK_REQUEST_TIMEOUT_MS = 1_000;
const FORCE_KILL_AFTER: Duration.Input = "3 seconds";
const MAX_STDERR_TAIL_CHARS = 4_096;

export interface PluginBackendLaunchSpec {
  readonly pluginId: string;
  readonly rootDir: string;
  readonly dataDir: string;
  readonly backend: CtPluginBackendConfig;
}

export interface PluginProcessManagerOptions {
  readonly startupTimeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
}

export interface PluginProcessManager {
  readonly getStatus: (
    pluginId: string,
    backend: CtPluginBackendConfig | undefined,
  ) => PluginBackendStateView;
  readonly isActive: (pluginId: string) => boolean;
  readonly ensureRunning: (
    spec: PluginBackendLaunchSpec,
  ) => Effect.Effect<PluginBackendEndpoint, PluginError>;
  readonly stop: (pluginId: string) => Effect.Effect<void>;
  readonly restart: (
    spec: PluginBackendLaunchSpec,
  ) => Effect.Effect<PluginBackendEndpoint, PluginError>;
  readonly stopAll: () => Effect.Effect<void>;
}

interface PluginProcessEntry {
  generation: number;
  status: Exclude<PluginBackendStatus, "none">;
  port: number | null;
  token: string | null;
  startedAt: string | null;
  error: string | null;
  handle: ChildProcessSpawner.ChildProcessHandle | null;
  scope: Scope.Closeable | null;
  stderrTail: string;
  stopping: boolean;
  inFlightStart: Deferred.Deferred<PluginBackendEndpoint, PluginError> | null;
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_STDERR_TAIL_CHARS ? next.slice(-MAX_STDERR_TAIL_CHARS) : next;
}

function formatCrashMessage(exitCode: number | null, stderrTail: string): string {
  const trimmedStderr = stderrTail.trim();
  const base =
    exitCode === null
      ? "Plugin backend process exited unexpectedly."
      : `Plugin backend process exited unexpectedly (code ${exitCode}).`;
  return trimmedStderr.length > 0 ? `${base} ${trimmedStderr}` : base;
}

export const makePluginProcessManager = Effect.fn("plugins.makePluginProcessManager")(function* (
  options?: PluginProcessManagerOptions,
): Effect.fn.Return<
  PluginProcessManager,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SecureRandom.SecureRandom
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const pathApi = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const netService = yield* NetService.NetService;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const runtimeContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const startupTimeoutMs = options?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? HEALTHCHECK_POLL_INTERVAL_MS;

  const entries = new Map<string, PluginProcessEntry>();

  const getOrCreateEntry = (pluginId: string): PluginProcessEntry => {
    const existing = entries.get(pluginId);
    if (existing) return existing;
    const created: PluginProcessEntry = {
      generation: 0,
      status: "stopped",
      port: null,
      token: null,
      startedAt: null,
      error: null,
      handle: null,
      scope: null,
      stderrTail: "",
      stopping: false,
      inFlightStart: null,
    };
    entries.set(pluginId, created);
    return created;
  };

  const terminateHandleAndScope = Effect.fn("plugins.process.terminate")(function* (
    handle: ChildProcessSpawner.ChildProcessHandle | null,
    scope: Scope.Closeable | null,
  ) {
    if (handle !== null) {
      yield* handle
        .kill({ killSignal: "SIGTERM", forceKillAfter: FORCE_KILL_AFTER })
        .pipe(Effect.ignore);
    }
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const probeHealth = Effect.fn("plugins.process.probeHealth")(function* (
    port: number,
    token: string,
    healthcheck: string,
  ) {
    const url = `http://${PLUGIN_BACKEND_HOST}:${port}${healthcheck}`;
    const req = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({
        "x-ct-plugin-token": token,
        "x-ct-studio-token": token,
      }),
    );
    const result = yield* httpClient.execute(req).pipe(
      Effect.flatMap((response) =>
        response.arrayBuffer.pipe(
          Effect.ignore,
          Effect.as(response.status >= 200 && response.status < 300),
        ),
      ),
      Effect.timeoutOption(Duration.millis(HEALTHCHECK_REQUEST_TIMEOUT_MS)),
      Effect.orElseSucceed(() => Option.none<boolean>()),
    );
    return Option.isSome(result) && result.value;
  });

  const stop = Effect.fn("plugins.process.stop")(function* (pluginId: string) {
    const entry = entries.get(pluginId);
    if (!entry) return;

    entry.generation += 1;
    entry.stopping = true;
    const inFlight = entry.inFlightStart;
    entry.inFlightStart = null;
    if (inFlight !== null) {
      yield* Deferred.fail(
        inFlight,
        new PluginError({
          code: "backend_error",
          message: `Plugin "${pluginId}" backend was stopped before becoming ready.`,
          status: 503,
        }),
      ).pipe(Effect.ignore);
    }

    const handle = entry.handle;
    const scope = entry.scope;
    entry.handle = null;
    entry.scope = null;
    entry.port = null;
    entry.token = null;
    entry.startedAt = null;
    entry.error = null;
    entry.stderrTail = "";
    entry.status = "stopped";

    yield* terminateHandleAndScope(handle, scope);
    entry.stopping = false;
  });

  const startFresh = Effect.fn("plugins.process.startFresh")(function* (
    spec: PluginBackendLaunchSpec,
    entry: PluginProcessEntry,
    inFlight: Deferred.Deferred<PluginBackendEndpoint, PluginError>,
  ) {
    const generation = entry.generation + 1;
    entry.generation = generation;
    entry.stopping = false;
    entry.status = "starting";
    entry.error = null;
    entry.startedAt = null;
    entry.port = null;
    entry.token = null;
    entry.stderrTail = "";

    const failStart = Effect.fn("plugins.process.failStart")(function* (
      message: string,
      childHandle: ChildProcessSpawner.ChildProcessHandle | null,
      childScope: Scope.Closeable | null,
      status = 502,
    ) {
      yield* terminateHandleAndScope(childHandle, childScope);
      const error = new PluginError({
        code: "backend_error",
        message,
        status,
      });
      if (entry.generation === generation) {
        entry.status = "error";
        entry.error = message;
        entry.port = null;
        entry.token = null;
        entry.startedAt = null;
        entry.handle = null;
        entry.scope = null;
        if (entry.inFlightStart === inFlight) {
          entry.inFlightStart = null;
        }
      }
      yield* Deferred.fail(inFlight, error).pipe(Effect.ignore);
      return yield* error;
    });

    const cwdResolution = yield* resolveSafePluginSubpath(
      spec.rootDir,
      spec.backend.cwd ?? ".",
      "backend.cwd",
      fs,
      pathApi,
      { allowRootDot: true, requireExisting: true },
    ).pipe(Effect.result);
    if (cwdResolution._tag === "Failure") {
      return yield* failStart(cwdResolution.failure.message, null, null, 400);
    }
    const cwdInfo = yield* fs
      .stat(cwdResolution.success.resolvedPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (!cwdInfo || cwdInfo.type !== "Directory") {
      return yield* failStart(
        `Plugin backend cwd is not a directory: ${cwdResolution.success.resolvedPath}`,
        null,
        null,
        400,
      );
    }

    yield* fs.makeDirectory(spec.dataDir, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);

    const portResult = yield* netService
      .reserveLoopbackPort(PLUGIN_BACKEND_HOST)
      .pipe(Effect.result);
    if (portResult._tag === "Failure") {
      return yield* failStart(
        `Failed to allocate loopback port for plugin "${spec.pluginId}": ${portResult.failure.message}`,
        null,
        null,
      );
    }
    const port = portResult.success;
    const tokenBytes = yield* secureRandom.randomBytes(32);
    const token = Buffer.from(tokenBytes).toString("hex");

    const executableResult = yield* resolvePluginExecutable(spec.backend.command).pipe(
      Effect.provideContext(runtimeContext),
      Effect.result,
    );
    if (executableResult._tag === "Failure") {
      return yield* failStart(executableResult.failure.message, null, null, 400);
    }

    const childEnv: NodeJS.ProcessEnv = {
      CT_PLUGIN_ID: spec.pluginId,
      CT_PLUGIN_PORT: String(port),
      CT_PLUGIN_HOST: PLUGIN_BACKEND_HOST,
      CT_PLUGIN_TOKEN: token,
      CT_PLUGIN_DATA_DIR: spec.dataDir,
      CT_PLUGIN_ROOT: cwdResolution.success.realRoot,
    };

    const spawnCommand = yield* resolveSpawnCommand(
      executableResult.success.command,
      executableResult.success.args,
      { env: childEnv, extendEnv: true },
    ).pipe(Effect.provideContext(runtimeContext));

    const childScope = yield* Scope.make();
    const spawnResult = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: cwdResolution.success.resolvedPath,
          env: childEnv,
          extendEnv: true,
          shell: spawnCommand.shell,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: FORCE_KILL_AFTER,
        }),
      )
      .pipe(Scope.provide(childScope), Effect.result);

    if (spawnResult._tag === "Failure") {
      return yield* failStart(
        `Failed to spawn backend for plugin "${spec.pluginId}": ${spawnResult.failure.message}`,
        null,
        childScope,
      );
    }

    const handle = spawnResult.success;

    if (entry.generation !== generation) {
      yield* terminateHandleAndScope(handle, childScope);
      return yield* new PluginError({
        code: "backend_error",
        message: `Plugin "${spec.pluginId}" backend startup was superseded.`,
        status: 503,
      });
    }

    entry.handle = handle;
    entry.scope = childScope;
    entry.port = port;
    entry.token = token;

    // Drain stdout and capture a bounded stderr tail so child pipe buffers never stall.
    yield* handle.stdout.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(childScope));
    yield* handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          if (entry.generation === generation) {
            entry.stderrTail = appendTail(entry.stderrTail, chunk);
          }
        }),
      ),
      Effect.ignore,
      Effect.forkIn(childScope),
    );

    const exitedDeferred = yield* Deferred.make<number | null>();
    yield* handle.exitCode.pipe(
      Effect.map((code): number | null => Number(code)),
      Effect.orElseSucceed((): number | null => null),
      Effect.tap((exitCode) => Deferred.succeed(exitedDeferred, exitCode)),
      Effect.tap((exitCode) =>
        Effect.gen(function* () {
          if (entry.generation !== generation || entry.stopping) {
            return;
          }
          // Let stderr reader catch trailing lines briefly before capturing crash message.
          yield* Effect.sleep(Duration.millis(20));
          if (entry.generation !== generation || entry.stopping) {
            return;
          }
          const wasRunning = entry.status === "running";
          const message = formatCrashMessage(exitCode, entry.stderrTail);
          entry.status = "error";
          entry.error = message;
          entry.port = null;
          entry.token = null;
          entry.handle = null;
          entry.scope = null;
          if (wasRunning) {
            yield* Effect.logWarning(`Plugin "${spec.pluginId}" backend crashed.`, {
              pluginId: spec.pluginId,
              exitCode,
              error: message,
            });
          }
          yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
        }),
      ),
      Effect.ignore,
      Effect.forkIn(childScope),
    );

    const startMs = yield* Clock.currentTimeMillis;
    const deadlineMs = startMs + startupTimeoutMs;

    while (true) {
      if (entry.generation !== generation) {
        yield* terminateHandleAndScope(handle, childScope);
        return yield* new PluginError({
          code: "backend_error",
          message: `Plugin "${spec.pluginId}" backend startup was cancelled.`,
          status: 503,
        });
      }

      const alreadyExited = yield* Deferred.isDone(exitedDeferred);
      if (alreadyExited) {
        const exitCode = yield* Deferred.await(exitedDeferred);
        yield* Effect.sleep(Duration.millis(20));
        return yield* failStart(formatCrashMessage(exitCode, entry.stderrTail), handle, childScope);
      }

      const healthy = yield* probeHealth(port, token, spec.backend.healthcheck);
      if (healthy) {
        if (entry.generation !== generation) {
          yield* terminateHandleAndScope(handle, childScope);
          return yield* new PluginError({
            code: "backend_error",
            message: `Plugin "${spec.pluginId}" backend startup was cancelled.`,
            status: 503,
          });
        }
        entry.status = "running";
        entry.error = null;
        entry.startedAt = DateTime.formatIso(yield* DateTime.now);
        if (entry.inFlightStart === inFlight) {
          entry.inFlightStart = null;
        }
        const endpoint: PluginBackendEndpoint = {
          host: PLUGIN_BACKEND_HOST,
          port,
          token,
        };
        yield* Deferred.succeed(inFlight, endpoint).pipe(Effect.ignore);
        return endpoint;
      }

      const nowMs = yield* Clock.currentTimeMillis;
      if (nowMs >= deadlineMs) {
        const detail = entry.stderrTail.trim();
        const message =
          detail.length > 0
            ? `Plugin "${spec.pluginId}" backend healthcheck (${spec.backend.healthcheck}) timed out after ${startupTimeoutMs}ms: ${detail}`
            : `Plugin "${spec.pluginId}" backend healthcheck (${spec.backend.healthcheck}) timed out after ${startupTimeoutMs}ms.`;
        return yield* failStart(message, handle, childScope, 504);
      }

      const waitMs = Math.min(pollIntervalMs, Math.max(1, deadlineMs - nowMs));
      yield* Deferred.await(exitedDeferred).pipe(
        Effect.timeoutOption(Duration.millis(waitMs)),
        Effect.ignore,
      );
    }
  });

  const ensureRunning = Effect.fn("plugins.process.ensureRunning")(function* (
    spec: PluginBackendLaunchSpec,
  ) {
    const entry = getOrCreateEntry(spec.pluginId);
    if (entry.status === "running" && entry.port !== null && entry.token !== null) {
      return {
        host: PLUGIN_BACKEND_HOST,
        port: entry.port,
        token: entry.token,
      } satisfies PluginBackendEndpoint;
    }
    if (entry.inFlightStart !== null) {
      return yield* Deferred.await(entry.inFlightStart);
    }

    const inFlight = yield* Deferred.make<PluginBackendEndpoint, PluginError>();
    entry.inFlightStart = inFlight;
    return yield* startFresh(spec, entry, inFlight);
  });

  const restart = Effect.fn("plugins.process.restart")(function* (spec: PluginBackendLaunchSpec) {
    yield* stop(spec.pluginId);
    return yield* ensureRunning(spec);
  });

  const stopAll = Effect.fn("plugins.process.stopAll")(function* () {
    const ids = [...entries.keys()];
    yield* Effect.forEach(ids, (pluginId) => stop(pluginId), {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const getStatus = (
    pluginId: string,
    backend: CtPluginBackendConfig | undefined,
  ): PluginBackendStateView => {
    if (!backend) {
      return {
        configured: false,
        activation: null,
        status: "none",
        error: null,
        startedAt: null,
      };
    }
    const entry = entries.get(pluginId);
    return {
      configured: true,
      activation: backend.activation,
      status: entry?.status ?? "stopped",
      error: entry?.error ?? null,
      startedAt: entry?.startedAt ?? null,
    };
  };

  const isActive = (pluginId: string): boolean => {
    const entry = entries.get(pluginId);
    return entry !== undefined && (entry.status === "running" || entry.status === "starting");
  };

  return {
    getStatus,
    isActive,
    ensureRunning,
    stop,
    restart,
    stopAll,
  } satisfies PluginProcessManager;
});
