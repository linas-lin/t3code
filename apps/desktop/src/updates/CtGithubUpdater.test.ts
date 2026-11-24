// @effect-diagnostics nodeBuiltinImport:off -- Tests verify installer staging files and generated update scripts in temp directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildMacInstallScript,
  buildWindowsInstallScript,
  makeCtGithubUpdater,
  parseCtReleaseTag,
  resolveCtAssetName,
  resolveMacAppBundlePath,
  type CtUpdaterFetch,
} from "./CtGithubUpdater.ts";

describe("CtGithubUpdater helpers", () => {
  it("parses ct-v semver tags and rejects non-ct or malformed tags", () => {
    assert.equal(parseCtReleaseTag("ct-v0.1.12"), "0.1.12");
    assert.equal(parseCtReleaseTag("ct-v1.2.3-rc.1"), "1.2.3-rc.1");
    assert.equal(parseCtReleaseTag("v0.1.12"), null);
    assert.equal(parseCtReleaseTag("ct-vlatest"), null);
    assert.equal(parseCtReleaseTag(""), null);
  });

  it("resolves expected CT installer filenames per platform and arch", () => {
    assert.equal(resolveCtAssetName("darwin", "arm64", "0.1.12"), "T3-Code-CT-0.1.12-arm64.dmg");
    assert.equal(resolveCtAssetName("darwin", "x64", "0.1.12"), "T3-Code-CT-0.1.12-x64.dmg");
    assert.equal(resolveCtAssetName("win32", "x64", "0.1.12"), "T3-Code-CT-0.1.12-x64.exe");
    assert.equal(resolveCtAssetName("linux", "x64", "0.1.12"), null);
  });

  it("resolves macOS .app bundle path from execPath or appPath", () => {
    assert.equal(
      resolveMacAppBundlePath(
        "/Applications/T3 Code (CT).app/Contents/Resources/app.asar",
        "/Applications/T3 Code (CT).app/Contents/MacOS/T3 Code (CT)",
      ),
      "/Applications/T3 Code (CT).app",
    );
    assert.equal(
      resolveMacAppBundlePath(
        "/Users/alice/Applications/T3 Code (CT).app/Contents/Resources/app.asar",
      ),
      "/Users/alice/Applications/T3 Code (CT).app",
    );
    assert.equal(
      resolveMacAppBundlePath("/Volumes/Installer/T3 Code (CT).app/Contents/Resources/app.asar"),
      "/Applications/T3 Code (CT).app",
    );
  });

  it("escapes spaces and quotes in generated macOS and Windows install scripts", () => {
    const macScript = buildMacInstallScript({
      parentPid: 1234,
      dmgPath: "/tmp/T3-Code-CT-0.1.12-arm64.dmg",
      destAppPath: "/Applications/T3 Code (CT).app",
      logPath: "/Users/alice/.t3-ct/logs/ct-updater.log",
    });
    assert.include(macScript, "PARENT_PID=1234");
    assert.include(macScript, "DEST_APP='/Applications/T3 Code (CT).app'");
    assert.include(macScript, 'xattr -cr "$DEST_APP"');
    assert.include(macScript, 'open "$DEST_APP"');

    const winScript = buildWindowsInstallScript({
      parentPid: 5678,
      installerPath: "C:\\Users\\Alice's PC\\T3-Code-CT-0.1.12-x64.exe",
      appExePath: "C:\\Users\\Alice's PC\\AppData\\Local\\Programs\\T3 Code (CT)\\T3 Code (CT).exe",
      isSilent: true,
      isForceRunAfter: true,
      logPath: "C:\\Users\\Alice's PC\\.t3-ct\\logs\\ct-updater.log",
    });
    assert.include(winScript, "$ParentPid = 5678");
    assert.include(winScript, "Alice''s PC");
    assert.include(winScript, "-ArgumentList '/S'");
    assert.include(winScript, "Start-Process -FilePath $AppExePath");
  });
});

