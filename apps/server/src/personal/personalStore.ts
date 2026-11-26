// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous SHA-256 hashing and temp filename entropy without expanding PersonalMemoryService layer requirements.
import * as NodeCrypto from "node:crypto";

import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  GLOBAL_MEMORY_SCOPE,
  lessonFilePath,
  normalizeMemoryScope,
  toProjectSlug,
  type PersonalPaths,
} from "./personalPaths.ts";
import { sanitizePersonalText } from "./personalSanitizer.ts";
import {
  DEFAULT_PERSONAL_STATE,
  PersonalState,
  PersonalStoreError,
  type AddNoteInput,
  type AddNoteResult,
  type MemorySearchInput,
  type MemorySearchMatch,
  type ReflectionSnapshot,
  type ReflectionUpdatesInput,
  type ReflectionUpdatesResult,
  type WorkingClosureInput,
  type WorkingItem,
  type WorkingItemUpsertInput,
  type WorkingPriority,
  type WorkingStatus,
  type WorkingUpdateAction,
} from "./personalTypes.ts";

const WORKING_START_MARKER = "<!-- working-items:start -->";
const WORKING_END_MARKER = "<!-- working-items:end -->";
const GIT_TIMEOUT = "10 seconds";
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SNIPPET_CHARS = 240;
const CLOSED_WORKING_RETENTION_DAYS = 14;
const PERSONAL_GITIGNORE_ENTRIES = ["state.json", ".tmp-*"] as const;

