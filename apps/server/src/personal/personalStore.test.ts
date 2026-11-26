import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { PersonalMemoryService, layer as personalMemoryLayer } from "./PersonalMemoryService.ts";
import { derivePersonalPaths, toProjectSlug } from "./personalPaths.ts";
import { REDACTED_VALUE } from "./personalSanitizer.ts";
import {
  createPersonalStore,
  parseWorkingMarkdown,
  serializeWorkingMarkdown,
  sha256Text,
  type PersonalStore,
} from "./personalStore.ts";
import type { WorkingItem } from "./personalTypes.ts";

const runGitSubjects = Effect.fn("test.runGitSubjects")(function* (cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* spawner
    .spawn(
      ChildProcess.make("git", ["log", "--format=%s"], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .pipe(
      Effect.flatMap((handle) =>
        Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], {
          concurrency: "unbounded",
        }),
      ),
      Effect.scoped,
    );
  assert.strictEqual(result[1], 0);
  return result[0]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
});

const withTempStore = <A, E>(
  body: (
    store: PersonalStore,
    baseDir: string,
  ) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-personal-store-" });
    const paths = derivePersonalPaths(baseDir, path);
    const store = createPersonalStore({ paths, fs, path, spawner });
    return yield* body(store, baseDir);
  }).pipe(Effect.provide(NodeServices.layer));

describe("personalPaths.toProjectSlug", () => {
  it("sanitizes arbitrary project names and prevents path traversal", () => {
    assert.strictEqual(toProjectSlug("My App / v2.0"), "my-app-v2-0");
    assert.strictEqual(toProjectSlug("t3code_server"), "t3code_server");
    assert.strictEqual(toProjectSlug("../../etc/passwd"), "etc-passwd");
    assert.strictEqual(toProjectSlug(".."), "general");
    assert.strictEqual(toProjectSlug("   "), "general");
    assert.strictEqual(toProjectSlug("---___---"), "general");
    assert.strictEqual(toProjectSlug("纯中文名称"), "general");
    assert.match(toProjectSlug("a/b\\c..d?e*f"), /^[a-z0-9-_]+$/);
  });
});

