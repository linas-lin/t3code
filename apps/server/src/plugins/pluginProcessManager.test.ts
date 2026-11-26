import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { describe, expect } from "vite-plus/test";

import { makePluginProcessManager, type PluginBackendLaunchSpec } from "./pluginProcessManager.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  FetchHttpClient.layer,
);

describe("pluginProcessManager", () => {
  it.live(
    "starts demo-plugin backend, injects CT_PLUGIN_* env vars, single-flights concurrent starts, restarts, and stops cleanly",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const pathApi = yield* Path.Path;
          const httpClient = yield* HttpClient.HttpClient;

          const demoRoot = pathApi.resolve(import.meta.dirname, "__fixtures__/demo-plugin");
          const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "plugin-proc-data-" });

          const manager = yield* makePluginProcessManager({
            startupTimeoutMs: 10_000,
            pollIntervalMs: 50,
          });
          yield* Effect.addFinalizer(() => manager.stopAll());

          const spec: PluginBackendLaunchSpec = {
            pluginId: "demo-plugin",
            rootDir: demoRoot,
            dataDir,
            backend: {
              activation: "lazy",
              command: ["node", "server.mjs"],
              healthcheck: "/api/health",
            },
          };

          expect(manager.getStatus("demo-plugin", spec.backend).status).toBe("stopped");

          const [first, second] = yield* Effect.all(
            [manager.ensureRunning(spec), manager.ensureRunning(spec)],
            { concurrency: 2 },
          );
          expect(first.port).toBe(second.port);
          expect(first.token).toBe(second.token);
          expect(first.host).toBe("127.0.0.1");
          expect(first.token).toMatch(/^[a-f0-9]{64}$/);

          const runningStatus = manager.getStatus("demo-plugin", spec.backend);
          expect(runningStatus.status).toBe("running");
          expect(runningStatus.startedAt).toBeTruthy();
          expect(runningStatus.error).toBeNull();

          const pingResponse = yield* httpClient.execute(
            HttpClientRequest.get(`http://${first.host}:${first.port}/api/ping?hello=world`).pipe(
              HttpClientRequest.setHeaders({
                "x-ct-plugin-token": first.token,
                "x-ct-studio-token": first.token,
              }),
            ),
          );
          expect(pingResponse.status).toBe(200);
          const pingJson = (yield* pingResponse.json) as {
            pong: boolean;
            pluginId: string;
            dataDir: string;
            rootDir: string;
            tokens: { hasPluginToken: boolean; hasStudioToken: boolean };
          };
          expect(pingJson.pong).toBe(true);
          expect(pingJson.pluginId).toBe("demo-plugin");
          expect(pingJson.dataDir).toBe(dataDir);
          expect(pingJson.rootDir).toBe(yield* fs.realPath(demoRoot));
          expect(pingJson.tokens.hasPluginToken).toBe(true);
          expect(pingJson.tokens.hasStudioToken).toBe(true);

          const unauthResponse = yield* httpClient.execute(
            HttpClientRequest.get(`http://${first.host}:${first.port}/api/ping`),
          );
          expect(unauthResponse.status).toBe(401);

          const restarted = yield* manager.restart(spec);
          expect(restarted.token).not.toBe(first.token);
          expect(restarted.token).toMatch(/^[a-f0-9]{64}$/);
          expect(manager.getStatus("demo-plugin", spec.backend).status).toBe("running");

          yield* manager.stop("demo-plugin");
          const stoppedStatus = manager.getStatus("demo-plugin", spec.backend);
          expect(stoppedStatus.status).toBe("stopped");
          expect(stoppedStatus.startedAt).toBeNull();
          expect(stoppedStatus.error).toBeNull();
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.live("records crash status and stderr diagnostics when backend exits during startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathApi = yield* Path.Path;
        const pluginRoot = yield* fs.makeTempDirectoryScoped({ prefix: "plugin-crash-test-" });
        const dataDir = pathApi.join(pluginRoot, "data");
        yield* fs.writeFileString(
          pathApi.join(pluginRoot, "crash.mjs"),
          'console.error("fatal-startup-boom"); process.exit(42);\n',
        );

        const manager = yield* makePluginProcessManager({
          startupTimeoutMs: 5_000,
          pollIntervalMs: 30,
        });
        yield* Effect.addFinalizer(() => manager.stopAll());

        const spec: PluginBackendLaunchSpec = {
          pluginId: "crash-plugin",
          rootDir: pluginRoot,
          dataDir,
          backend: {
            activation: "lazy",
            command: ["node", "crash.mjs"],
            healthcheck: "/api/health",
          },
        };

        const result = yield* manager.ensureRunning(spec).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.message).toContain("42");
          expect(result.failure.message).toContain("fatal-startup-boom");
        }

        const status = manager.getStatus("crash-plugin", spec.backend);
        expect(status.status).toBe("error");
        expect(status.error).toContain("fatal-startup-boom");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "records error state if a running backend crashes unexpectedly after becoming healthy",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const pathApi = yield* Path.Path;
          const httpClient = yield* HttpClient.HttpClient;
          const pluginRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "plugin-die-after-ready-",
          });
          const dataDir = pathApi.join(pluginRoot, "data");
          yield* fs.writeFileString(
            pathApi.join(pluginRoot, "fragile.mjs"),
            [
              'import http from "node:http";',
              "const server = http.createServer((req, res) => {",
              '  if (req.url === "/api/health") { res.writeHead(200); res.end("ok"); return; }',
              '  if (req.url === "/crash") { res.writeHead(200); res.end("bye"); console.error("unexpected-runtime-crash"); setTimeout(() => process.exit(7), 10); return; }',
              "  res.writeHead(404); res.end();",
              "});",
              'server.listen(Number(process.env.CT_PLUGIN_PORT), process.env.CT_PLUGIN_HOST || "127.0.0.1");',
              "",
            ].join("\n"),
          );

          const manager = yield* makePluginProcessManager({
            startupTimeoutMs: 5_000,
            pollIntervalMs: 30,
          });
          yield* Effect.addFinalizer(() => manager.stopAll());

          const spec: PluginBackendLaunchSpec = {
            pluginId: "fragile-plugin",
            rootDir: pluginRoot,
            dataDir,
            backend: {
              activation: "lazy",
              command: ["node", "fragile.mjs"],
              healthcheck: "/api/health",
            },
          };

          const endpoint = yield* manager.ensureRunning(spec);
          expect(manager.getStatus("fragile-plugin", spec.backend).status).toBe("running");

          yield* httpClient.execute(
            HttpClientRequest.get(`http://${endpoint.host}:${endpoint.port}/crash`),
          );

          yield* Effect.promise(() =>
            expect
              .poll(() => manager.getStatus("fragile-plugin", spec.backend).status, {
                timeout: 5_000,
                interval: 50,
              })
              .toBe("error"),
          );

          const crashedStatus = manager.getStatus("fragile-plugin", spec.backend);
          expect(crashedStatus.status).toBe("error");
          expect(crashedStatus.error).toContain("unexpected-runtime-crash");
        }),
      ).pipe(Effect.provide(testLayer)),
  );
});
