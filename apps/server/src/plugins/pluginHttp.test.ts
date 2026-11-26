import { it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { describe, expect } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { PluginRecordView } from "./pluginContract.ts";
import * as PluginHttp from "./pluginHttp.ts";
import * as PluginService from "./PluginService.ts";

function makeAuthLayer(scopes: ReadonlyArray<AuthEnvironmentScope>) {
  return Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
    authenticateHttpRequest: () => Effect.succeed({ scopes }),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);
}

function createTestWebHandler(options?: {
  readonly baseDir?: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
}) {
  const baseLayer = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    NetService.layer,
    FetchHttpClient.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  );
  const configLayer = ServerConfig.layerTest(
    process.cwd(),
    options?.baseDir ?? { prefix: "plugin-http-test-" },
  ).pipe(Layer.provide(NodeServices.layer));
  const pluginServiceLayer = PluginService.PluginService.layerWithOptions({
    startupTimeoutMs: 10_000,
    pollIntervalMs: 40,
  }).pipe(Layer.provide(configLayer), Layer.provide(baseLayer));

  const appLayer = Layer.mergeAll(
    PluginHttp.layer,
    ServerHttp.layerBrowserApiCors,
    makeAuthLayer(options?.scopes ?? [AuthOrchestrationOperateScope]),
  ).pipe(Layer.provide(pluginServiceLayer), Layer.provide(configLayer), Layer.provide(baseLayer));

  return HttpRouter.toWebHandler(appLayer, { disableLogger: true });
}

const testUtilLayer = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

function acquireTestWebHandler(options?: {
  readonly baseDir?: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
}) {
  return Effect.acquireRelease(
    Effect.sync(() => createTestWebHandler(options)),
    ({ dispose }) => Effect.promise(() => dispose()),
  );
}

