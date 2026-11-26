import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandResolutionCache, resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../os-jank.ts";
import * as ProcessRunner from "../processRunner.ts";
import { PLUGIN_MANIFEST_FILENAME, PluginError } from "./pluginContract.ts";

const ALLOWED_GIT_PROTOCOLS = new Set(["https:", "http:", "ssh:", "git:", "file:"]);
const SCP_STYLE_GIT_URL_PATTERN = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[^\s\0]+$/;
const CONTROL_OR_SPACE_PATTERN = /[\s\0\p{Cc}]/u;
const INVALID_GIT_REF_PATTERN = /(?:\.\.|@\{|[~^:?*[\]\\]|^\/|\/$|\/\/|\.lock$)/;

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
};

const GIT_TIMEOUT = "120 seconds";
const BUILD_TIMEOUT = "300 seconds";

export type GitUrlValidationResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };

export function validateAndNormalizeGitUrl(rawUrl: string): GitUrlValidationResult {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Git URL must not be empty." };
  }
  if (trimmed.startsWith("-")) {
    return { ok: false, error: "Git URL must not start with '-'." };
  }
  if (CONTROL_OR_SPACE_PATTERN.test(trimmed)) {
    return { ok: false, error: "Git URL must not contain whitespace or control characters." };
  }
  if (trimmed.includes("::")) {
    return { ok: false, error: "Git remote helper syntax ('::') is not allowed." };
  }

  if (SCP_STYLE_GIT_URL_PATTERN.test(trimmed)) {
    const colonIndex = trimmed.indexOf(":");
    const repoPath = trimmed.slice(colonIndex + 1);
    if (repoPath.length === 0 || repoPath.startsWith("-")) {
      return { ok: false, error: "Git SSH URL has an invalid repository path." };
    }
    return { ok: true, url: trimmed };
  }

  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_GIT_PROTOCOLS.has(parsed.protocol)) {
      return {
        ok: false,
        error: `Unsupported Git URL protocol "${parsed.protocol}". Allowed: https, http, ssh, git, file, or user@host:repo.`,
      };
    }
    if (parsed.protocol !== "file:" && parsed.hostname.length === 0) {
      return { ok: false, error: "Git URL must include a hostname." };
    }
    if (parsed.protocol === "file:" && parsed.pathname.length === 0) {
      return { ok: false, error: "Git file:// URL must include a repository path." };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return {
      ok: false,
      error:
        "Invalid Git URL. Provide an https://, ssh://, git://, file://, or user@host:repo URL.",
    };
  }
}

export type GitRefValidationResult =
  | { readonly ok: true; readonly ref: string }
  | { readonly ok: false; readonly error: string };

export function validateGitRef(rawRef: string): GitRefValidationResult {
  const trimmed = rawRef.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Git ref must not be empty." };
  }
  if (trimmed.startsWith("-")) {
    return { ok: false, error: "Git ref must not start with '-'." };
  }
  if (CONTROL_OR_SPACE_PATTERN.test(trimmed) || INVALID_GIT_REF_PATTERN.test(trimmed)) {
    return { ok: false, error: `Invalid Git ref "${trimmed}".` };
  }
  return { ok: true, ref: trimmed };
}

function summarizeProcessOutput(stdout: string, stderr: string): string {
  const combined = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0).join("\n");
  if (combined.length === 0) {
    return "no output";
  }
  return combined.length > 1200 ? `...${combined.slice(-1200)}` : combined;
}

const runGit = Effect.fn("plugins.git.run")(function* (args: ReadonlyArray<string>, cwd?: string) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  return yield* processRunner
    .run({
      command: "git",
      args,
      ...(cwd !== undefined ? { cwd } : {}),
      env: GIT_ENV,
      timeout: GIT_TIMEOUT,
      outputMode: "truncate",
      maxOutputBytes: 1024 * 1024,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PluginError({
            code: "git_error",
            message: `Failed to execute git ${args[0] ?? ""}: ${cause.message}`,
            status: 500,
          }),
      ),
    );
});

export const resolvePluginExecutable = Effect.fn("plugins.resolvePluginExecutable")(function* (
  command: ReadonlyArray<string>,
) {
  const [executable, ...args] = command;
  if (!executable) {
    return yield* new PluginError({
      code: "invalid_manifest",
      message: "Command array must not be empty.",
      status: 400,
    });
  }
  if (executable !== "node") {
    return { command: executable, args };
  }

  const isExecutable = yield* HostProcess.IsExecutable;
  if (!isExecutable) {
    const currentExecPath = yield* HostProcess.ExecutablePath;
    return { command: currentExecPath, args };
  }

  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  const resolvedNode = yield* resolveCommandPath(platform === "win32" ? "node.exe" : "node", {
    env: platform === "win32" ? { ...env, PATHEXT: ".EXE" } : env,
  }).pipe(Effect.provideService(CommandResolutionCache, new Map()));

  return {
    command: resolvedNode ?? executable,
    args,
  };
});