describe("personalStore", () => {
  it.effect("initializes default templates, state.json, and local git repository", () =>
    withTempStore((store) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* store.ensureInitialized();

        assert.isTrue(yield* fs.exists(store.paths.guardrailsPath));
        assert.isTrue(yield* fs.exists(store.paths.profilePath));
        assert.isTrue(yield* fs.exists(store.paths.workingPath));
        assert.isTrue(yield* fs.exists(path.join(store.paths.lessonsDir, "global.md")));
        assert.isTrue(yield* fs.exists(store.paths.statePath));
        assert.isTrue(yield* fs.exists(path.join(store.paths.personalDir, ".git")));

        const guardrails = yield* store.readGuardrails();
        assert.include(guardrails, "后台自主与对外边界");
        assert.include(guardrails, "主会话对外确认");
        assert.include(guardrails, "凭据零沉淀与无痕跳过");
        assert.include(guardrails, "体验克制与防啰嗦");

        const state = yield* store.readState();
        assert.strictEqual(state.version, 1);
        assert.deepStrictEqual(state.optOutThreadIds, []);
        assert.deepStrictEqual(state.threadCursors, {});
        assert.isNull(state.lastIncrementalAt);
        assert.isNull(state.lastDailyCompactAt);

        const commits = yield* runGitSubjects(store.paths.personalDir);
        assert.deepStrictEqual(commits, ["personal: init"]);
      }),
    ),
  );

  it.effect("round-trips structured working items and handles status transitions", () =>
    withTempStore((store) =>
      Effect.gen(function* () {
        const sampleItems: ReadonlyArray<WorkingItem> = [
          {
            id: "w-alpha",
            priority: "high",
            scope: "global",
            reminded: false,
            status: "open",
            expiresAt: "2026-12-31T23:59:59.000Z",
            sourceThreadIds: ["thread-1", "thread-2"],
            createdAt: "2026-11-26T08:00:00.000Z",
            updatedAt: "2026-11-26T09:00:00.000Z",
            summary: "排查 Redis 连接抖动\n补充监控告警阈值",
          },
          {
            id: "w-beta",
            priority: "low",
            scope: "my-repo",
            reminded: true,
            status: "done",
            expiresAt: null,
            sourceThreadIds: [],
            createdAt: "2026-11-25T10:00:00.000Z",
            updatedAt: "2026-11-25T12:00:00.000Z",
            summary: "升级 Vite 依赖",
          },
        ];

        const serialized = serializeWorkingMarkdown(sampleItems);
        const parsedDirect = parseWorkingMarkdown(serialized);
        assert.deepStrictEqual(parsedDirect, sampleItems);

        yield* store.writeWorkingItems(sampleItems, "seed working items");
        const loaded = yield* store.readWorkingItems();
        assert.deepStrictEqual(loaded, sampleItems);

        const reminded = yield* store.updateWorkingItemStatus("w-alpha", "reminded");
        assert.isNotNull(reminded);
        assert.isTrue(reminded.reminded);
        assert.strictEqual(reminded.status, "open");

        const dismissed = yield* store.updateWorkingItemStatus("w-alpha", "dismiss");
        assert.isNotNull(dismissed);
        assert.strictEqual(dismissed.status, "dismissed");
        assert.isTrue(dismissed.reminded);

        const missing = yield* store.updateWorkingItemStatus("does-not-exist", "done");
        assert.isNull(missing);
      }),
    ),
  );

  it.effect(
    "commits user manual edits separately before programmatic writes without overwriting",
    () =>
      withTempStore((store) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;

          yield* store.ensureInitialized();

          // Simulate user manually editing profile.md and guardrails.md.
          const manualProfile = `${yield* store.readProfile()}\n- 用户手写习惯：偏好使用 pnpm 与中文注释。\n`;
          yield* fs.writeFileString(store.paths.profilePath, manualProfile);
          const manualGuardrails = `${yield* store.readGuardrails()}\n- 用户手写红线：发版前必须跑完整回归。\n`;
          yield* fs.writeFileString(store.paths.guardrailsPath, manualGuardrails);

          // Next programmatic write should first commit "user: manual edit", then preserve user edit and append.
          yield* store.appendGuardrail("不要修改外部生产配置", "add prod guardrail");

          const finalGuardrails = yield* store.readGuardrails();
          assert.include(finalGuardrails, "用户手写红线：发版前必须跑完整回归。");
          assert.include(finalGuardrails, "不要修改外部生产配置");

          const commits = yield* runGitSubjects(store.paths.personalDir);
          assert.deepStrictEqual(commits, [
            "personal: add prod guardrail",
            "user: manual edit",
            "personal: init",
          ]);
        }),
      ),
  );

  it.effect("searches memory with relevance scoring and scope filtering", () =>
    withTempStore((store) =>
      Effect.gen(function* () {
        yield* store.appendLesson("alpha-app", "PostgreSQL 连接池上限需要配合 pgbouncer 调整");
        yield* store.appendLesson("beta-app", "PostgreSQL 只读副本在 beta-app 中用于报表查询");
        yield* store.appendLesson("global", "排查连接池问题时优先检查长事务");
        yield* store.addNote({
          target: "working",
          content: "检查 alpha-app 的 PostgreSQL 慢查询",
          scope: "alpha-app",
          priority: "high",
          sourceThreadId: "t-1",
        });

        const alphaMatches = yield* store.searchMemory({
          query: "PostgreSQL 连接池",
          scope: "alpha-app",
          limit: 5,
        });
        assert.isAbove(alphaMatches.length, 0);
        // beta-app lesson must be excluded when filtering by alpha-app.
        assert.isFalse(alphaMatches.some((match) => match.scope === "beta-app"));
        // Exact project scope + exact phrase should rank first.
        assert.strictEqual(alphaMatches[0]?.source, "lessons/alpha-app.md");
        assert.isAbove(alphaMatches[0]?.score ?? 0, 15);
      }),
    ),
  );

  it.effect("persists thread opt-out toggles and auto-redacts secrets on write", () =>
    withTempStore((store) =>
      Effect.gen(function* () {
        const enabled = yield* store.setThreadOptOut("thread-secret", true);
        assert.deepStrictEqual(enabled.optOutThreadIds, ["thread-secret"]);

        const disabled = yield* store.setThreadOptOut("thread-secret", false);
        assert.deepStrictEqual(disabled.optOutThreadIds, []);

        const note = yield* store.addNote({
          target: "lesson",
          scope: "infra",
          content:
            "部署脚本不能硬编码 ghp_1234567890abcdefABCDEF1234567890abcd 或 password=TopSecret99",
        });
        assert.strictEqual(note.redactedCount, 2);

        const lessonContent = yield* store.readLesson("infra");
        assert.notInclude(lessonContent, "ghp_1234567890abcdefABCDEF1234567890abcd");
        assert.notInclude(lessonContent, "TopSecret99");
        assert.include(lessonContent, REDACTED_VALUE);
      }),
    ),
  );

  it.effect("does not block writes when git is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-personal-nogit-" });
      const paths = derivePersonalPaths(baseDir, path);

      const brokenSpawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "git binary not found",
          }),
        ),
      );

      const store = createPersonalStore({ paths, fs, path, spawner: brokenSpawner });
      yield* store.ensureInitialized();
      const result = yield* store.writeProfile("# Profile\n\n- 偏好简洁回复\n");
      assert.strictEqual(result.redactedCount, 0);
      assert.include(yield* store.readProfile(), "偏好简洁回复");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "PersonalMemoryService serializes reflection updates into one git snapshot and degrades safely",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-personal-service-" });
        const paths = derivePersonalPaths(baseDir, path);

        const serviceLayer = personalMemoryLayer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        );

        yield* Effect.gen(function* () {
          const service = yield* PersonalMemoryService;

          // First call initializes and builds a non-empty context.
          const initialCtx = yield* service.buildTurnContext({
            threadId: "t-main",
            projectSlug: "t3code",
            projectTitle: "T3 Code",
            nowIso: "2026-11-26T10:00:00.000Z",
          });
          assert.include(initialCtx, "<personal_context>");
          assert.include(initialCtx, "personal_memory_search");

          // Opt-out thread gets empty context.
          yield* service.setThreadOptOut("t-private", true);
          assert.isTrue(yield* service.isThreadOptOut("t-private"));
          const optOutCtx = yield* service.buildTurnContext({
            threadId: "t-private",
            projectSlug: "t3code",
            nowIso: "2026-11-26T10:00:00.000Z",
          });
          assert.strictEqual(optOutCtx, "");

          const beforeCommits = yield* runGitSubjects(paths.personalDir);

          // Apply atomic reflection update across profile + lessons + working + state in ONE snapshot.
          const applied = yield* service.applyReflectionUpdates({
            reason: "daily reflection",
            profile: "# Profile\n\n- 偏好 Effect v4 写法\n",
            lessonsAppend: {
              t3code: ["测试时使用 @effect/vitest 与 NodeServices.layer"],
            },
            workingItemsUpsert: [
              {
                id: "w-reflect-1",
                priority: "high",
                scope: "t3code",
                summary: "跟进 Personal Agent Phase 2 工具接入",
                sourceThreadIds: ["t-main"],
              },
            ],
            statePatch: {
              lastIncrementalAt: "2026-11-26T10:05:00.000Z",
              threadCursors: {
                "t-main": {
                  lastMessageCount: 12,
                  lastUpdatedAt: "2026-11-26T10:04:00.000Z",
                  lastReflectedAt: "2026-11-26T10:05:00.000Z",
                },
              },
            },
          });

          assert.isAbove(applied.updatedFiles.length, 3);
          assert.strictEqual(applied.state.lastIncrementalAt, "2026-11-26T10:05:00.000Z");

          const afterCommits = yield* runGitSubjects(paths.personalDir);
          assert.strictEqual(afterCommits.length, beforeCommits.length + 1);
          assert.strictEqual(afterCommits[0], "personal: daily reflection");

          const snapshot = yield* service.readSnapshotForReflection();
          assert.include(snapshot.profile, "偏好 Effect v4 写法");
          assert.include(snapshot.lessons["t3code"] ?? "", "@effect/vitest");
          assert.strictEqual(snapshot.workingItems.length, 1);

          const nextCtx = yield* service.buildTurnContext({
            threadId: "t-main",
            projectSlug: "t3code",
            nowIso: "2026-11-26T10:06:00.000Z",
          });
          assert.include(nextCtx, "w-reflect-1");

          // Mark reminded -> no longer injected in next turn context.
          const updatedItem = yield* service.updateWorkingItem("w-reflect-1", "reminded");
          assert.isNotNull(updatedItem);
          assert.isTrue(updatedItem.reminded);

          const afterRemindedCtx = yield* service.buildTurnContext({
            threadId: "t-main",
            projectSlug: "t3code",
            nowIso: "2026-11-26T10:07:00.000Z",
          });
          assert.notInclude(afterRemindedCtx, "w-reflect-1");
        }).pipe(Effect.provide(serviceLayer));

        // Verify buildTurnContext degrades to "" instead of failing when filesystem errors occur.
        const failingFs: FileSystem.FileSystem = {
          ...fs,
          makeDirectory: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "makeDirectory",
                description: "simulated failure",
              }),
            ),
        };
        const blockedConfigLayer = ServerConfig.layerTest(
          process.cwd(),
          path.join(baseDir, "blocked"),
        ).pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)));
        const degradedLayer = personalMemoryLayer.pipe(
          Layer.provide(blockedConfigLayer),
          Layer.provide(Layer.succeed(FileSystem.FileSystem, failingFs)),
        );
        const degradedCtx = yield* Effect.gen(function* () {
          const service = yield* PersonalMemoryService;
          return yield* service.buildTurnContext({
            threadId: "t-degraded",
            nowIso: "2026-11-26T10:08:00.000Z",
          });
        }).pipe(Effect.provide(degradedLayer));
        assert.strictEqual(degradedCtx, "");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "writes .gitignore excluding state.json and .tmp-*, keeps pure cursor/state updates out of git history, and migrates tracked state.json",
    () =>
      withTempStore((store) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

          yield* store.ensureInitialized();

          // 1. .gitignore exists and ignores state.json and .tmp-*.
          const gitignorePath = path.join(store.paths.personalDir, ".gitignore");
          assert.isTrue(yield* fs.exists(gitignorePath));
          const gitignore = yield* fs.readFileString(gitignorePath);
          assert.include(gitignore, "state.json");
          assert.include(gitignore, ".tmp-*");

          // Verify state.json is NOT tracked by git in the initial commit.
          const lsState = yield* spawner
            .spawn(
              ChildProcess.make("git", ["ls-files", "state.json"], {
                cwd: store.paths.personalDir,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              }),
            )
            .pipe(
              Effect.flatMap((handle) =>
                Effect.all(
                  [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
                  { concurrency: "unbounded" },
                ),
              ),
              Effect.scoped,
            );
          assert.strictEqual(lsState[1], 0);
          assert.strictEqual(lsState[0].trim(), "");

          const initialCommits = yield* runGitSubjects(store.paths.personalDir);
          assert.deepStrictEqual(initialCommits, ["personal: init"]);

          // 2. Pure state updates (updateState, setThreadOptOut, cursor-only applyReflectionUpdates)
          // must NOT add any git commits and must leave no .tmp-* files behind.
          yield* store.updateState((current) => ({
            ...current,
            lastIncrementalAt: "2026-11-26T11:00:00.000Z",
          }));
          yield* store.setThreadOptOut("t-private-1", true);
          yield* store.applyReflectionUpdates({
            reason: "cursor advance only",
            statePatch: {
              threadCursors: {
                "t-1": {
                  lastMessageCount: 5,
                  lastUpdatedAt: "2026-11-26T11:05:00.000Z",
                  lastReflectedAt: "2026-11-26T11:06:00.000Z",
                },
              },
            },
          });

          const commitsAfterStateOps = yield* runGitSubjects(store.paths.personalDir);
          assert.deepStrictEqual(commitsAfterStateOps, initialCommits);

          const dirEntries = yield* fs.readDirectory(store.paths.personalDir);
          assert.isFalse(dirEntries.some((name) => name.startsWith(".tmp-")));

          // 3. Simulate a legacy repo where state.json was previously tracked and user has manual edits.
          const legacyBaseDir = yield* fs.makeTempDirectoryScoped({
            prefix: "t3code-personal-legacy-git-",
          });
          const legacyPaths = derivePersonalPaths(legacyBaseDir, path);
          yield* fs.makeDirectory(legacyPaths.lessonsDir, { recursive: true });
          yield* fs.writeFileString(legacyPaths.profilePath, "# Profile\n- old\n");
          yield* fs.writeFileString(
            legacyPaths.statePath,
            `${JSON.stringify({ version: 1, threadCursors: {}, optOutThreadIds: ["t-keep"], lastIncrementalAt: null, lastDailyCompactAt: null })}\n`,
          );

          const runLegacyGit = (args: ReadonlyArray<string>) =>
            spawner
              .spawn(
                ChildProcess.make("git", args, {
                  cwd: legacyPaths.personalDir,
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                }),
              )
              .pipe(
                Effect.flatMap((handle) => handle.exitCode),
                Effect.scoped,
              );

          assert.strictEqual(yield* runLegacyGit(["init"]), 0);
          assert.strictEqual(yield* runLegacyGit(["config", "user.name", "Test"]), 0);
          assert.strictEqual(yield* runLegacyGit(["config", "user.email", "t@local.invalid"]), 0);
          assert.strictEqual(yield* runLegacyGit(["config", "commit.gpgsign", "false"]), 0);
          assert.strictEqual(yield* runLegacyGit(["add", "-A"]), 0);
          assert.strictEqual(
            yield* runLegacyGit(["commit", "--no-verify", "-m", "legacy init"]),
            0,
          );

          // User manually edits profile.md before store starts.
          yield* fs.writeFileString(
            legacyPaths.profilePath,
            "# Profile\n- old\n- manual unsaved edit\n",
          );

          const legacyStore = createPersonalStore({
            paths: legacyPaths,
            fs,
            path,
            spawner,
          });
          yield* legacyStore.ensureInitialized();

          // state.json must still exist with its data, yet be untracked in git index.
          const migratedState = yield* legacyStore.readState();
          assert.deepStrictEqual(migratedState.optOutThreadIds, ["t-keep"]);

          const legacyTracked = yield* spawner
            .spawn(
              ChildProcess.make("git", ["ls-files", "state.json"], {
                cwd: legacyPaths.personalDir,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              }),
            )
            .pipe(
              Effect.flatMap((handle) =>
                Effect.all(
                  [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
                  { concurrency: "unbounded" },
                ),
              ),
              Effect.scoped,
            );
          assert.strictEqual(legacyTracked[0].trim(), "");

          // Subsequent state updates must NOT add commits.
          const commitsAfterMigration = yield* runGitSubjects(legacyPaths.personalDir);
          yield* legacyStore.setThreadOptOut("t-keep-2", true);
          const commitsAfterUpdate = yield* runGitSubjects(legacyPaths.personalDir);
          assert.deepStrictEqual(commitsAfterUpdate, commitsAfterMigration);
          // User manual edit on profile.md must still be intact.
          assert.include(yield* legacyStore.readProfile(), "manual unsaved edit");
        }),
      ),
  );

  it.effect(
    "sets GIT_CEILING_DIRECTORIES and never pollutes a parent host git repo when local git init fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const hostDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-host-repo-" });

        const runHostGit = (args: ReadonlyArray<string>) =>
          realSpawner
            .spawn(
              ChildProcess.make("git", args, {
                cwd: hostDir,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              }),
            )
            .pipe(
              Effect.flatMap((handle) => handle.exitCode),
              Effect.scoped,
            );

        // Initialize a real parent host git repository.
        assert.strictEqual(yield* runHostGit(["init"]), 0);
        assert.strictEqual(yield* runHostGit(["config", "user.name", "Host"]), 0);
        assert.strictEqual(yield* runHostGit(["config", "user.email", "host@local.invalid"]), 0);
        assert.strictEqual(yield* runHostGit(["config", "commit.gpgsign", "false"]), 0);
        yield* fs.writeFileString(path.join(hostDir, "README.md"), "# Host Repo\n");
        assert.strictEqual(yield* runHostGit(["add", "README.md"]), 0);
        assert.strictEqual(yield* runHostGit(["commit", "--no-verify", "-m", "host: initial"]), 0);

        const paths = derivePersonalPaths(hostDir, path);
        const observedCeilings: Array<string | undefined> = [];
        const observedArgs: Array<ReadonlyArray<string>> = [];

        const initFailingSpawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) {
            const args = command.args.map((arg) => String(arg));
            observedArgs.push(args);
            const rawCeiling = command.options.env?.["GIT_CEILING_DIRECTORIES"];
            observedCeilings.push(typeof rawCeiling === "string" ? rawCeiling : undefined);
            if (args[0] === "init") {
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "ChildProcess",
                  method: "spawn",
                  description: "simulated git init failure",
                }),
              );
            }
          }
          return realSpawner.spawn(command);
        });

        const store = createPersonalStore({
          paths,
          fs,
          path,
          spawner: initFailingSpawner,
        });

        yield* store.ensureInitialized();
        yield* store.writeProfile("# Profile\n- local change without git\n", "profile write");

        // Every git invocation must explicitly set GIT_CEILING_DIRECTORIES to parent of personalDir.
        assert.isAbove(observedCeilings.length, 0);
        for (const ceiling of observedCeilings) {
          assert.strictEqual(ceiling, path.dirname(paths.personalDir));
        }

        // commitAllIfDirty must short-circuit when personalDir/.git is absent (no git add/commit invoked).
        assert.isFalse(observedArgs.some((args) => args[0] === "add" || args[0] === "commit"));
        assert.isFalse(yield* fs.exists(path.join(paths.personalDir, ".git")));

        // Parent host repository commit history must remain completely untouched.
        const hostCommits = yield* runGitSubjects(hostDir);
        assert.deepStrictEqual(hostCommits, ["host: initial"]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "applyReflectionUpdates preserves concurrent working.md edits, skips conflicting profile/lesson replaces via SHA-256 hash check, and keeps non-conflicting appends",
    () =>
      withTempStore((store) =>
        Effect.gen(function* () {
          yield* store.writeProfile("# Profile\n- 原始偏好\n", "seed profile");
          yield* store.writeLesson("t3code", "# 项目经验：t3code\n- 原始经验\n", "seed lesson");
          yield* store.upsertWorkingItem(
            {
              id: "w-to-close",
              priority: "medium",
              scope: "t3code",
              summary: "等待反思关闭的旧任务",
            },
            "seed working",
          );
          yield* store.upsertWorkingItem(
            {
              id: "w-expired",
              priority: "low",
              scope: "global",
              expiresAt: "2020-01-01T00:00:00.000Z",
              summary: "已过期的旧任务",
            },
            "seed expired working",
          );

          // Take reflection snapshot BEFORE concurrent edits happen.
          const snapshot = yield* store.readSnapshotForReflection();
          assert.isDefined(snapshot.contentHashes);
          assert.strictEqual(snapshot.contentHashes?.profile, sha256Text(snapshot.profile));
          assert.strictEqual(
            snapshot.contentHashes?.lessons["t3code"],
            sha256Text(snapshot.lessons["t3code"] ?? ""),
          );

          // Simulate concurrent edits during LLM reflection:
          // 1) Main session appends a new working item and edits profile.md & lessons/t3code.md.
          yield* store.addNote({
            target: "working",
            scope: "t3code",
            priority: "high",
            content: "主会话并发新增的紧急跟进项",
          });
          yield* store.addNote({
            target: "profile",
            content: "主会话并发新增的偏好（绝不能被旧快照覆写）",
          });
          yield* store.appendLesson("t3code", "主会话并发新增的 t3code 经验");

          // Reflection completes and attempts to apply profile replace, t3code lesson replace,
          // global lesson append, working closure, prune, and working upsert using snapshot hashes.
          const applied = yield* store.applyReflectionUpdates({
            reason: "concurrent reflection commit",
            profile: "# Profile\n- 基于旧快照生成的全量 profile（应因哈希冲突跳过）\n",
            lessonsReplace: {
              t3code: "# 项目经验：t3code\n- 基于旧快照生成的全量 lesson（应因哈希冲突跳过）\n",
            },
            lessonsAppend: {
              global: ["无冲突的全局经验追加应照常保留"],
              t3code: ["无冲突的 t3code 追加也应保留在最新内容之后"],
            },
            pruneExpiredNowIso: "2026-11-26T12:00:00.000Z",
            workingClosures: [{ id: "w-to-close", status: "done" }],
            workingItemsUpsert: [
              {
                id: "w-reflected-new",
                priority: "medium",
                scope: "global",
                summary: "反思提炼的新待办",
              },
            ],
            expectedBaseHashes: {
              profile: snapshot.contentHashes?.profile,
              lessons: snapshot.contentHashes?.lessons,
            },
          });

          // Profile replace was skipped -> concurrent profile note is preserved.
          const finalProfile = yield* store.readProfile();
          assert.include(finalProfile, "主会话并发新增的偏好（绝不能被旧快照覆写）");
          assert.notInclude(finalProfile, "应因哈希冲突跳过");
          assert.isFalse(applied.updatedFiles.includes(store.paths.profilePath));

          // t3code lesson replace was skipped, while appends to both t3code and global succeeded.
          const finalT3Lesson = yield* store.readLesson("t3code");
          assert.include(finalT3Lesson, "主会话并发新增的 t3code 经验");
          assert.include(finalT3Lesson, "无冲突的 t3code 追加也应保留在最新内容之后");
          assert.notInclude(finalT3Lesson, "应因哈希冲突跳过");
          const finalGlobalLesson = yield* store.readLesson("global");
          assert.include(finalGlobalLesson, "无冲突的全局经验追加应照常保留");

          // working.md merged live under lock: concurrent item preserved, expired pruned, closure & upsert applied.
          const finalWorking = yield* store.readWorkingItems();
          assert.isTrue(
            finalWorking.some((item) => item.summary.includes("主会话并发新增的紧急跟进项")),
          );
          assert.strictEqual(finalWorking.find((item) => item.id === "w-to-close")?.status, "done");
          assert.strictEqual(
            finalWorking.find((item) => item.id === "w-expired")?.status,
            "dismissed",
          );
          assert.strictEqual(
            finalWorking.find((item) => item.id === "w-reflected-new")?.status,
            "open",
          );
        }),
      ),
  );

  it.effect(
    "applyReflectionUpdates aborts persistence completely on TOCTOU opt-out of any reflected thread",
    () =>
      withTempStore((store) =>
        Effect.gen(function* () {
          yield* store.ensureInitialized();
          const beforeProfile = yield* store.readProfile();
          const beforeCommits = yield* runGitSubjects(store.paths.personalDir);

          // Thread is opted out right before persistence (TOCTOU race).
          yield* store.setThreadOptOut("t-opted-out-midflight", true);

          const applied = yield* store.applyReflectionUpdates({
            reason: "should abort on opt-out",
            profile: "# Profile\n- 来自无痕线程的泄露偏好\n",
            lessonsAppend: {
              global: ["来自无痕线程的泄露经验"],
            },
            workingItemsUpsert: [
              {
                id: "w-leak",
                priority: "high",
                scope: "global",
                summary: "来自无痕线程的泄露待办",
              },
            ],
            reflectedThreadIds: ["t-normal", "t-opted-out-midflight"],
            statePatch: {
              lastIncrementalAt: "2026-11-26T12:30:00.000Z",
              threadCursors: {
                "t-normal": {
                  lastMessageCount: 4,
                  lastUpdatedAt: "2026-11-26T12:20:00.000Z",
                  lastReflectedAt: "2026-11-26T12:30:00.000Z",
                },
                "t-opted-out-midflight": {
                  lastMessageCount: 2,
                  lastUpdatedAt: "2026-11-26T12:25:00.000Z",
                  lastReflectedAt: "2026-11-26T12:30:00.000Z",
                },
              },
            },
          });

          assert.deepStrictEqual(applied.updatedFiles, []);
          assert.strictEqual(applied.redactedCount, 0);
          assert.strictEqual(yield* store.readProfile(), beforeProfile);
          assert.notInclude(yield* store.readLesson("global"), "泄露经验");
          assert.deepStrictEqual(yield* store.readWorkingItems(), []);
          const state = yield* store.readState();
          assert.isNull(state.lastIncrementalAt);
          assert.isUndefined(state.threadCursors["t-opted-out-midflight"]);
          assert.isUndefined(state.threadCursors["t-normal"]);
          assert.deepStrictEqual(yield* runGitSubjects(store.paths.personalDir), beforeCommits);
        }),
      ),
  );
});