export function sha256Text(text: string): string {
  return NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function parseTimestampMillis(value: string | DateTime.Utc): number | null {
  if (typeof value !== "string") {
    return DateTime.toEpochMillis(value);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = DateTime.make(trimmed);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

function isWorkingItemExpired(expiresAt: string | null, nowIso: string): boolean {
  if (expiresAt === null) {
    return false;
  }
  const trimmed = expiresAt.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const expiresMs = parseTimestampMillis(trimmed);
  const nowMs = parseTimestampMillis(nowIso);
  if (expiresMs !== null && nowMs !== null) {
    return expiresMs <= nowMs;
  }
  return trimmed <= nowIso;
}

/**
 * Applies `<working_close>` directives onto existing working items without overwriting
 * summaries or creating phantom entries for unknown IDs.
 */
function applyWorkingClosures(
  existingItems: ReadonlyArray<WorkingItem>,
  closures: ReadonlyArray<WorkingClosureInput>,
  nowIso: string,
): { readonly items: ReadonlyArray<WorkingItem>; readonly changed: boolean } {
  if (closures.length === 0 || existingItems.length === 0) {
    return { items: existingItems, changed: false };
  }
  const closureMap = new Map(closures.map((directive) => [directive.id, directive.status]));
  let changed = false;
  const nextItems = existingItems.map((item) => {
    const nextStatus = closureMap.get(item.id);
    if (nextStatus === undefined) {
      return item;
    }
    if (item.status === nextStatus && item.reminded) {
      return item;
    }
    changed = true;
    return {
      ...item,
      status: nextStatus,
      reminded: true,
      updatedAt: nowIso,
    } satisfies WorkingItem;
  });
  return { items: nextItems, changed };
}

/**
 * Deterministically prunes working items for daily compaction:
 * - Marks expired `open` items as `dismissed` (and `reminded: true`).
 * - Drops already-closed (`done` / `dismissed`) items older than 14 days (history stays in git).
 */
export function pruneExpiredWorkingItems(
  items: ReadonlyArray<WorkingItem>,
  nowIso: string,
): { readonly items: ReadonlyArray<WorkingItem>; readonly changed: boolean } {
  if (items.length === 0) {
    return { items, changed: false };
  }
  const nowMs = parseTimestampMillis(nowIso);
  const retentionCutoffMs =
    nowMs !== null ? nowMs - CLOSED_WORKING_RETENTION_DAYS * 24 * 60 * 60 * 1000 : null;

  let changed = false;
  const nextItems: Array<WorkingItem> = [];

  for (const item of items) {
    if (item.status === "open" && isWorkingItemExpired(item.expiresAt, nowIso)) {
      changed = true;
      nextItems.push({
        ...item,
        status: "dismissed",
        reminded: true,
        updatedAt: nowIso,
      });
      continue;
    }

    if (item.status !== "open" && retentionCutoffMs !== null) {
      const updatedMs = parseTimestampMillis(item.updatedAt);
      if (updatedMs !== null && updatedMs <= retentionCutoffMs) {
        changed = true;
        continue;
      }
    }

    nextItems.push(item);
  }

  return { items: nextItems, changed };
}

const DEFAULT_GUARDRAILS_TEMPLATE = `# 个人红线 (Guardrails)

> 本文件由用户与个人记忆系统共同维护，优先级最高，任何任务都必须遵守。

## 默认红线

1. **后台自主与对外边界**：后台整理、预研或自动任务仅允许执行本地可逆准备（如在隔离 worktree 修改代码、运行测试与本地 commit），严禁一切对外可见操作（如 \`git push\`、发送外部消息或邮件、评论/修改远端 PR、Issue 或工单）。
2. **主会话对外确认**：在主会话中执行任何对外可见或不可逆操作前，必须先向用户完整预览内容与影响范围，经明确确认后再执行。
3. **凭据零沉淀与无痕跳过**：严禁将密码、Token、API Key、Cookie、私钥或敏感业务凭据写入任何个人记忆文件；被标记为无痕隐私（opt-out）的会话必须完全跳过上下文注入与记忆沉淀。
4. **体验克制与防啰嗦**：默认直接回答当前正事，零闲聊、不重复已确认偏好；仅当存在高相关或高优先级未提醒事项时，才在回复末尾用 1~2 行 \`P.S.\` 简短带过。
`;

export const DEFAULT_PROFILE_TEMPLATE = `# 个人画像与偏好 (Profile)

> 记录长期稳定的沟通习惯、工作流偏好与技术环境特征，可随时手动编辑。

## 沟通偏好

- 偏好直接给出结论与关键依据，避免冗长铺垫。

## 工作流与环境

- （待后续协作中逐步沉淀）
`;

const DEFAULT_WORKING_TEMPLATE = `# 当前待跟进事项 (Working Memory)

> 记录尚未完成或需要适时提醒的短期事项。可手动编辑；下方标记区块由系统按结构化格式读写。

${WORKING_START_MARKER}
${WORKING_END_MARKER}
`;

export const DEFAULT_GLOBAL_LESSONS_TEMPLATE = `# 全局经验与教训 (Global Lessons)

> 记录跨项目可复用的踩坑经验、排查套路与实践结论。
`;

const decodePersonalStateJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PersonalState));
const encodePersonalStateJson = Schema.encodeEffect(fromJsonStringPretty(PersonalState));

const WORKING_HEADER_PATTERN = /^- \[([ xX-])\] (.+)$/;

function isWorkingPriority(value: string): value is WorkingPriority {
  return value === "high" || value === "medium" || value === "low";
}

function isWorkingStatus(value: string): value is WorkingStatus {
  return value === "open" || value === "done" || value === "dismissed";
}

function checkboxForStatus(status: WorkingStatus): string {
  switch (status) {
    case "done":
      return "x";
    case "dismissed":
      return "-";
    case "open":
      return " ";
  }
}

function dedupeStrings(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const output: Array<string> = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function sanitizeWorkingItem(item: WorkingItem): {
  readonly item: WorkingItem;
  readonly redactedCount: number;
} {
  const sanitizedSummary = sanitizePersonalText(item.summary.trim());
  return {
    item: {
      ...item,
      id: item.id.trim().replace(/[|\r\n\s]+/g, "-"),
      scope: normalizeMemoryScope(item.scope),
      sourceThreadIds: dedupeStrings(item.sourceThreadIds),
      summary: sanitizedSummary.text,
    },
    redactedCount: sanitizedSummary.redactedCount,
  };
}

/**
 * Parses structured `WorkingItem` entries from `working.md`.
 * Tolerates user edits to checkboxes (`[x]` -> `done`, `[-]` -> `dismissed`) and prose
 * outside the structured list.
 */
export function parseWorkingMarkdown(markdown: string): ReadonlyArray<WorkingItem> {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const startIdx = normalized.indexOf(WORKING_START_MARKER);
  const endIdx = normalized.indexOf(WORKING_END_MARKER);
  const section =
    startIdx !== -1 && endIdx !== -1 && endIdx > startIdx
      ? normalized.slice(startIdx + WORKING_START_MARKER.length, endIdx)
      : normalized;

  const lines = section.split("\n");
  const items: Array<WorkingItem> = [];

  let current: {
    id: string;
    priority: WorkingPriority;
    scope: string;
    reminded: boolean;
    status: WorkingStatus;
    expiresAt: string | null;
    sourceThreadIds: ReadonlyArray<string>;
    createdAt: string;
    updatedAt: string;
    summaryLines: Array<string>;
  } | null = null;

  const flush = () => {
    if (current === null) {
      return;
    }
    while (
      current.summaryLines.length > 0 &&
      current.summaryLines[current.summaryLines.length - 1]?.trim() === ""
    ) {
      current.summaryLines.pop();
    }
    items.push({
      id: current.id,
      priority: current.priority,
      scope: current.scope,
      reminded: current.reminded,
      status: current.status,
      expiresAt: current.expiresAt,
      sourceThreadIds: current.sourceThreadIds,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      summary: current.summaryLines.join("\n").trim(),
    });
    current = null;
  };

  for (const line of lines) {
    const headerMatch = WORKING_HEADER_PATTERN.exec(line);
    if (headerMatch !== null) {
      const checkbox = headerMatch[1] ?? " ";
      const metaRaw = headerMatch[2] ?? "";
      const fields = new Map<string, string>();

      for (const token of metaRaw.split("|")) {
        const trimmed = token.trim();
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx <= 0) {
          continue;
        }
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        fields.set(key, value);
      }

      const id = fields.get("id");
      if (id !== undefined && id.length > 0) {
        flush();
        const rawPriority = fields.get("priority") ?? "medium";
        const priority: WorkingPriority = isWorkingPriority(rawPriority) ? rawPriority : "medium";
        const rawStatus = fields.get("status") ?? "open";
        let status: WorkingStatus = isWorkingStatus(rawStatus) ? rawStatus : "open";
        if (status === "open") {
          if (checkbox === "x" || checkbox === "X") {
            status = "done";
          } else if (checkbox === "-") {
            status = "dismissed";
          }
        }
        const scope = normalizeMemoryScope(fields.get("scope"));
        const reminded = fields.get("reminded") === "true";
        const rawExpires = fields.get("expires") ?? "none";
        const expiresAt = rawExpires === "" || rawExpires === "none" ? null : rawExpires;
        const rawThreads = fields.get("threads") ?? "none";
        const sourceThreadIds =
          rawThreads === "" || rawThreads === "none" ? [] : dedupeStrings(rawThreads.split(","));
        const createdAt = fields.get("created") ?? "";
        const updatedAt = fields.get("updated") ?? createdAt;

        current = {
          id,
          priority,
          scope,
          reminded,
          status,
          expiresAt,
          sourceThreadIds,
          createdAt,
          updatedAt,
          summaryLines: [],
        };
        continue;
      }
    }

    if (current !== null) {
      if (line.startsWith("  ")) {
        current.summaryLines.push(line.slice(2));
      } else if (line.trim().length === 0) {
        if (current.summaryLines.length > 0) {
          current.summaryLines.push("");
        }
      } else {
        flush();
      }
    }
  }

  flush();
  return items;
}

/**
 * Serializes `WorkingItem` entries into a human-readable Markdown document that
 * round-trips losslessly through `parseWorkingMarkdown`.
 */
export function serializeWorkingMarkdown(
  items: ReadonlyArray<WorkingItem>,
  existingMarkdown?: string,
): string {
  const renderedItems = items
    .map((item) => {
      const box = checkboxForStatus(item.status);
      const expires = item.expiresAt ?? "none";
      const threads = item.sourceThreadIds.length > 0 ? item.sourceThreadIds.join(",") : "none";
      const header = `- [${box}] id=${item.id} | priority=${item.priority} | scope=${normalizeMemoryScope(item.scope)} | reminded=${item.reminded ? "true" : "false"} | status=${item.status} | expires=${expires} | threads=${threads} | created=${item.createdAt} | updated=${item.updatedAt}`;
      const bodyLines = item.summary
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => (line.length > 0 ? `  ${line}` : "  "));
      return `${header}\n${bodyLines.join("\n")}`;
    })
    .join("\n\n");

  const block =
    renderedItems.length > 0
      ? `${WORKING_START_MARKER}\n${renderedItems}\n${WORKING_END_MARKER}`
      : `${WORKING_START_MARKER}\n${WORKING_END_MARKER}`;

  if (existingMarkdown !== undefined) {
    const normalized = existingMarkdown.replace(/\r\n/g, "\n");
    const startIdx = normalized.indexOf(WORKING_START_MARKER);
    const endIdx = normalized.indexOf(WORKING_END_MARKER);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const before = normalized.slice(0, startIdx);
      const after = normalized.slice(endIdx + WORKING_END_MARKER.length);
      return `${before}${block}${after}`;
    }
  }

  return `# 当前待跟进事项 (Working Memory)

> 记录尚未完成或需要适时提醒的短期事项。可手动编辑；下方标记区块由系统按结构化格式读写。

${block}
`;
}

function storeError(
  operation: string,
  targetPath?: string,
): (cause: unknown) => PersonalStoreError {
  return (cause) =>
    new PersonalStoreError({
      operation,
      ...(targetPath === undefined ? {} : { targetPath }),
      cause,
    });
}

function sanitizeCommitReason(reason: string): string {
  const cleaned = sanitizePersonalText(reason)
    .text.replace(/[\r\n]+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "update";
}

function formatBulletNote(content: string): string {
  const lines = content
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => line.trimEnd());
  if (lines.length === 0 || (lines.length === 1 && lines[0]?.trim().length === 0)) {
    return "";
  }
  const first = lines[0] ?? "";
  const hasLeadingBullet = /^[-*+]\s+|^\d+\.\s+/.test(first);
  if (hasLeadingBullet) {
    return lines.join("\n");
  }
  if (lines.length === 1) {
    return `- ${first}`;
  }
  const rest = lines.slice(1).map((line) => (line.length > 0 ? `  ${line}` : ""));
  return [`- ${first}`, ...rest].join("\n");
}

function appendSectionContent(existing: string, addition: string): string {
  const trimmedAddition = addition.trim();
  if (trimmedAddition.length === 0) {
    return existing;
  }
  const normalized = existing.replace(/\r\n/g, "\n").trimEnd();
  if (normalized.length === 0) {
    return `${trimmedAddition}\n`;
  }
  return `${normalized}\n${trimmedAddition}\n`;
}