const getGitHeadCommit = Effect.fn("plugins.git.getHeadCommit")(function* (repoDir: string) {
  const result = yield* runGit(["-C", repoDir, "rev-parse", "HEAD"]);
  if (result.code !== 0) {
    return undefined;
  }
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : undefined;
});

export const cloneGitPlugin = Effect.fn("plugins.git.clone")(function* (input: {
  readonly url: string;
  readonly ref?: string | undefined;
  readonly destinationDir: string;
}) {
  const urlCheck = validateAndNormalizeGitUrl(input.url);
  if (!urlCheck.ok) {
    return yield* new PluginError({
      code: "invalid_request",
      message: urlCheck.error,
      status: 400,
    });
  }

  let validatedRef: string | undefined;
  if (input.ref !== undefined) {
    const refCheck = validateGitRef(input.ref);
    if (!refCheck.ok) {
      return yield* new PluginError({
        code: "invalid_request",
        message: refCheck.error,
        status: 400,
      });
    }
    validatedRef = refCheck.ref;
  }

  const fs = yield* FileSystem.FileSystem;

  if (validatedRef !== undefined) {
    const shallowResult = yield* runGit([
      "clone",
      "--branch",
      validatedRef,
      "--single-branch",
      "--",
      urlCheck.url,
      input.destinationDir,
    ]);
    if (shallowResult.code === 0) {
      const commit = yield* getGitHeadCommit(input.destinationDir);
      return { url: urlCheck.url, ref: validatedRef, commit };
    }
    // Ref may be a commit SHA that `--branch` does not accept; clean up and fall back to full clone + checkout.
    yield* fs.remove(input.destinationDir, { recursive: true, force: true }).pipe(Effect.ignore);
    const fullResult = yield* runGit(["clone", "--", urlCheck.url, input.destinationDir]);
    if (fullResult.code !== 0) {
      return yield* new PluginError({
        code: "git_error",
        message: `git clone failed: ${summarizeProcessOutput(fullResult.stdout, fullResult.stderr)}`,
        status: 500,
      });
    }
    const checkoutResult = yield* runGit([
      "-C",
      input.destinationDir,
      "checkout",
      "--detach",
      validatedRef,
    ]);
    if (checkoutResult.code !== 0) {
      return yield* new PluginError({
        code: "git_error",
        message: `git checkout "${validatedRef}" failed: ${summarizeProcessOutput(checkoutResult.stdout, checkoutResult.stderr)}`,
        status: 400,
      });
    }
    const commit = yield* getGitHeadCommit(input.destinationDir);
    return { url: urlCheck.url, ref: validatedRef, commit };
  }

  const cloneResult = yield* runGit(["clone", "--", urlCheck.url, input.destinationDir]);
  if (cloneResult.code !== 0) {
    return yield* new PluginError({
      code: "git_error",
      message: `git clone failed: ${summarizeProcessOutput(cloneResult.stdout, cloneResult.stderr)}`,
      status: 500,
    });
  }
  const commit = yield* getGitHeadCommit(input.destinationDir);
  return { url: urlCheck.url, ref: undefined, commit };
});