describe("pluginHttp", () => {
  it.live("enforces operate scope on plugin routes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* acquireTestWebHandler({
          scopes: [AuthOrchestrationReadScope],
        });
        const response = yield* Effect.promise(() =>
          handler(new Request("http://127.0.0.1:3773/api/plugins")),
        );
        expect(response.status).toBe(403);
      }),
    ),
  );

  it.live(
    "installs local demo-plugin, serves assets safely, proxies JSON/binary/SSE and _ct_method overrides, toggles enable/reload/uninstall",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const pathApi = yield* Path.Path;
          const { handler } = yield* acquireTestWebHandler();
          const demoDir = yield* fs.realPath(
            pathApi.resolve(import.meta.dirname, "__fixtures__/demo-plugin"),
          );

          yield* Effect.promise(async () => {
            // Desktop CORS preflight
            const preflight = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/install", {
                method: "OPTIONS",
                headers: {
                  origin: "t3code-dev://app",
                  "access-control-request-method": "POST",
                  "access-control-request-headers": "authorization,content-type",
                },
              }),
            );
            expect(preflight.status).toBe(204);

            // Initially empty
            const initialList = await handler(new Request("http://127.0.0.1:3773/api/plugins"));
            expect(initialList.status).toBe(200);
            expect(await initialList.json()).toEqual({ apiVersion: 1, plugins: [] });

            // Install local demo-plugin
            const installRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/install", {
                method: "POST",
                headers: {
                  origin: "t3code-dev://app",
                  authorization: "Bearer ct-code-secret-token",
                  "content-type": "application/json",
                },
                body: JSON.stringify({ source: "local", path: demoDir }),
              }),
            );
            expect(installRes.status).toBe(200);
            const { plugin } = (await installRes.json()) as { plugin: PluginRecordView };
            expect(plugin.id).toBe("demo-plugin");
            expect(plugin.enabled).toBe(true);
            expect(plugin.uiReady).toBe(true);
            expect(plugin.reloadNonce).toBe(0);
            expect(plugin.backend.configured).toBe(true);
            expect(plugin.backend.activation).toBe("lazy");
            expect(plugin.backend.status).toBe("stopped");

            // Duplicate install conflicts
            const dupRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/install", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ source: "local", path: demoDir }),
              }),
            );
            expect(dupRes.status).toBe(409);

            // Serve static assets with accurate Content-Type & no-store
            const uiJsRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/demo-plugin/assets/ui.mjs"),
            );
            expect(uiJsRes.status).toBe(200);
            expect(uiJsRes.headers.get("content-type")).toContain("javascript");
            expect(uiJsRes.headers.get("cache-control")).toBe("no-store");
            expect(await uiJsRes.text()).toContain("__CT_PLUGIN_RUNTIME__");

            const uiCssRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/demo-plugin/assets/ui.css"),
            );
            expect(uiCssRes.status).toBe(200);
            expect(uiCssRes.headers.get("content-type")).toContain("text/css");

            // Path traversal blocked (both URL-normalized and encoded slash forms)
            const normalizedTraversalRes = await handler(
              new Request(
                "http://127.0.0.1:3773/api/plugins/demo-plugin/assets/%2e%2e/pluginContract.ts",
              ),
            );
            expect(normalizedTraversalRes.status).toBe(404);

            const encodedTraversalRes = await handler(
              new Request(
                "http://127.0.0.1:3773/api/plugins/demo-plugin/assets/%2e%2e%2fpluginContract.ts",
              ),
            );
            expect(encodedTraversalRes.status).toBe(400);

            const missingAssetRes = await handler(
              new Request(
                "http://127.0.0.1:3773/api/plugins/demo-plugin/assets/does-not-exist.mjs",
              ),
            );
            expect(missingAssetRes.status).toBe(404);

            // Lazy backend auto-start & token injection & authorization stripping
            const pingRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/demo-plugin/api/api/ping?a=1&b=two", {
                headers: { authorization: "Bearer host-secret-must-not-leak" },
              }),
            );
            expect(pingRes.status).toBe(200);
            const pingBody = (await pingRes.json()) as {
              pong: boolean;
              pluginId: string;
              query: Record<string, string>;
              tokens: {
                hasPluginToken: boolean;
                hasStudioToken: boolean;
                hasAuthorization: boolean;
              };
            };
            expect(pingBody.pong).toBe(true);
            expect(pingBody.pluginId).toBe("demo-plugin");
            expect(pingBody.query).toEqual({ a: "1", b: "two" });
            expect(pingBody.tokens).toEqual({
              hasPluginToken: true,
              hasStudioToken: true,
              hasAuthorization: false,
            });

            // Method override via ?_ct_method=PATCH / PUT / DELETE
            for (const override of ["PUT", "PATCH", "DELETE"] as const) {
              const echoRes = await handler(
                new Request(
                  `http://127.0.0.1:3773/api/plugins/demo-plugin/api/api/echo?_ct_method=${override}&keep=ok`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ op: override }),
                  },
                ),
              );
              expect(echoRes.status).toBe(200);
              const echoJson = (await echoRes.json()) as {
                method: string;
                path: string;
                query: Record<string, string>;
                body: { op: string };
              };
              expect(echoJson.method).toBe(override);
              expect(echoJson.path).toBe("/api/echo");
              expect(echoJson.query).toEqual({ keep: "ok" });
              expect(echoJson.body).toEqual({ op: override });
            }

            // Invalid _ct_method rejected
            const badMethodRes = await handler(
              new Request(
                "http://127.0.0.1:3773/api/plugins/demo-plugin/api/api/echo?_ct_method=TRACE",
                { method: "POST" },
              ),
            );
            expect(badMethodRes.status).toBe(400);

            // Binary response proxy
            const binRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/demo-plugin/api/api/binary"),
            );
            expect(binRes.status).toBe(200);
            expect(binRes.headers.get("content-type")).toBe("application/octet-stream");
            expect(new Uint8Array(await binRes.arrayBuffer())).toEqual(
              new Uint8Array([0x00, 0x01, 0x02, 0xfe, 0xff]),
            );

            // SSE streaming response proxy
            const sseRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/demo-plugin/api/api/sse"),
            );
            expect(sseRes.status).toBe(200);
            expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
            expect(sseRes.headers.get("cache-control")).toBe("no-store, no-transform");
            const sseText = await sseRes.text();
            expect(sseText).toContain('"seq":1');
            expect(sseText).toContain('"seq":2');

            // Reload increments reloadNonce and restarts running backend
            const reloadRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/demo-plugin/reload", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
              }),
            );
            expect(reloadRes.status).toBe(200);
            const reloaded = (await reloadRes.json()) as { plugin: PluginRecordView };
            expect(reloaded.plugin.reloadNonce).toBe(1);
            expect(reloaded.plugin.backend.status).toBe("running");

            // Disable stops backend and blocks API requests
            const disableRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/demo-plugin/enable", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ enabled: false }),
              }),
            );
            expect(disableRes.status).toBe(200);
            const disabled = (await disableRes.json()) as { plugin: PluginRecordView };
            expect(disabled.plugin.enabled).toBe(false);
            expect(disabled.plugin.backend.status).toBe("stopped");

            const blockedApi = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/demo-plugin/api/api/ping"),
            );
            expect(blockedApi.status).toBe(403);

            // Uninstall local plugin preserves user source directory
            const uninstallRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/demo-plugin/uninstall", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ removeData: true }),
              }),
            );
            expect(uninstallRes.status).toBe(200);
            expect(await uninstallRes.json()).toEqual({ uninstalled: "demo-plugin" });
          });

          const demoStillExists = yield* fs.exists(demoDir);
          expect(demoStillExists).toBe(true);
        }),
      ).pipe(Effect.provide(testUtilLayer)),
  );

  it.live(
    "supports Git install, opt-in runBuild, dirty-worktree rejection, fast-forward update, and uninstall cleanup",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const pathApi = yield* Path.Path;
          const runner = yield* ProcessRunner.ProcessRunner;

          const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "plugin-git-fixture-" });
          const bareRepo = pathApi.join(tempRoot, "remote.git");
          const workRepo = pathApi.join(tempRoot, "work");
          const serverBaseDir = pathApi.join(tempRoot, "server-home");

          yield* fs.makeDirectory(bareRepo, { recursive: true });
          yield* fs.makeDirectory(workRepo, { recursive: true });
          yield* fs.makeDirectory(serverBaseDir, { recursive: true });

          const gitEnv = {
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
          };
          const git = (args: ReadonlyArray<string>, cwd?: string) =>
            runner.run({
              command: "git",
              args,
              ...(cwd ? { cwd } : {}),
              env: gitEnv,
            });

          yield* git(["init", "--bare", bareRepo]);
          yield* git(["init", workRepo]);
          yield* git(["remote", "add", "origin", bareRepo], workRepo);
          yield* fs.writeFileString(
            pathApi.join(workRepo, "ct-plugin.json"),
            JSON.stringify(
              {
                id: "git-sample",
                name: "Git Sample",
                version: "1.0.0",
                apiVersion: 1,
                ui: { entry: "dist/ui.mjs" },
                build: {
                  command: [
                    "node",
                    "-e",
                    'require("node:fs").mkdirSync("dist",{recursive:true}); require("node:fs").writeFileSync("dist/ui.mjs","export default { activate() {} };\\n");',
                  ],
                },
              },
              null,
              2,
            ),
          );
          yield* git(["add", "."], workRepo);
          yield* git(["commit", "-m", "initial"], workRepo);
          yield* git(["push", "-u", "origin", "HEAD"], workRepo);

          const { handler } = yield* acquireTestWebHandler({ baseDir: serverBaseDir });
          const repoUrl = `file://${bareRepo}`;

          // Install WITHOUT runBuild: build.command must NOT execute silently
          const installedNoBuild = yield* Effect.promise(async () => {
            const installNoBuildRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/install", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ source: "git", url: repoUrl }),
              }),
            );
            expect(installNoBuildRes.status).toBe(200);
            return (await installNoBuildRes.json()) as { plugin: PluginRecordView };
          });
          expect(installedNoBuild.plugin.id).toBe("git-sample");
          expect(installedNoBuild.plugin.source.kind).toBe("git");
          expect(installedNoBuild.plugin.uiReady).toBe(false);

          // Dirty worktree refuses update with 409
          const dirtyFilePath = `${installedNoBuild.plugin.rootDir}/dirty.txt`;
          yield* fs.writeFileString(dirtyFilePath, "uncommitted");
          const dirtyUpdateRes = yield* Effect.promise(() =>
            handler(
              new Request("http://127.0.0.1:3773/api/plugins/git-sample/update", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
              }),
            ),
          );
          expect(dirtyUpdateRes.status).toBe(409);

          // Clean worktree, push v2 commit to origin, then update with runBuild: true
          yield* fs.remove(dirtyFilePath);
          yield* fs.writeFileString(
            pathApi.join(workRepo, "ct-plugin.json"),
            JSON.stringify(
              {
                id: "git-sample",
                name: "Git Sample",
                version: "1.1.0",
                apiVersion: 1,
                ui: { entry: "dist/ui.mjs" },
                build: {
                  command: [
                    "node",
                    "-e",
                    'require("node:fs").mkdirSync("dist",{recursive:true}); require("node:fs").writeFileSync("dist/ui.mjs","export default { activate() { return {}; } };\\n");',
                  ],
                },
              },
              null,
              2,
            ),
          );
          yield* git(["add", "."], workRepo);
          yield* git(["commit", "-m", "v1.1.0"], workRepo);
          yield* git(["push"], workRepo);

          const updatedBody = yield* Effect.promise(async () => {
            const updateRes = await handler(
              new Request("http://127.0.0.1:3773/api/plugins/git-sample/update", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ runBuild: true }),
              }),
            );
            expect(updateRes.status).toBe(200);
            return (await updateRes.json()) as {
              plugin: PluginRecordView;
              updated: boolean;
              commit?: string;
            };
          });
          expect(updatedBody.updated).toBe(true);
          expect(updatedBody.commit).toMatch(/^[a-f0-9]{40}$/);
          expect(updatedBody.plugin.manifest?.version).toBe("1.1.0");
          expect(updatedBody.plugin.uiReady).toBe(true);

          // Uninstall removes installed git checkout directory
          const installedRoot = updatedBody.plugin.rootDir;
          const uninstallRes = yield* Effect.promise(() =>
            handler(
              new Request("http://127.0.0.1:3773/api/plugins/git-sample/uninstall", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ removeData: true }),
              }),
            ),
          );
          expect(uninstallRes.status).toBe(200);

          const installedExists = yield* fs.exists(installedRoot);
          expect(installedExists).toBe(false);
        }),
      ).pipe(Effect.provide(testUtilLayer)),
  );

  it.live("persists registry across restarts and auto-starts startup-activated backends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathApi = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "plugin-startup-test-" });
        const serverBaseDir = pathApi.join(tempRoot, "server-home");
        const pluginDir = pathApi.join(tempRoot, "startup-demo");
        yield* fs.makeDirectory(serverBaseDir, { recursive: true });
        yield* fs.makeDirectory(pluginDir, { recursive: true });
        const demoServerPath = pathApi.resolve(
          import.meta.dirname,
          "__fixtures__/demo-plugin/server.mjs",
        );
        const serverSource = yield* fs.readFileString(demoServerPath);
        yield* fs.writeFileString(pathApi.join(pluginDir, "server.mjs"), serverSource);
        yield* fs.writeFileString(
          pathApi.join(pluginDir, "ct-plugin.json"),
          JSON.stringify(
            {
              id: "startup-demo",
              name: "Startup Demo",
              version: "1.0.0",
              apiVersion: 1,
              backend: {
                activation: "startup",
                command: ["node", "server.mjs"],
                healthcheck: "/api/health",
              },
            },
            null,
            2,
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* acquireTestWebHandler({ baseDir: serverBaseDir });
            const installed = yield* Effect.promise(async () => {
              const installRes = await first.handler(
                new Request("http://127.0.0.1:3773/api/plugins/install", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ source: "local", path: pluginDir }),
                }),
              );
              expect(installRes.status).toBe(200);
              return (await installRes.json()) as { plugin: PluginRecordView };
            });
            expect(installed.plugin.backend.activation).toBe("startup");
            expect(installed.plugin.backend.status).toBe("running");
          }),
        );

        // Start a fresh PluginService on the same stateDir: registry is reloaded and startup backend launches automatically.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const second = yield* acquireTestWebHandler({ baseDir: serverBaseDir });
            yield* Effect.promise(() =>
              expect
                .poll(
                  async () => {
                    const listRes = await second.handler(
                      new Request("http://127.0.0.1:3773/api/plugins"),
                    );
                    expect(listRes.status).toBe(200);
                    const body = (await listRes.json()) as {
                      apiVersion: number;
                      plugins: PluginRecordView[];
                    };
                    return body.plugins.find((item) => item.id === "startup-demo")?.backend.status;
                  },
                  { timeout: 5_000, interval: 50 },
                )
                .toBe("running"),
            );
          }),
        );
      }),
    ).pipe(Effect.provide(testUtilLayer)),
  );
});