function tokenizeQuery(query: string): ReadonlyArray<string> {
  const lower = query.trim().toLowerCase();
  if (lower.length === 0) {
    return [];
  }
  const rawTokens = lower
    .split(/[\s,.;:!?()[\]{}<>/\\|"'`~@#$%^&*+=，。；：！？（）【】《》、]+/)
    .filter((token) => token.length > 0);
  const terms = new Set<string>();
  for (const token of rawTokens) {
    terms.add(token);
    // Add CJK bigrams for multi-character CJK tokens so partial Chinese phrases match naturally.
    if (/[\u4e00-\u9fff]{3,}/.test(token)) {
      for (let i = 0; i < token.length - 1; i += 1) {
        const bigram = token.slice(i, i + 2);
        if (/^[\u4e00-\u9fff]{2}$/.test(bigram)) {
          terms.add(bigram);
        }
      }
    }
  }
  return [...terms];
}

function truncateSnippet(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_SNIPPET_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

function scoreLine(
  line: string,
  queryTrimmed: string,
  queryLower: string,
  tokens: ReadonlyArray<string>,
  sourceBoost: number,
  scopeBoost: number,
): number {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed === WORKING_START_MARKER || trimmed === WORKING_END_MARKER) {
    return 0;
  }
  const lineLower = trimmed.toLowerCase();
  let matchScore = 0;

  if (lineLower.includes(queryLower)) {
    matchScore += 10;
    if (trimmed.includes(queryTrimmed)) {
      matchScore += 2;
    }
  }

  let matchedTokens = 0;
  for (const token of tokens) {
    if (lineLower.includes(token)) {
      matchedTokens += 1;
      matchScore += 3;
    }
  }

  if (matchScore === 0) {
    return 0;
  }

  const coverageBonus = tokens.length > 0 ? (matchedTokens / tokens.length) * 5 : 0;
  return Number((matchScore + coverageBonus + sourceBoost + scopeBoost).toFixed(2));
}

export interface PersonalStoreDeps {
  readonly paths: PersonalPaths;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

export interface PersonalStore {
  readonly paths: PersonalPaths;
  readonly ensureInitialized: () => Effect.Effect<void, PersonalStoreError>;
  readonly readGuardrails: () => Effect.Effect<string, PersonalStoreError>;
  readonly readProfile: () => Effect.Effect<string, PersonalStoreError>;
  readonly writeProfile: (
    content: string,
    reason?: string,
  ) => Effect.Effect<{ readonly redactedCount: number }, PersonalStoreError>;
  readonly appendGuardrail: (
    rule: string,
    reason?: string,
  ) => Effect.Effect<{ readonly redactedCount: number }, PersonalStoreError>;
  readonly listLessons: () => Effect.Effect<ReadonlyArray<string>, PersonalStoreError>;
  readonly readLesson: (scope: string) => Effect.Effect<string, PersonalStoreError>;
  readonly appendLesson: (
    scope: string,
    content: string,
    reason?: string,
  ) => Effect.Effect<
    { readonly path: string; readonly scope: string; readonly redactedCount: number },
    PersonalStoreError
  >;
  readonly writeLesson: (
    scope: string,
    content: string,
    reason?: string,
  ) => Effect.Effect<
    { readonly path: string; readonly scope: string; readonly redactedCount: number },
    PersonalStoreError
  >;
  readonly readWorkingItems: () => Effect.Effect<ReadonlyArray<WorkingItem>, PersonalStoreError>;
  readonly writeWorkingItems: (
    items: ReadonlyArray<WorkingItem>,
    reason?: string,
  ) => Effect.Effect<
    { readonly items: ReadonlyArray<WorkingItem>; readonly redactedCount: number },
    PersonalStoreError
  >;
  readonly upsertWorkingItem: (
    input: WorkingItemUpsertInput,
    reason?: string,
  ) => Effect.Effect<
    { readonly item: WorkingItem; readonly redactedCount: number },
    PersonalStoreError
  >;
  readonly updateWorkingItemStatus: (
    id: string,
    action: WorkingUpdateAction,
    reason?: string,
  ) => Effect.Effect<WorkingItem | null, PersonalStoreError>;
  readonly readState: () => Effect.Effect<PersonalState, PersonalStoreError>;
  readonly updateState: (
    updater: (current: PersonalState) => PersonalState,
    reason?: string,
  ) => Effect.Effect<PersonalState, PersonalStoreError>;
  readonly setThreadOptOut: (
    threadId: string,
    optOut: boolean,
    reason?: string,
  ) => Effect.Effect<PersonalState, PersonalStoreError>;
  readonly searchMemory: (
    input: MemorySearchInput,
  ) => Effect.Effect<ReadonlyArray<MemorySearchMatch>, PersonalStoreError>;
  readonly addNote: (input: AddNoteInput) => Effect.Effect<AddNoteResult, PersonalStoreError>;
  readonly readSnapshotForReflection: () => Effect.Effect<ReflectionSnapshot, PersonalStoreError>;
  readonly applyReflectionUpdates: (
    input: ReflectionUpdatesInput,
  ) => Effect.Effect<ReflectionUpdatesResult, PersonalStoreError>;
}

export function createPersonalStore(deps: PersonalStoreDeps): PersonalStore {
  const { paths, fs, path, spawner } = deps;
  let itemSequence = 0;

  const nextItemId = Effect.fn("personalStore.nextItemId")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    itemSequence += 1;
    return `w-${nowMs.toString(36)}-${itemSequence.toString(36)}`;
  });

  const nowIsoString = Effect.fn("personalStore.nowIsoString")(function* () {
    return DateTime.formatIso(yield* DateTime.now);
  });

  const runGit = Effect.fn("personalStore.runGit")(function* (args: ReadonlyArray<string>) {
    const command = ChildProcess.make("git", args, {
      cwd: paths.personalDir,
      extendEnv: true,
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CEILING_DIRECTORIES: path.dirname(paths.personalDir),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    return yield* spawner.spawn(command).pipe(
      Effect.flatMap((handle) =>
        Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        ),
      ),
      Effect.map(([stdout, stderr, exitCode]) => ({
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
      })),
      Effect.scoped,
      Effect.timeout(GIT_TIMEOUT),
      Effect.catch((cause) =>
        Effect.logWarning("Personal memory git command failed; continuing without blocking.", {
          args,
          cause,
        }).pipe(
          Effect.as({
            ok: false,
            exitCode: -1,
            stdout: "",
            stderr: String(cause),
          }),
        ),
      ),
    );
  });

  const commitAllIfDirty = Effect.fn("personalStore.commitAllIfDirty")(function* (message: string) {
    const gitDir = path.join(paths.personalDir, ".git");
    const hasGit = yield* fs.exists(gitDir).pipe(Effect.orElseSucceed(() => false));
    if (!hasGit) {
      return;
    }
    const status = yield* runGit(["status", "--porcelain"]);
    if (!status.ok) {
      yield* Effect.logWarning("Personal memory git status check failed; skipping snapshot.", {
        stderr: status.stderr.trim(),
      });
      return;
    }
    if (status.stdout.trim().length === 0) {
      return;
    }
    const added = yield* runGit(["add", "-A"]);
    if (!added.ok) {
      yield* Effect.logWarning("Personal memory git add failed; skipping snapshot.", {
        stderr: added.stderr.trim(),
      });
      return;
    }
    const committed = yield* runGit(["commit", "--no-verify", "-m", message]);
    if (!committed.ok) {
      yield* Effect.logWarning("Personal memory git commit failed; continuing without blocking.", {
        message,
        stderr: committed.stderr.trim(),
      });
    }
  });

  const writeFileAtomic = Effect.fn("personalStore.writeFileAtomic")(function* (
    filePath: string,
    content: string,
    operation: string,
  ) {
    const dir = path.dirname(filePath);
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.mapError(storeError(operation, filePath)));
    const tmpPath = path.join(
      dir,
      `.tmp-${process.pid}-${NodeCrypto.randomBytes(6).toString("hex")}`,
    );
    yield* fs.writeFileString(tmpPath, content).pipe(
      Effect.andThen(fs.rename(tmpPath, filePath)),
      Effect.onError(() => fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(storeError(operation, filePath)),
    );
  });

  const ensureGitIgnore = Effect.fn("personalStore.ensureGitIgnore")(function* () {
    const gitignorePath = path.join(paths.personalDir, ".gitignore");
    const exists = yield* fs.exists(gitignorePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      yield* writeFileAtomic(
        gitignorePath,
        `${PERSONAL_GITIGNORE_ENTRIES.join("\n")}\n`,
        "ensureGitIgnore",
      );
      return true;
    }
    const raw = yield* fs
      .readFileString(gitignorePath)
      .pipe(Effect.mapError(storeError("readGitIgnore", gitignorePath)));
    const normalized = raw.replace(/\r\n/g, "\n");
    const existingLines = new Set(normalized.split("\n").map((line) => line.trim()));
    const missing = PERSONAL_GITIGNORE_ENTRIES.filter((entry) => !existingLines.has(entry));
    if (missing.length === 0) {
      return false;
    }
    const base = normalized.trimEnd();
    const next = base.length > 0 ? `${base}\n${missing.join("\n")}\n` : `${missing.join("\n")}\n`;
    yield* writeFileAtomic(gitignorePath, next, "ensureGitIgnore");
    return true;
  });

  let gitInitializedChecked = false;

  const ensureGitInitialized = Effect.fn("personalStore.ensureGitInitialized")(function* (
    gitignoreChanged: boolean,
  ) {
    const gitDir = path.join(paths.personalDir, ".git");
    const hasGit = yield* fs.exists(gitDir).pipe(Effect.orElseSucceed(() => false));
    if (!hasGit) {
      gitInitializedChecked = false;
      const init = yield* runGit(["init"]);
      if (!init.ok) {
        yield* Effect.logWarning("Personal memory git init failed; snapshots disabled.", {
          stderr: init.stderr.trim(),
        });
        return;
      }
      yield* runGit(["config", "user.name", "CT Code Personal"]);
      yield* runGit(["config", "user.email", "personal@local.invalid"]);
      yield* runGit(["config", "commit.gpgsign", "false"]);
      yield* commitAllIfDirty("personal: init");
      gitInitializedChecked = true;
      return;
    }

    if (gitInitializedChecked && !gitignoreChanged) {
      return;
    }

    // Ensure state.json is never tracked in upgraded repositories while preserving the file on disk
    // and leaving any unstaged user manual edits untouched.
    const tracked = yield* runGit(["ls-files", "--error-unmatch", "state.json"]);
    if (tracked.ok) {
      yield* runGit(["rm", "--cached", "--ignore-unmatch", "state.json"]);
      yield* runGit(["add", ".gitignore"]);
      const staged = yield* runGit(["diff", "--cached", "--name-only"]);
      if (staged.ok && staged.stdout.trim().length > 0) {
        const committed = yield* runGit([
          "commit",
          "--no-verify",
          "-m",
          "personal: untrack state.json",
        ]);
        if (!committed.ok) {
          yield* Effect.logWarning("Failed to commit untracking of state.json; continuing.", {
            stderr: committed.stderr.trim(),
          });
        }
      }
    } else if (gitignoreChanged) {
      const status = yield* runGit(["status", "--porcelain", "--", ".gitignore"]);
      if (status.ok && status.stdout.trim().length > 0) {
        yield* runGit(["add", ".gitignore"]);
        const staged = yield* runGit(["diff", "--cached", "--name-only", "--", ".gitignore"]);
        if (staged.ok && staged.stdout.trim().length > 0) {
          const committed = yield* runGit([
            "commit",
            "--no-verify",
            "-m",
            "personal: ignore runtime state",
          ]);
          if (!committed.ok) {
            yield* Effect.logWarning("Failed to commit personal .gitignore update; continuing.", {
              stderr: committed.stderr.trim(),
            });
          }
        }
      }
    }

    gitInitializedChecked = true;
  });

  const writeSanitizedFile = Effect.fn("personalStore.writeSanitizedFile")(function* (
    filePath: string,
    rawContent: string,
    operation: string,
  ) {
    const sanitized = sanitizePersonalText(rawContent);
    yield* writeFileAtomic(filePath, sanitized.text, operation);
    return sanitized;
  });

  const writeStateFileRaw = Effect.fn("personalStore.writeStateFileRaw")(function* (
    state: PersonalState,
  ) {
    const encoded = yield* encodePersonalStateJson(state).pipe(
      Effect.mapError(storeError("encodeState", paths.statePath)),
    );
    yield* writeSanitizedFile(paths.statePath, `${encoded}\n`, "writeState");
  });

  const ensureFileIfMissing = Effect.fn("personalStore.ensureFileIfMissing")(function* (
    filePath: string,
    defaultContent: string,
  ) {
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      yield* writeSanitizedFile(filePath, defaultContent, "ensureFileIfMissing");
    }
  });

  const ensureInitialized = Effect.fn("personalStore.ensureInitialized")(function* () {
    yield* fs
      .makeDirectory(paths.personalDir, { recursive: true })
      .pipe(Effect.mapError(storeError("mkdirPersonalDir", paths.personalDir)));
    yield* fs
      .makeDirectory(paths.lessonsDir, { recursive: true })
      .pipe(Effect.mapError(storeError("mkdirLessonsDir", paths.lessonsDir)));

    yield* fs.chmod(paths.personalDir, 0o700).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not restrict personal directory permissions to 0700.", {
          personalDir: paths.personalDir,
          cause,
        }),
      ),
    );

    const gitignoreChanged = yield* ensureGitIgnore();

    yield* ensureFileIfMissing(paths.guardrailsPath, DEFAULT_GUARDRAILS_TEMPLATE);
    yield* ensureFileIfMissing(paths.profilePath, DEFAULT_PROFILE_TEMPLATE);
    yield* ensureFileIfMissing(paths.workingPath, DEFAULT_WORKING_TEMPLATE);
    yield* ensureFileIfMissing(
      lessonFilePath(paths, GLOBAL_MEMORY_SCOPE, path),
      DEFAULT_GLOBAL_LESSONS_TEMPLATE,
    );

    const hasState = yield* fs.exists(paths.statePath).pipe(Effect.orElseSucceed(() => false));
    if (!hasState) {
      yield* writeStateFileRaw(DEFAULT_PERSONAL_STATE);
    }

    yield* ensureGitInitialized(gitignoreChanged);
  });

  const withGitSnapshot = Effect.fn("personalStore.withGitSnapshot")(function* <A>(
    reason: string,
    writeEffect: Effect.Effect<A, PersonalStoreError>,
  ) {
    yield* ensureInitialized();
    yield* commitAllIfDirty("user: manual edit");
    const result = yield* writeEffect;
    yield* commitAllIfDirty(`personal: ${sanitizeCommitReason(reason)}`);
    return result;
  });

  const readTextFile = Effect.fn("personalStore.readTextFile")(function* (
    filePath: string,
    operation: string,
  ) {
    return yield* fs
      .readFileString(filePath)
      .pipe(Effect.mapError(storeError(operation, filePath)));
  });

  const readTextFileIfExists = Effect.fn("personalStore.readTextFileIfExists")(function* (
    filePath: string,
    operation: string,
  ) {
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return "";
    }
    return yield* readTextFile(filePath, operation);
  });

  const readGuardrails = Effect.fn("personalStore.readGuardrails")(function* () {
    yield* ensureInitialized();
    return yield* readTextFile(paths.guardrailsPath, "readGuardrails");
  });

  const readProfile = Effect.fn("personalStore.readProfile")(function* () {
    yield* ensureInitialized();
    return yield* readTextFile(paths.profilePath, "readProfile");
  });

  const writeProfile = Effect.fn("personalStore.writeProfile")(function* (
    content: string,
    reason = "update profile",
  ) {
    return yield* withGitSnapshot(
      reason,
      writeSanitizedFile(paths.profilePath, content, "writeProfile").pipe(
        Effect.map((sanitized) => ({ redactedCount: sanitized.redactedCount })),
      ),
    );
  });

  const appendGuardrail = Effect.fn("personalStore.appendGuardrail")(function* (
    rule: string,
    reason = "append guardrail",
  ) {
    return yield* withGitSnapshot(
      reason,
      Effect.gen(function* () {
        const sanitizedRule = sanitizePersonalText(rule);
        const bullet = formatBulletNote(sanitizedRule.text);
        if (bullet.length === 0) {
          return { redactedCount: sanitizedRule.redactedCount };
        }
        const current = yield* readTextFileIfExists(paths.guardrailsPath, "readGuardrails");
        const next = appendSectionContent(current, bullet);
        yield* writeSanitizedFile(paths.guardrailsPath, next, "appendGuardrail");
        return { redactedCount: sanitizedRule.redactedCount };
      }),
    );
  });

  const listLessons = Effect.fn("personalStore.listLessons")(function* () {
    yield* ensureInitialized();
    const entries = yield* fs
      .readDirectory(paths.lessonsDir)
      .pipe(Effect.mapError(storeError("listLessons", paths.lessonsDir)));

    const scopes = entries
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort((a, b) => {
        if (a === GLOBAL_MEMORY_SCOPE && b !== GLOBAL_MEMORY_SCOPE) return -1;
        if (b === GLOBAL_MEMORY_SCOPE && a !== GLOBAL_MEMORY_SCOPE) return 1;
        return a.localeCompare(b);
      });
    return scopes;
  });

  const readLesson = Effect.fn("personalStore.readLesson")(function* (scope: string) {
    yield* ensureInitialized();
    const targetPath = lessonFilePath(paths, scope, path);
    return yield* readTextFileIfExists(targetPath, "readLesson");
  });

  const writeLesson = Effect.fn("personalStore.writeLesson")(function* (
    scope: string,
    content: string,
    reason?: string,
  ) {
    const normalizedScope = normalizeMemoryScope(scope);
    const targetPath = lessonFilePath(paths, normalizedScope, path);
    return yield* withGitSnapshot(
      reason ?? `update lesson (${normalizedScope})`,
      writeSanitizedFile(targetPath, content, "writeLesson").pipe(
        Effect.map((sanitized) => ({
          path: targetPath,
          scope: normalizedScope,
          redactedCount: sanitized.redactedCount,
        })),
      ),
    );
  });

  const appendLesson = Effect.fn("personalStore.appendLesson")(function* (
    scope: string,
    content: string,
    reason?: string,
  ) {
    const normalizedScope = normalizeMemoryScope(scope);
    const targetPath = lessonFilePath(paths, normalizedScope, path);
    return yield* withGitSnapshot(
      reason ?? `append lesson (${normalizedScope})`,
      Effect.gen(function* () {
        const sanitized = sanitizePersonalText(content);
        const bullet = formatBulletNote(sanitized.text);
        const existing = yield* readTextFileIfExists(targetPath, "readLesson");
        const base =
          existing.trim().length > 0
            ? existing
            : normalizedScope === GLOBAL_MEMORY_SCOPE
              ? DEFAULT_GLOBAL_LESSONS_TEMPLATE
              : `# 项目经验：${normalizedScope}\n`;
        const next = bullet.length > 0 ? appendSectionContent(base, bullet) : base;
        yield* writeSanitizedFile(targetPath, next, "appendLesson");
        return {
          path: targetPath,
          scope: normalizedScope,
          redactedCount: sanitized.redactedCount,
        };
      }),
    );
  });

  const readWorkingItemsRaw = Effect.fn("personalStore.readWorkingItemsRaw")(function* () {
    const content = yield* readTextFileIfExists(paths.workingPath, "readWorkingItems");
    return parseWorkingMarkdown(content);
  });

  const readWorkingItems = Effect.fn("personalStore.readWorkingItems")(function* () {
    yield* ensureInitialized();
    return yield* readWorkingItemsRaw();
  });

  const writeWorkingItemsRaw = Effect.fn("personalStore.writeWorkingItemsRaw")(function* (
    items: ReadonlyArray<WorkingItem>,
  ) {
    let redactedCount = 0;
    const sanitizedItems: Array<WorkingItem> = [];
    for (const item of items) {
      const sanitized = sanitizeWorkingItem(item);
      redactedCount += sanitized.redactedCount;
      sanitizedItems.push(sanitized.item);
    }
    const existing = yield* readTextFileIfExists(paths.workingPath, "readWorkingItems");
    const rendered = serializeWorkingMarkdown(sanitizedItems, existing);
    const written = yield* writeSanitizedFile(paths.workingPath, rendered, "writeWorkingItems");
    return {
      items: sanitizedItems,
      redactedCount: redactedCount + written.redactedCount,
    };
  });

  const writeWorkingItems = Effect.fn("personalStore.writeWorkingItems")(function* (
    items: ReadonlyArray<WorkingItem>,
    reason = "update working items",
  ) {
    return yield* withGitSnapshot(reason, writeWorkingItemsRaw(items));
  });

  const mergeWorkingItemUpsert = Effect.fn("personalStore.mergeWorkingItemUpsert")(function* (
    items: ReadonlyArray<WorkingItem>,
    input: WorkingItemUpsertInput,
  ) {
    const nowIso = yield* nowIsoString();
    const sanitizedSummary = sanitizePersonalText(input.summary.trim());
    const targetId = input.id?.trim();
    const existingIndex =
      targetId !== undefined && targetId.length > 0
        ? items.findIndex((item) => item.id === targetId)
        : -1;

    if (existingIndex >= 0) {
      const existing = items[existingIndex]!;
      const updated: WorkingItem = {
        id: existing.id,
        priority: input.priority ?? existing.priority,
        scope: input.scope !== undefined ? normalizeMemoryScope(input.scope) : existing.scope,
        reminded: input.reminded ?? existing.reminded,
        status: input.status ?? existing.status,
        expiresAt: input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt,
        sourceThreadIds: dedupeStrings([
          ...existing.sourceThreadIds,
          ...(input.sourceThreadIds ?? []),
        ]),
        createdAt: existing.createdAt,
        updatedAt: nowIso,
        summary: sanitizedSummary.text,
      };
      const nextItems = items.map((item, idx) => (idx === existingIndex ? updated : item));
      return {
        items: nextItems,
        item: updated,
        redactedCount: sanitizedSummary.redactedCount,
      };
    }

    const generatedId =
      targetId !== undefined && targetId.length > 0 ? targetId : yield* nextItemId();
    const created: WorkingItem = {
      id: generatedId.replace(/[|\r\n\s]+/g, "-"),
      priority: input.priority ?? "medium",
      scope: normalizeMemoryScope(input.scope),
      reminded: input.reminded ?? false,
      status: input.status ?? "open",
      expiresAt: input.expiresAt ?? null,
      sourceThreadIds: dedupeStrings(input.sourceThreadIds ?? []),
      createdAt: nowIso,
      updatedAt: nowIso,
      summary: sanitizedSummary.text,
    };
    return {
      items: [...items, created],
      item: created,
      redactedCount: sanitizedSummary.redactedCount,
    };
  });

  const upsertWorkingItem = Effect.fn("personalStore.upsertWorkingItem")(function* (
    input: WorkingItemUpsertInput,
    reason = "upsert working item",
  ) {
    return yield* withGitSnapshot(
      reason,
      Effect.gen(function* () {
        const current = yield* readWorkingItemsRaw();
        const merged = yield* mergeWorkingItemUpsert(current, input);
        const written = yield* writeWorkingItemsRaw(merged.items);
        return {
          item: merged.item,
          redactedCount: merged.redactedCount + written.redactedCount,
        };
      }),
    );
  });

  const updateWorkingItemStatus = Effect.fn("personalStore.updateWorkingItemStatus")(function* (
    id: string,
    action: WorkingUpdateAction,
    reason?: string,
  ) {
    yield* ensureInitialized();
    const preview = yield* readWorkingItemsRaw();
    if (!preview.some((item) => item.id === id)) {
      return null;
    }

    return yield* withGitSnapshot(
      reason ?? `mark working item ${id} ${action}`,
      Effect.gen(function* () {
        const current = yield* readWorkingItemsRaw();
        const index = current.findIndex((item) => item.id === id);
        if (index < 0) {
          return null;
        }
        const nowIso = yield* nowIsoString();
        const existing = current[index]!;
        const updated: WorkingItem =
          action === "reminded"
            ? { ...existing, reminded: true, updatedAt: nowIso }
            : action === "done"
              ? { ...existing, status: "done", reminded: true, updatedAt: nowIso }
              : { ...existing, status: "dismissed", reminded: true, updatedAt: nowIso };
        const nextItems = current.map((item, idx) => (idx === index ? updated : item));
        yield* writeWorkingItemsRaw(nextItems);
        return updated;
      }),
    );
  });

  const readStateRaw = Effect.fn("personalStore.readStateRaw")(function* () {
    const raw = yield* readTextFileIfExists(paths.statePath, "readState");
    if (raw.trim().length === 0) {
      return DEFAULT_PERSONAL_STATE;
    }
    return yield* decodePersonalStateJson(raw).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Personal memory state.json is invalid; falling back to defaults.", {
          statePath: paths.statePath,
          cause,
        }).pipe(Effect.as(DEFAULT_PERSONAL_STATE)),
      ),
    );
  });

  const readState = Effect.fn("personalStore.readState")(function* () {
    yield* ensureInitialized();
    return yield* readStateRaw();
  });

  const updateState = Effect.fn("personalStore.updateState")(function* (
    updater: (current: PersonalState) => PersonalState,
    _reason = "update state",
  ) {
    yield* ensureInitialized();
    const current = yield* readStateRaw();
    const nextRaw = updater(current);
    const next: PersonalState = {
      ...nextRaw,
      version: 1,
      optOutThreadIds: dedupeStrings(nextRaw.optOutThreadIds),
    };
    yield* writeStateFileRaw(next);
    return next;
  });

  const setThreadOptOut = Effect.fn("personalStore.setThreadOptOut")(function* (
    threadId: string,
    optOut: boolean,
    reason?: string,
  ) {
    const trimmedThreadId = threadId.trim();
    return yield* updateState(
      (current) => {
        const nextIds = optOut
          ? dedupeStrings([...current.optOutThreadIds, trimmedThreadId])
          : current.optOutThreadIds.filter((id) => id !== trimmedThreadId);
        return {
          ...current,
          optOutThreadIds: nextIds,
        };
      },
      reason ?? `${optOut ? "enable" : "disable"} thread privacy (${trimmedThreadId})`,
    );
  });

  const searchMemory = Effect.fn("personalStore.searchMemory")(function* (
    input: MemorySearchInput,
  ) {
    yield* ensureInitialized();
    const queryTrimmed = input.query.trim();
    if (queryTrimmed.length === 0) {
      return [] as ReadonlyArray<MemorySearchMatch>;
    }
    const queryLower = queryTrimmed.toLowerCase();
    const tokens = tokenizeQuery(queryTrimmed);
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_SEARCH_LIMIT));
    const rawScopeFilter = input.scope?.trim() ?? "";
    const filterScope =
      rawScopeFilter.length === 0 || rawScopeFilter === "*" || rawScopeFilter === "all"
        ? null
        : rawScopeFilter.toLowerCase() === GLOBAL_MEMORY_SCOPE
          ? GLOBAL_MEMORY_SCOPE
          : toProjectSlug(rawScopeFilter);

    const matches: Array<MemorySearchMatch> = [];

    const scanDocument = (
      source: string,
      docScope: string,
      content: string,
      sourceBoost: number,
    ) => {
      if (filterScope !== null && docScope !== GLOBAL_MEMORY_SCOPE && docScope !== filterScope) {
        return;
      }
      const scopeBoost =
        filterScope !== null && docScope === filterScope && filterScope !== GLOBAL_MEMORY_SCOPE
          ? 2
          : 0;
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        const score = scoreLine(line, queryTrimmed, queryLower, tokens, sourceBoost, scopeBoost);
        if (score > 0) {
          matches.push({
            source,
            scope: docScope,
            line: i + 1,
            snippet: truncateSnippet(line),
            score,
          });
        }
      }
    };

    const [guardrails, profile, workingRaw, lessonScopes] = yield* Effect.all(
      [
        readTextFileIfExists(paths.guardrailsPath, "readGuardrails"),
        readTextFileIfExists(paths.profilePath, "readProfile"),
        readTextFileIfExists(paths.workingPath, "readWorkingItems"),
        listLessons(),
      ],
      { concurrency: "unbounded" },
    );

    scanDocument("guardrails.md", GLOBAL_MEMORY_SCOPE, guardrails, 1.5);
    scanDocument("profile.md", GLOBAL_MEMORY_SCOPE, profile, 1.0);

    // Scan working.md with per-item scope awareness so scope filtering stays accurate.
    const workingLines = workingRaw.replace(/\r\n/g, "\n").split("\n");
    let activeItemScope = GLOBAL_MEMORY_SCOPE;
    for (let i = 0; i < workingLines.length; i += 1) {
      const line = workingLines[i] ?? "";
      const headerMatch = WORKING_HEADER_PATTERN.exec(line);
      if (headerMatch !== null) {
        const scopeToken = /scope=([^\s|]+)/.exec(headerMatch[2] ?? "");
        activeItemScope = normalizeMemoryScope(scopeToken?.[1]);
      } else if (!line.startsWith("  ") && line.trim().length > 0) {
        activeItemScope = GLOBAL_MEMORY_SCOPE;
      }

      if (
        filterScope !== null &&
        activeItemScope !== GLOBAL_MEMORY_SCOPE &&
        activeItemScope !== filterScope
      ) {
        continue;
      }
      const scopeBoost =
        filterScope !== null &&
        activeItemScope === filterScope &&
        filterScope !== GLOBAL_MEMORY_SCOPE
          ? 2
          : 0;
      const score = scoreLine(line, queryTrimmed, queryLower, tokens, 1.2, scopeBoost);
      if (score > 0) {
        matches.push({
          source: "working.md",
          scope: activeItemScope,
          line: i + 1,
          snippet: truncateSnippet(line),
          score,
        });
      }
    }

    const lessonContents = yield* Effect.forEach(
      lessonScopes,
      (lessonScope) =>
        readTextFileIfExists(lessonFilePath(paths, lessonScope, path), "readLesson").pipe(
          Effect.map((content) => ({ scope: lessonScope, content })),
        ),
      { concurrency: "unbounded" },
    );

    for (const lesson of lessonContents) {
      const boost = lesson.scope === GLOBAL_MEMORY_SCOPE ? 0.8 : 1.5;
      scanDocument(`lessons/${lesson.scope}.md`, lesson.scope, lesson.content, boost);
    }

    matches.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const sourceCmp = a.source.localeCompare(b.source);
      if (sourceCmp !== 0) return sourceCmp;
      return a.line - b.line;
    });

    return matches.slice(0, limit);
  });

  const addNote = Effect.fn("personalStore.addNote")(function* (input: AddNoteInput) {
    const normalizedScope = normalizeMemoryScope(input.scope);

    switch (input.target) {
      case "guardrails": {
        const result = yield* appendGuardrail(input.content, "add guardrail note");
        return {
          target: "guardrails",
          path: paths.guardrailsPath,
          scope: GLOBAL_MEMORY_SCOPE,
          redactedCount: result.redactedCount,
        } satisfies AddNoteResult;
      }
      case "profile": {
        const result = yield* withGitSnapshot(
          "add profile note",
          Effect.gen(function* () {
            const sanitized = sanitizePersonalText(input.content);
            const bullet = formatBulletNote(sanitized.text);
            if (bullet.length === 0) {
              return { redactedCount: sanitized.redactedCount };
            }
            const current = yield* readTextFileIfExists(paths.profilePath, "readProfile");
            const next = appendSectionContent(current, bullet);
            yield* writeSanitizedFile(paths.profilePath, next, "addProfileNote");
            return { redactedCount: sanitized.redactedCount };
          }),
        );
        return {
          target: "profile",
          path: paths.profilePath,
          scope: GLOBAL_MEMORY_SCOPE,
          redactedCount: result.redactedCount,
        } satisfies AddNoteResult;
      }
      case "lesson": {
        const result = yield* appendLesson(normalizedScope, input.content, "add lesson note");
        return {
          target: "lesson",
          path: result.path,
          scope: result.scope,
          redactedCount: result.redactedCount,
        } satisfies AddNoteResult;
      }
      case "working": {
        const result = yield* upsertWorkingItem(
          {
            summary: input.content,
            scope: normalizedScope,
            ...(input.priority === undefined ? {} : { priority: input.priority }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            ...(input.sourceThreadId !== undefined && input.sourceThreadId !== null
              ? { sourceThreadIds: [input.sourceThreadId] }
              : {}),
          },
          "add working note",
        );
        return {
          target: "working",
          path: paths.workingPath,
          scope: result.item.scope,
          redactedCount: result.redactedCount,
          workingItem: result.item,
        } satisfies AddNoteResult;
      }
    }
  });

  const readSnapshotForReflection = Effect.fn("personalStore.readSnapshotForReflection")(
    function* () {
      yield* ensureInitialized();
      const [guardrails, profile, workingItems, state, lessonScopes] = yield* Effect.all(
        [
          readTextFileIfExists(paths.guardrailsPath, "readGuardrails"),
          readTextFileIfExists(paths.profilePath, "readProfile"),
          readWorkingItemsRaw(),
          readStateRaw(),
          listLessons(),
        ],
        { concurrency: "unbounded" },
      );

      const lessonEntries = yield* Effect.forEach(
        lessonScopes,
        (scope) =>
          readTextFileIfExists(lessonFilePath(paths, scope, path), "readLesson").pipe(
            Effect.map((content) => [scope, content] as const),
          ),
        { concurrency: "unbounded" },
      );

      const lessons = Object.fromEntries(lessonEntries);
      const lessonHashes = Object.fromEntries(
        lessonEntries.map(([scope, content]) => [scope, sha256Text(content)] as const),
      );

      return {
        guardrails,
        profile,
        workingItems,
        lessons,
        state,
        contentHashes: {
          profile: sha256Text(profile),
          lessons: lessonHashes,
        },
      } satisfies ReflectionSnapshot;
    },
  );

  const applyReflectionUpdates = Effect.fn("personalStore.applyReflectionUpdates")(function* (
    input: ReflectionUpdatesInput,
  ) {
    yield* ensureInitialized();
    const currentState = yield* readStateRaw();

    // TOCTOU privacy check: abort persistence if any reflected thread was opted out mid-flight.
    if (input.reflectedThreadIds !== undefined && input.reflectedThreadIds.length > 0) {
      const optOutSet = new Set(currentState.optOutThreadIds);
      const optedOutNow = input.reflectedThreadIds.filter((threadId) => optOutSet.has(threadId));
      if (optedOutNow.length > 0) {
        yield* Effect.logWarning(
          "Skipping personal reflection persistence because reflected thread(s) were opted out during reflection.",
          { optedOutThreadIds: optedOutNow },
        );
        return {
          updatedFiles: [],
          redactedCount: 0,
          state: currentState,
        } satisfies ReflectionUpdatesResult;
      }
    }

    const plannedWrites = new Map<
      string,
      { readonly filePath: string; readonly content: string; readonly operation: string }
    >();
    let redactedCount = 0;

    if (input.profile !== undefined) {
      let allowProfileReplace = true;
      if (input.expectedBaseHashes?.profile !== undefined) {
        const currentProfile = yield* readTextFileIfExists(paths.profilePath, "readProfile");
        const currentHash = sha256Text(currentProfile);
        if (currentHash !== input.expectedBaseHashes.profile) {
          allowProfileReplace = false;
          yield* Effect.logWarning(
            "Skipping profile replacement due to concurrent modification during reflection.",
            {
              expectedHash: input.expectedBaseHashes.profile,
              currentHash,
            },
          );
        }
      }
      if (allowProfileReplace) {
        plannedWrites.set(paths.profilePath, {
          filePath: paths.profilePath,
          content: input.profile,
          operation: "reflectionWriteProfile",
        });
      }
    }

    if (input.guardrailsAppend !== undefined && input.guardrailsAppend.length > 0) {
      let current = yield* readTextFileIfExists(paths.guardrailsPath, "readGuardrails");
      let changed = false;
      for (const rule of input.guardrailsAppend) {
        const sanitized = sanitizePersonalText(rule);
        redactedCount += sanitized.redactedCount;
        const bullet = formatBulletNote(sanitized.text);
        if (bullet.length > 0 && !current.includes(bullet)) {
          current = appendSectionContent(current, bullet);
          changed = true;
        }
      }
      if (changed) {
        plannedWrites.set(paths.guardrailsPath, {
          filePath: paths.guardrailsPath,
          content: current,
          operation: "reflectionAppendGuardrails",
        });
      }
    }

    if (input.lessonsReplace !== undefined) {
      const hasExpectedLessons = input.expectedBaseHashes?.lessons !== undefined;
      for (const [scope, content] of Object.entries(input.lessonsReplace)) {
        const normalizedScope = normalizeMemoryScope(scope);
        const targetPath = lessonFilePath(paths, normalizedScope, path);
        if (hasExpectedLessons) {
          const currentLesson = yield* readTextFileIfExists(targetPath, "readLesson");
          const expectedHash =
            input.expectedBaseHashes?.lessons?.[normalizedScope] ??
            input.expectedBaseHashes?.lessons?.[scope];
          const currentHash = sha256Text(currentLesson);
          const conflict =
            expectedHash !== undefined ? currentHash !== expectedHash : currentLesson.length > 0;
          if (conflict) {
            yield* Effect.logWarning(
              "Skipping lesson replacement due to concurrent modification during reflection.",
              {
                scope: normalizedScope,
                expectedHash: expectedHash ?? null,
                currentHash,
              },
            );
            continue;
          }
        }
        plannedWrites.set(targetPath, {
          filePath: targetPath,
          content,
          operation: "reflectionWriteLesson",
        });
      }
    }

    if (input.lessonsAppend !== undefined) {
      for (const [scope, notes] of Object.entries(input.lessonsAppend)) {
        if (notes.length === 0) {
          continue;
        }
        const normalizedScope = normalizeMemoryScope(scope);
        const targetPath = lessonFilePath(paths, normalizedScope, path);
        const planned = plannedWrites.get(targetPath);
        const existing =
          planned !== undefined
            ? planned.content
            : yield* readTextFileIfExists(targetPath, "readLesson");
        let next =
          existing.trim().length > 0
            ? existing
            : normalizedScope === GLOBAL_MEMORY_SCOPE
              ? DEFAULT_GLOBAL_LESSONS_TEMPLATE
              : `# 项目经验：${normalizedScope}\n`;
        let changed = false;
        for (const note of notes) {
          const sanitized = sanitizePersonalText(note);
          redactedCount += sanitized.redactedCount;
          const bullet = formatBulletNote(sanitized.text);
          if (bullet.length > 0 && !next.includes(bullet)) {
            next = appendSectionContent(next, bullet);
            changed = true;
          }
        }
        if (changed) {
          plannedWrites.set(targetPath, {
            filePath: targetPath,
            content: next,
            operation: "reflectionAppendLesson",
          });
        }
      }
    }

    const hasWorkingReplace = input.workingItemsReplace !== undefined;
    const hasPrune = input.pruneExpiredNowIso !== undefined;
    const hasClosures = input.workingClosures !== undefined && input.workingClosures.length > 0;
    const hasUpserts =
      input.workingItemsUpsert !== undefined && input.workingItemsUpsert.length > 0;

    if (hasWorkingReplace || hasPrune || hasClosures || hasUpserts) {
      let workingItems: ReadonlyArray<WorkingItem> = hasWorkingReplace
        ? input.workingItemsReplace!
        : yield* readWorkingItemsRaw();
      let workingChanged = hasWorkingReplace;

      if (hasPrune) {
        const pruned = pruneExpiredWorkingItems(workingItems, input.pruneExpiredNowIso!);
        if (pruned.changed) {
          workingItems = pruned.items;
          workingChanged = true;
        }
      }

      if (hasClosures) {
        const closureNowIso = input.pruneExpiredNowIso ?? (yield* nowIsoString());
        const closed = applyWorkingClosures(workingItems, input.workingClosures!, closureNowIso);
        if (closed.changed) {
          workingItems = closed.items;
          workingChanged = true;
        }
      }

      if (hasUpserts) {
        for (const upsert of input.workingItemsUpsert!) {
          const merged = yield* mergeWorkingItemUpsert(workingItems, upsert);
          workingItems = merged.items;
          redactedCount += merged.redactedCount;
          workingChanged = true;
        }
      }

      if (workingChanged) {
        const sanitizedItems: Array<WorkingItem> = [];
        for (const item of workingItems) {
          const sanitized = sanitizeWorkingItem(item);
          redactedCount += sanitized.redactedCount;
          sanitizedItems.push(sanitized.item);
        }
        const existingWorking = yield* readTextFileIfExists(paths.workingPath, "readWorkingItems");
        const rendered = serializeWorkingMarkdown(sanitizedItems, existingWorking);
        plannedWrites.set(paths.workingPath, {
          filePath: paths.workingPath,
          content: rendered,
          operation: "reflectionWriteWorking",
        });
      }
    }

    const updatedFiles = new Set<string>();

    // Only create git snapshots when Markdown memory files actually change.
    if (plannedWrites.size > 0) {
      yield* commitAllIfDirty("user: manual edit");
      for (const write of plannedWrites.values()) {
        const written = yield* writeSanitizedFile(write.filePath, write.content, write.operation);
        redactedCount += written.redactedCount;
        updatedFiles.add(write.filePath);
      }
      yield* commitAllIfDirty(
        `personal: ${sanitizeCommitReason(input.reason ?? "reflection update")}`,
      );
    }

    let state = currentState;
    if (input.statePatch !== undefined) {
      const patch = input.statePatch;
      const nextState: PersonalState = {
        version: 1,
        ...(patch.reflectionModelSelection !== undefined
          ? { reflectionModelSelection: patch.reflectionModelSelection }
          : state.reflectionModelSelection !== undefined
            ? { reflectionModelSelection: state.reflectionModelSelection }
            : {}),
        threadCursors:
          patch.threadCursors !== undefined
            ? { ...state.threadCursors, ...patch.threadCursors }
            : state.threadCursors,
        optOutThreadIds:
          patch.optOutThreadIds !== undefined
            ? dedupeStrings(patch.optOutThreadIds)
            : state.optOutThreadIds,
        lastIncrementalAt:
          patch.lastIncrementalAt !== undefined ? patch.lastIncrementalAt : state.lastIncrementalAt,
        lastDailyCompactAt:
          patch.lastDailyCompactAt !== undefined
            ? patch.lastDailyCompactAt
            : state.lastDailyCompactAt,
      };
      yield* writeStateFileRaw(nextState);
      state = nextState;
      updatedFiles.add(paths.statePath);
    }

    return {
      updatedFiles: [...updatedFiles],
      redactedCount,
      state,
    } satisfies ReflectionUpdatesResult;
  });

  return {
    paths,
    ensureInitialized,
    readGuardrails,
    readProfile,
    writeProfile,
    appendGuardrail,
    listLessons,
    readLesson,
    appendLesson,
    writeLesson,
    readWorkingItems,
    writeWorkingItems,
    upsertWorkingItem,
    updateWorkingItemStatus,
    readState,
    updateState,
    setThreadOptOut,
    searchMemory,
    addNote,
    readSnapshotForReflection,
    applyReflectionUpdates,
  };
}