export const updateGitPlugin = Effect.fn("plugins.git.update")(function* (input: {
  readonly repoDir: string;
  readonly ref?: string | undefined;
}) {
  const worktreeCheck = yield* runGit(["-C", input.repoDir, "rev-parse", "--is-inside-work-tree"]);
  if (worktreeCheck.code !== 0 || worktreeCheck.stdout.trim() !== "true") {
    return yield* new PluginError({
      code: "git_error",
      message: `Plugin directory is not a valid Git working tree: ${input.repoDir}`,
      status: 400,
    });
  }

  const statusResult = yield* runGit(["-C", input.repoDir, "status", "--porcelain"]);
  if (statusResult.code !== 0) {
    return yield* new PluginError({
      code: "git_error",
      message: `Failed to inspect Git worktree status: ${summarizeProcessOutput(statusResult.stdout, statusResult.stderr)}`,
      status: 500,
    });
  }
  if (statusResult.stdout.trim().length > 0) {
    return yield* new PluginError({
      code: "conflict",
      message:
        "Refusing to update plugin: local Git working tree has uncommitted or untracked changes.",
      status: 409,
    });
  }

  const beforeCommit = yield* getGitHeadCommit(input.repoDir);

  let validatedRef: string | undefined;
  if (input.ref !== undefined) {
    const refCheck = validateGitRef(input.ref);
    if (!refCheck.ok) {
      return yield* new PluginError({
        code: "invalid_request",
        message: refCheck.error,
        status: 400,
      });
    }
    validatedRef = refCheck.ref;
  }

  const fetchArgs =
    validatedRef !== undefined
      ? ["-C", input.repoDir, "fetch", "--prune", "origin", "--", validatedRef]
      : ["-C", input.repoDir, "fetch", "--prune", "origin"];
  const fetchResult = yield* runGit(fetchArgs);
  if (fetchResult.code !== 0) {
    return yield* new PluginError({
      code: "git_error",
      message: `git fetch failed: ${summarizeProcessOutput(fetchResult.stdout, fetchResult.stderr)}`,
      status: 500,
    });
  }

  const branchResult = yield* runGit([
    "-C",
    input.repoDir,
    "symbolic-ref",
    "--short",
    "-q",
    "HEAD",
  ]);
  const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : "";

  if (currentBranch.length > 0) {
    const pullArgs =
      validatedRef !== undefined
        ? ["-C", input.repoDir, "merge", "--ff-only", "FETCH_HEAD"]
        : ["-C", input.repoDir, "pull", "--ff-only"];
    const pullResult = yield* runGit(pullArgs);
    if (pullResult.code !== 0) {
      return yield* new PluginError({
        code: "conflict",
        message: `Fast-forward update failed: ${summarizeProcessOutput(pullResult.stdout, pullResult.stderr)}`,
        status: 409,
      });
    }
  } else if (validatedRef !== undefined) {
    const targetResult = yield* runGit(["-C", input.repoDir, "rev-parse", "FETCH_HEAD"]);
    if (targetResult.code !== 0) {
      return yield* new PluginError({
        code: "git_error",
        message: `Failed to resolve fetched ref "${validatedRef}".`,
        status: 500,
      });
    }
    const targetSha = targetResult.stdout.trim();
    if (beforeCommit !== targetSha) {
      const ancestorCheck = yield* runGit([
        "-C",
        input.repoDir,
        "merge-base",
        "--is-ancestor",
        "HEAD",
        targetSha,
      ]);
      if (ancestorCheck.code !== 0) {
        return yield* new PluginError({
          code: "conflict",
          message: `Refusing non-fast-forward update for detached HEAD to "${validatedRef}".`,
          status: 409,
        });
      }
      const checkoutResult = yield* runGit([
        "-C",
        input.repoDir,
        "checkout",
        "--detach",
        targetSha,
      ]);
      if (checkoutResult.code !== 0) {
        return yield* new PluginError({
          code: "git_error",
          message: `Failed to fast-forward detached HEAD: ${summarizeProcessOutput(checkoutResult.stdout, checkoutResult.stderr)}`,
          status: 500,
        });
      }
    }
  } else {
    return yield* new PluginError({
      code: "conflict",
      message: "Refusing to update plugin on a detached HEAD without a configured ref.",
      status: 409,
    });
  }

  const afterCommit = yield* getGitHeadCommit(input.repoDir);
  return {
    updated:
      beforeCommit !== undefined && afterCommit !== undefined && beforeCommit !== afterCommit,
    commit: afterCommit,
  };
});

export const validateLocalPluginDirectory = Effect.fn("plugins.validateLocalPluginDirectory")(
  function* (rawPath: string) {
    const trimmed = rawPath.trim();
    if (trimmed.length === 0) {
      return yield* new PluginError({
        code: "invalid_request",
        message: "Local plugin path must not be empty.",
        status: 400,
      });
    }
    if (trimmed.includes("\0")) {
      return yield* new PluginError({
        code: "invalid_request",
        message: "Local plugin path contains an invalid null byte.",
        status: 400,
      });
    }

    const fs = yield* FileSystem.FileSystem;
    const pathApi = yield* Path.Path;
    const expanded = yield* expandHomePath(trimmed);
    const resolved = pathApi.resolve(expanded);
    const info = yield* fs.stat(resolved).pipe(Effect.orElseSucceed(() => null));
    if (!info || info.type !== "Directory") {
      return yield* new PluginError({
        code: "invalid_request",
        message: `Local plugin directory does not exist or is not a directory: ${resolved}`,
        status: 400,
      });
    }

    const realDir = yield* fs.realPath(resolved).pipe(
      Effect.mapError(
        () =>
          new PluginError({
            code: "invalid_request",
            message: `Could not resolve local plugin directory: ${resolved}`,
            status: 400,
          }),
      ),
    );
    const manifestPath = pathApi.join(realDir, PLUGIN_MANIFEST_FILENAME);
    const manifestStat = yield* fs.stat(manifestPath).pipe(Effect.orElseSucceed(() => null));
    if (!manifestStat || manifestStat.type !== "File") {
      return yield* new PluginError({
        code: "invalid_manifest",
        message: `Missing ${PLUGIN_MANIFEST_FILENAME} in local plugin directory: ${realDir}`,
        status: 400,
      });
    }

    return realDir;
  },
);

export const runPluginBuild = Effect.fn("plugins.runPluginBuild")(function* (input: {
  readonly rootDir: string;
  readonly command: ReadonlyArray<string>;
}) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const resolved = yield* resolvePluginExecutable(input.command);
  const result = yield* processRunner
    .run({
      command: resolved.command,
      args: resolved.args,
      cwd: input.rootDir,
      timeout: BUILD_TIMEOUT,
      outputMode: "truncate",
      maxOutputBytes: 2 * 1024 * 1024,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PluginError({
            code: "build_error",
            message: `Plugin build command failed to execute: ${cause.message}`,
            status: 500,
          }),
      ),
    );

  if (result.code !== 0) {
    return yield* new PluginError({
      code: "build_error",
      message: `Plugin build failed (exit ${result.code ?? "unknown"}): ${summarizeProcessOutput(result.stdout, result.stderr)}`,
      status: 500,
    });
  }
});