describe("CtGithubUpdater flow", () => {
  it.live(
    "discovers latest ct-v release via redirect, downloads with progress, and launches macOS updater",
    () =>
      Effect.gen(function* () {
        const tempRoot = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ct-updater-test-")),
        );
        try {
          const events: Array<{ readonly name: string; readonly payload: unknown }> = [];
          const spawned: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
          let quitCount = 0;

          const payloadBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
          const fetchFn: CtUpdaterFetch = async (url, init) => {
            assert.notEqual(init?.redirect, "manual");
            if (url === "https://github.com/linas-lin/t3code/releases/latest") {
              // Simulate Electron net.fetch where Response.url stays empty after a redirect.
              return new Response(
                '<meta property="og:url" content="https://github.com/linas-lin/t3code/releases/tag/ct-v0.1.12">',
                { status: 200, headers: { "content-type": "text/html" } },
              );
            }
            if (
              url ===
                "https://github.com/linas-lin/t3code/releases/download/ct-v0.1.12/T3-Code-CT-0.1.12-arm64.dmg" &&
              init?.method === "HEAD"
            ) {
              return new Response(null, { status: 200 });
            }
            if (url === "https://api.github.com/repos/linas-lin/t3code/releases/tags/ct-v0.1.12") {
              return new Response(
                JSON.stringify({
                  body: "- Added CT auto-update support",
                  published_at: "2026-11-24T00:00:00Z",
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            if (
              url ===
              "https://github.com/linas-lin/t3code/releases/download/ct-v0.1.12/T3-Code-CT-0.1.12-arm64.dmg"
            ) {
              const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(payloadBytes.slice(0, 4));
                  controller.enqueue(payloadBytes.slice(4));
                  controller.close();
                },
              });
              return new Response(stream, {
                status: 200,
                headers: { "content-length": String(payloadBytes.byteLength) },
              });
            }
            return new Response(null, { status: 404 });
          };

          const updater = makeCtGithubUpdater({
            repo: "linas-lin/t3code",
            platform: "darwin",
            hostArch: "arm64",
            currentVersion: "0.1.11",
            appPath: "/Applications/T3 Code (CT).app/Contents/Resources/app.asar",
            execPath: "/Applications/T3 Code (CT).app/Contents/MacOS/T3 Code (CT)",
            baseDir: NodePath.join(tempRoot, "base"),
            logDir: NodePath.join(tempRoot, "logs"),
            tempDir: NodePath.join(tempRoot, "tmp"),
            pid: 4242,
            fetchFn,
            spawnDetached: (command, args) => {
              spawned.push({ command, args });
            },
            quitApp: Effect.sync(() => {
              quitCount += 1;
            }),
          });

          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(tempRoot, "tmp"), { recursive: true }),
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              for (const eventName of [
                "checking-for-update",
                "update-available",
                "update-not-available",
                "download-progress",
                "update-downloaded",
              ]) {
                yield* updater.on(eventName, (payload) => {
                  events.push({ name: eventName, payload });
                });
              }

              yield* updater.checkForUpdates;
              const available = events.find((entry) => entry.name === "update-available");
              assert.isDefined(available);
              assert.deepEqual(available?.payload, {
                version: "0.1.12",
                releaseName: "ct-v0.1.12",
                releaseNotes: "- Added CT auto-update support",
                releaseDate: "2026-11-24T00:00:00Z",
              });

              yield* updater.downloadUpdate;
              const downloaded = events.find((entry) => entry.name === "update-downloaded");
              assert.isDefined(downloaded);
              const downloadedPath = NodePath.join(
                tempRoot,
                "base",
                "runtime",
                "ct-updates",
                "T3-Code-CT-0.1.12-arm64.dmg",
              );
              const written = yield* Effect.promise(() => NodeFSP.readFile(downloadedPath));
              assert.equal(written.byteLength, payloadBytes.byteLength);

              yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
              assert.equal(quitCount, 1);
              assert.equal(spawned.length, 1);
              assert.equal(spawned[0]?.command, "/bin/bash");
              const scriptPath = spawned[0]?.args[0];
              assert.isDefined(scriptPath);
              const scriptContent = yield* Effect.promise(() =>
                NodeFSP.readFile(scriptPath!, "utf8"),
              );
              assert.include(scriptContent, downloadedPath);
              assert.include(scriptContent, "PARENT_PID=4242");
            }),
          );
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tempRoot, { recursive: true, force: true }));
        }
      }),
  );

  it.live(
    "falls back to GitHub Releases API when /releases/latest is not a ct-v tag and reports up-to-date",
    () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const fetchFn: CtUpdaterFetch = async (url, init) => {
          assert.notEqual(init?.redirect, "manual");
          if (url === "https://github.com/linas-lin/t3code/releases/latest") {
            const response = new Response(null, { status: 200 });
            Object.defineProperty(response, "url", {
              value: "https://github.com/linas-lin/t3code/releases/tag/v0.1.15",
            });
            return response;
          }
          if (url === "https://api.github.com/repos/linas-lin/t3code/releases?per_page=20") {
            return new Response(
              JSON.stringify([
                {
                  draft: false,
                  tag_name: "ct-v0.1.11",
                  assets: [
                    {
                      name: "T3-Code-CT-0.1.11-arm64.dmg",
                      browser_download_url:
                        "https://github.com/linas-lin/t3code/releases/download/ct-v0.1.11/T3-Code-CT-0.1.11-arm64.dmg",
                    },
                  ],
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(null, { status: 404 });
        };

        const updater = makeCtGithubUpdater({
          repo: "linas-lin/t3code",
          platform: "darwin",
          hostArch: "arm64",
          currentVersion: "0.1.11",
          appPath: "/Applications/T3 Code (CT).app/Contents/Resources/app.asar",
          execPath: "/Applications/T3 Code (CT).app/Contents/MacOS/T3 Code (CT)",
          baseDir: "/tmp/unused",
          logDir: "/tmp/unused-logs",
          fetchFn,
          spawnDetached: () => undefined,
          quitApp: Effect.void,
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* updater.on("update-available", () => {
              events.push("update-available");
            });
            yield* updater.on("update-not-available", () => {
              events.push("update-not-available");
            });
            yield* updater.checkForUpdates;
            assert.deepEqual(events, ["update-not-available"]);
          }),
        );
      }),
  );
});
