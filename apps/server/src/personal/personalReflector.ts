import {
  isDelegatedAppThread,
  isListedThreadLineage,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GLOBAL_MEMORY_SCOPE, normalizeMemoryScope } from "./personalPaths.ts";
import { sanitizePersonalText } from "./personalSanitizer.ts";
import {
  DEFAULT_GLOBAL_LESSONS_TEMPLATE,
  DEFAULT_PROFILE_TEMPLATE,
  pruneExpiredWorkingItems,
} from "./personalStore.ts";
import type {
  ReflectionSnapshot,
  ReflectionUpdatesInput,
  WorkingClosureInput,
  WorkingItem,
  WorkingItemUpsertInput,
  WorkingPriority,
} from "./personalTypes.ts";

export { pruneExpiredWorkingItems };

export type ReflectionMode = "incremental" | "daily_compact";

export interface ReflectNowInput {
  readonly mode?: ReflectionMode | undefined;
  readonly lookbackDays?: number | undefined;
}

export interface ReflectionRunResult {
  readonly mode: ReflectionMode;
  readonly skipped: boolean;
  readonly reason?: string | undefined;
  readonly scannedThreads: number;
  readonly reflectedThreads: number;
  readonly updatedFiles: ReadonlyArray<string>;
  readonly redactedCount: number;
  readonly modelUsed?: string | undefined;
}

export class PersonalReflectionError extends Schema.TaggedError<
  PersonalReflectionError,
  { readonly brand: unique symbol }
>()("PersonalReflectionError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Personal reflection "${this.operation}" failed: ${this.detail}`;
  }
}

export interface ReflectionFormattedMessage {
  readonly role: "user" | "assistant";
  readonly createdAt: string;
  readonly text: string;
  readonly redactedCount: number;
  readonly originalIndex: number;
}

export interface ThreadMessageSlice {
  readonly threadId: string;
  readonly title: string;
  readonly projectSlug: string;
  readonly projectTitle?: string | undefined;
  readonly updatedAt: string;
  readonly totalMessageCount: number;
  readonly messages: ReadonlyArray<ReflectionFormattedMessage>;
  readonly redactedCount: number;
}

export interface ReflectableThreadLike {
  readonly lineage?: OrchestrationV2AppThread["lineage"] | undefined;
  readonly delegatedFrom?: OrchestrationV2AppThread["delegatedFrom"] | null | undefined;
  readonly workflowRun?: unknown;
}

export interface ReflectableMessageLike {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string | DateTime.Utc;
  readonly scheduledTaskId?: string | undefined;
  readonly notification?: unknown;
  readonly delegatedCompletion?: unknown;
  readonly idleCompaction?: unknown;
  readonly workflowScript?: boolean | undefined;
}

export interface ExtractReflectionMessagesOptions {
  readonly cursorLastCount?: number | undefined;
  readonly endIndex?: number | undefined;
  readonly sinceIso?: string | undefined;
}

export type ExtractedReflectionMessage<T extends ReflectableMessageLike = ReflectableMessageLike> =
  T & {
    readonly role: "user" | "assistant";
    readonly originalIndex: number;
  };

export interface FormatMessageForReflectionResult {
  readonly text: string;
  readonly redactedCount: number;
}

export type WorkingCloseDirective = WorkingClosureInput;

export interface ParsedReflectionOutput extends Omit<
  ReflectionUpdatesInput,
  | "reason"
  | "statePatch"
  | "workingClosures"
  | "pruneExpiredNowIso"
  | "expectedBaseHashes"
  | "reflectedThreadIds"
> {
  readonly workingClosures: ReadonlyArray<WorkingCloseDirective>;
  readonly hasContentChanges: boolean;
}

export interface BoundedConversationSlicesResult {
  readonly text: string;
  readonly includedEndIndexByThread: ReadonlyMap<string, number>;
  readonly fullyIncludedThreadIds: ReadonlySet<string>;
  readonly redactedCount: number;
}

export interface IncrementalReflectionPromptResult {
  readonly prompt: string;
  readonly truncatedProfile: boolean;
  readonly truncatedLessonScopes: ReadonlySet<string>;
  readonly includedEndIndexByThread: ReadonlyMap<string, number>;
  readonly fullyIncludedThreadIds: ReadonlySet<string>;
  readonly redactedCount: number;
}

export interface DailyCompactPromptResult {
  readonly prompt: string;
  readonly truncatedProfile: boolean;
  readonly truncatedLessonScopes: ReadonlySet<string>;
  readonly redactedCount: number;
}

export const MAX_REFLECTION_SLICES_CHARS = 16_000;
const MAX_CODE_BLOCK_CHARS = 400;
const MAX_USER_MESSAGE_CHARS = 1200;
const MAX_ASSISTANT_MESSAGE_CHARS = 800;
const MIN_SUBSTANTIVE_USER_CHARS = 6;
const DEFAULT_WORKING_EXPIRES_DAYS = 7;
const MAX_PROMPT_LESSON_CHARS = 3000;
const MAX_PROMPT_TOTAL_LESSONS_CHARS = 8000;
const MAX_PROMPT_PROFILE_CHARS = 3000;
const MAX_PROMPT_GUARDRAILS_CHARS = 2000;
const CODE_BLOCK_OMITTED = "[code block omitted]";

const SLACK_RELAY_MESSAGE_PREFIX = "slack-relay:";
const FENCE_OPEN_PATTERN = /^[ \t]*(`{3,}|~{3,})[^\n]*$/;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const REFLECTION_XML_TAG_PATTERN =
  /<(?:profile_replace|lesson|lesson_replace|working_upsert|working_close)\b/i;
const PLACEHOLDER_WORKING_IDS = new Set(["optional", "new", "auto", "none", "tbd", "null"]);

function foldLargeFencedCodeBlocks(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const output: Array<string> = [];

  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  let blockLines: Array<string> = [];

  const flushBlock = () => {
    const joined = blockLines.join("\n");
    output.push(joined.length > maxChars ? CODE_BLOCK_OMITTED : joined);
    fenceChar = null;
    fenceLen = 0;
    blockLines = [];
  };

  for (const line of lines) {
    if (fenceChar === null) {
      const openMatch = FENCE_OPEN_PATTERN.exec(line);
      if (openMatch?.[1] !== undefined) {
        const marker = openMatch[1];
        const ch = marker[0] as "`" | "~";
        // Per CommonMark, backtick info strings cannot contain backticks.
        const rest = line.slice(line.indexOf(marker) + marker.length);
        if (ch === "`" && rest.includes("`")) {
          output.push(line);
          continue;
        }
        fenceChar = ch;
        fenceLen = marker.length;
        blockLines = [line];
        continue;
      }
      output.push(line);
    } else {
      blockLines.push(line);
      const trimmed = line.trim();
      if (trimmed.length >= fenceLen && [...trimmed].every((c) => c === fenceChar)) {
        flushBlock();
      }
    }
  }

  if (fenceChar !== null) {
    flushBlock();
  }

  return output.join("\n");
}

function dedentBlock(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let start = 0;
  while (start < lines.length && (lines[start]?.trim().length ?? 0) === 0) {
    start += 1;
  }
  let end = lines.length - 1;
  while (end >= start && (lines[end]?.trim().length ?? 0) === 0) {
    end -= 1;
  }
  if (start > end) {
    return "";
  }

  const sliced = lines.slice(start, end + 1);
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of sliced) {
    if (line.trim().length === 0) {
      continue;
    }
    const leadingMatch = /^[ \t]*/.exec(line);
    const indentLen = leadingMatch?.[0].length ?? 0;
    if (indentLen < minIndent) {
      minIndent = indentLen;
    }
  }

  if (!Number.isFinite(minIndent) || minIndent <= 0) {
    return sliced
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
  }

  return sliced
    .map((line) => (line.trim().length === 0 ? "" : line.slice(minIndent).trimEnd()))
    .join("\n")
    .trim();
}

export function toIsoTimestamp(value: string | DateTime.Utc): string {
  return typeof value === "string" ? value : DateTime.formatIso(value);
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

function isAtOrAfterIso(createdAt: string | DateTime.Utc, sinceIso: string): boolean {
  const createdMs = parseTimestampMillis(createdAt);
  const sinceMs = parseTimestampMillis(sinceIso);
  if (createdMs !== null && sinceMs !== null) {
    return createdMs >= sinceMs;
  }
  return toIsoTimestamp(createdAt) >= sinceIso;
}

function defaultExpiresIso(nowIso: string, days = DEFAULT_WORKING_EXPIRES_DAYS): string | null {
  const nowMs = parseTimestampMillis(nowIso);
  if (nowMs === null) {
    return null;
  }
  const target = DateTime.make(nowMs + days * 24 * 60 * 60 * 1000);
  if (Option.isNone(target)) {
    return null;
  }
  const isoDate = DateTime.formatIso(target.value).slice(0, 10);
  return `${isoDate}T23:59:59.000Z`;
}

function normalizeExpiresAttribute(rawExpires: string | undefined, nowIso: string): string | null {
  if (rawExpires === undefined) {
    return defaultExpiresIso(nowIso);
  }
  const trimmed = rawExpires.trim();
  if (trimmed.length === 0) {
    return defaultExpiresIso(nowIso);
  }
  const lower = trimmed.toLowerCase();
  if (lower === "none" || lower === "never" || lower === "null") {
    return null;
  }

  const dateOnly = DATE_ONLY_PATTERN.exec(trimmed);
  if (dateOnly !== null) {
    const isoDate = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    const probe = DateTime.make(`${isoDate}T00:00:00.000Z`);
    if (Option.isSome(probe) && DateTime.formatIso(probe.value).slice(0, 10) === isoDate) {
      return `${isoDate}T23:59:59.000Z`;
    }
    return defaultExpiresIso(nowIso);
  }

  const parsed = DateTime.make(trimmed);
  if (Option.isSome(parsed)) {
    return DateTime.formatIso(parsed.value);
  }

  return defaultExpiresIso(nowIso);
}

function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars === 1) {
    return "…";
  }
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function dedupeStrings(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Determines whether a thread and its messages are eligible for personal memory reflection.
 * Aligns with turn-context injection eligibility by excluding unlisted lineages (subagents,
 * side chats, workflow steps), delegated threads, workflow runs, scheduled task threads,
 * and Slack relay threads.
 */
export function isReflectableThreadMessages(
  thread: ReflectableThreadLike,
  messages: ReadonlyArray<Pick<ReflectableMessageLike, "id" | "scheduledTaskId">>,
): boolean {
  if (thread.lineage !== undefined) {
    if (!isListedThreadLineage(thread.lineage)) {
      return false;
    }
    if (
      isDelegatedAppThread({
        lineage: thread.lineage,
        ...(thread.delegatedFrom != null ? { delegatedFrom: thread.delegatedFrom } : {}),
      })
    ) {
      return false;
    }
  } else if (thread.delegatedFrom != null) {
    return false;
  }
  if (thread.workflowRun != null) {
    return false;
  }
  for (const message of messages) {
    if (message.scheduledTaskId !== undefined) {
      return false;
    }
    if (message.id.startsWith(SLACK_RELAY_MESSAGE_PREFIX)) {
      return false;
    }
  }
  return true;
}

function isRegularUserMessage(message: ReflectableMessageLike): boolean {
  if (message.role !== "user" || message.streaming) {
    return false;
  }
  if (
    message.notification !== undefined ||
    message.delegatedCompletion !== undefined ||
    message.idleCompaction !== undefined ||
    message.workflowScript === true
  ) {
    return false;
  }
  const trimmed = message.text.trim();
  return trimmed.length > 0 && !message.text.trimStart().startsWith("/");
}

function isSubstantiveUserMessage(message: ReflectableMessageLike): boolean {
  return isRegularUserMessage(message) && message.text.trim().length >= MIN_SUBSTANTIVE_USER_CHARS;
}

/**
 * Extracts new conversation messages within `[startIndex, safeCount)`, preserving `originalIndex`.
 * Stops at the first `streaming: true` message and resets `startIndex` to `0` on thread rollback.
 */
export function extractNewMessagesForReflection<T extends ReflectableMessageLike>(
  messages: ReadonlyArray<T>,
  options: ExtractReflectionMessagesOptions = {},
): ReadonlyArray<ExtractedReflectionMessage<T>> {
  const firstStreamingIdx = messages.findIndex((message) => message.streaming === true);
  const safeCount = firstStreamingIdx === -1 ? messages.length : firstStreamingIdx;
  const effectiveEnd =
    options.endIndex !== undefined
      ? Math.min(Math.max(0, Math.floor(options.endIndex)), safeCount)
      : safeCount;

  const sinceIso = options.sinceIso?.trim();
  const useSinceIso = sinceIso !== undefined && sinceIso.length > 0;
  const rawCursor = Math.max(0, Math.floor(options.cursorLastCount ?? 0));
  const startIndex = useSinceIso ? 0 : messages.length < rawCursor ? 0 : rawCursor;

  const filtered: Array<ExtractedReflectionMessage<T>> = [];
  let hasSubstantiveUserMessage = false;
  let hasAssistantContinuingSubstantiveUser = false;

  for (let idx = startIndex; idx < effectiveEnd; idx += 1) {
    const message = messages[idx];
    if (message === undefined) {
      continue;
    }
    if (useSinceIso && !isAtOrAfterIso(message.createdAt, sinceIso)) {
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    if (message.streaming) {
      continue;
    }
    if (
      message.notification !== undefined ||
      message.delegatedCompletion !== undefined ||
      message.idleCompaction !== undefined ||
      message.workflowScript === true
    ) {
      continue;
    }

    const trimmed = message.text.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (message.role === "user") {
      if (message.text.trimStart().startsWith("/")) {
        continue;
      }
      if (trimmed.length >= MIN_SUBSTANTIVE_USER_CHARS) {
        hasSubstantiveUserMessage = true;
      }
    } else if (!hasSubstantiveUserMessage && !hasAssistantContinuingSubstantiveUser) {
      // Allow an assistant reply arriving after a streaming watermark or prompt-budget split
      // when its preceding regular user turn was substantive.
      if (idx > 0 && !useSinceIso && startIndex > 0) {
        for (let prev = idx - 1; prev >= 0; prev -= 1) {
          const prevMsg = messages[prev];
          if (prevMsg !== undefined && isRegularUserMessage(prevMsg)) {
            if (isSubstantiveUserMessage(prevMsg)) {
              hasAssistantContinuingSubstantiveUser = true;
            }
            break;
          }
        }
      }
    }

    filtered.push({
      ...message,
      role: message.role,
      originalIndex: idx,
    });
  }

  return hasSubstantiveUserMessage || hasAssistantContinuingSubstantiveUser ? filtered : [];
}

/**
 * Sanitizes a single message, folds fenced code blocks over 400 characters, and truncates
 * by role (`user <= 1200 chars`, `assistant <= 800 chars`).
 */
export function formatMessageForReflection(
  text: string,
  role: "user" | "assistant",
): FormatMessageForReflectionResult {
  const sanitized = sanitizePersonalText(text);
  const normalized = foldLargeFencedCodeBlocks(
    sanitized.text.replace(/\r\n/g, "\n"),
    MAX_CODE_BLOCK_CHARS,
  );

  const trimmed = normalized.trim();
  const maxChars = role === "user" ? MAX_USER_MESSAGE_CHARS : MAX_ASSISTANT_MESSAGE_CHARS;

  return {
    text: truncateChars(trimmed, maxChars),
    redactedCount: sanitized.redactedCount,
  };
}

function renderWorkingItemsForPrompt(items: ReadonlyArray<WorkingItem>): {
  readonly text: string;
  readonly redactedCount: number;
} {
  if (items.length === 0) {
    return { text: "(none)", redactedCount: 0 };
  }
  let redactedCount = 0;
  const lines = items.map((item) => {
    const expires = item.expiresAt ?? "none";
    const threads = item.sourceThreadIds.length > 0 ? item.sourceThreadIds.join(",") : "none";
    const sanitizedSummary = sanitizePersonalText(item.summary.replace(/\s+/g, " ").trim());
    redactedCount += sanitizedSummary.redactedCount;
    return `- id=${item.id} | status=${item.status} | priority=${item.priority} | scope=${item.scope} | expires=${expires} | threads=${threads} | updated=${item.updatedAt} :: ${sanitizedSummary.text}`;
  });
  return {
    text: lines.join("\n"),
    redactedCount,
  };
}

function renderLessonsForPrompt(
  lessons: Readonly<Record<string, string>>,
  includeFullContent: boolean,
): {
  readonly text: string;
  readonly truncatedScopes: ReadonlySet<string>;
  readonly redactedCount: number;
} {
  const truncatedScopes = new Set<string>();
  let redactedCount = 0;
  const scopes = Object.keys(lessons).toSorted((a, b) => {
    if (a === GLOBAL_MEMORY_SCOPE && b !== GLOBAL_MEMORY_SCOPE) return -1;
    if (b === GLOBAL_MEMORY_SCOPE && a !== GLOBAL_MEMORY_SCOPE) return 1;
    return a.localeCompare(b);
  });
  if (scopes.length === 0) {
    return { text: "(none)", truncatedScopes, redactedCount: 0 };
  }

  let usedChars = 0;
  const blocks: Array<string> = [];
  for (const scope of scopes) {
    const normalizedScope = normalizeMemoryScope(scope);
    const sanitized = sanitizePersonalText((lessons[scope] ?? "").trim());
    redactedCount += sanitized.redactedCount;
    const raw = sanitized.text;
    if (raw.length === 0) {
      continue;
    }
    const perScopeLimit = includeFullContent ? MAX_PROMPT_LESSON_CHARS : 1200;
    const remaining = MAX_PROMPT_TOTAL_LESSONS_CHARS - usedChars;
    if (remaining <= 64) {
      truncatedScopes.add(normalizedScope);
      truncatedScopes.add(scope);
      blocks.push(`### scope=${scope}\n(omitted due to prompt budget)`);
      continue;
    }
    const effectiveLimit = Math.min(perScopeLimit, remaining);
    if (raw.length > effectiveLimit) {
      truncatedScopes.add(normalizedScope);
      truncatedScopes.add(scope);
    }
    const body = truncateChars(raw, effectiveLimit);
    const rendered = `### scope=${scope}\n${body}`;
    blocks.push(rendered);
    usedChars += rendered.length + 2;
  }

  return {
    text: blocks.length > 0 ? blocks.join("\n\n") : "(none)",
    truncatedScopes,
    redactedCount,
  };
}

export function renderConversationSlicesBounded(
  slices: ReadonlyArray<ThreadMessageSlice>,
  maxChars = MAX_REFLECTION_SLICES_CHARS,
): BoundedConversationSlicesResult {
  const includedEndIndexByThread = new Map<string, number>();
  const fullyIncludedThreadIds = new Set<string>();
  let redactedCount = 0;

  if (slices.length === 0 || maxChars <= 0) {
    return {
      text: "",
      includedEndIndexByThread,
      fullyIncludedThreadIds,
      redactedCount,
    };
  }

  const parts: Array<string> = [];
  let usedChars = 0;

  for (const slice of slices) {
    const sep = parts.length > 0 ? "\n\n" : "";
    const sanitizedTitle = sanitizePersonalText(slice.title);
    redactedCount += sanitizedTitle.redactedCount;

    let projectDesc = slice.projectSlug;
    if (slice.projectTitle !== undefined && slice.projectTitle.trim().length > 0) {
      const sanitizedProjectTitle = sanitizePersonalText(slice.projectTitle.trim());
      redactedCount += sanitizedProjectTitle.redactedCount;
      projectDesc = `${slice.projectSlug} (${sanitizedProjectTitle.text})`;
    }

    const header = `### Thread: ${sanitizedTitle.text} | id=${slice.threadId} | project=${projectDesc} | updated=${slice.updatedAt}`;
    const minBlockLen = sep.length + header.length + 20;
    if (usedChars + minBlockLen > maxChars) {
      break;
    }

    const lines: Array<string> = [header];
    let blockChars = header.length;
    const budgetForThisSlice = maxChars - usedChars - sep.length;

    let fullMessagesIncluded = 0;
    let lastFullEndIndex: number | undefined;
    let hitTruncation = false;

    for (const message of slice.messages) {
      const sanitizedText = sanitizePersonalText(message.text);
      redactedCount += sanitizedText.redactedCount;
      const prefix = `[${message.role} | ${message.createdAt}] `;
      const line = `${prefix}${sanitizedText.text}`;
      const added = 1 + line.length;
      if (blockChars + added <= budgetForThisSlice) {
        lines.push(line);
        blockChars += added;
        fullMessagesIncluded += 1;
        lastFullEndIndex = message.originalIndex + 1;
      } else {
        hitTruncation = true;
        // Only emit a truncated fallback line when no message at all has fit into the prompt yet;
        // never mark a truncated message as fully included so the cursor stops before it.
        if (parts.length === 0 && fullMessagesIncluded === 0) {
          const remaining = budgetForThisSlice - blockChars - 1;
          if (remaining > prefix.length + 24) {
            lines.push(truncateChars(line, remaining));
          }
        }
        break;
      }
    }

    if (lines.length <= 1) {
      break;
    }

    const block = lines.join("\n");
    parts.push(block);
    usedChars += sep.length + block.length;

    if (lastFullEndIndex !== undefined) {
      includedEndIndexByThread.set(slice.threadId, lastFullEndIndex);
    }
    if (!hitTruncation && fullMessagesIncluded === slice.messages.length) {
      fullyIncludedThreadIds.add(slice.threadId);
    }

    if (usedChars >= maxChars) {
      break;
    }
  }

  const combined = parts.join("\n\n");
  return {
    text: combined.length <= maxChars ? combined : truncateChars(combined, maxChars),
    includedEndIndexByThread,
    fullyIncludedThreadIds,
    redactedCount,
  };
}

/**
 * Builds the incremental reflection prompt.
 * Bounds conversation slices to `<= 16,000` characters, sanitizes all memory & thread metadata,
 * and returns truncation + slice inclusion metadata to protect against cursor loss and truncation overwrites.
 */
export function buildIncrementalReflectionPrompt(params: {
  readonly snapshot: ReflectionSnapshot;
  readonly slices: ReadonlyArray<ThreadMessageSlice>;
  readonly nowIso: string;
}): IncrementalReflectionPromptResult {
  const { snapshot, slices, nowIso } = params;
  const defaultExpiry = defaultExpiresIso(nowIso)?.slice(0, 10) ?? "none";

  const sanitizedGuardrails = sanitizePersonalText(snapshot.guardrails.trim());
  const sanitizedProfile = sanitizePersonalText(snapshot.profile.trim());
  const truncatedProfile = sanitizedProfile.text.length > MAX_PROMPT_PROFILE_CHARS;

  const openWorking = snapshot.workingItems.filter((item) => item.status === "open");
  const renderedWorking = renderWorkingItemsForPrompt(openWorking);
  const renderedLessons = renderLessonsForPrompt(snapshot.lessons, false);
  const renderedSlices = renderConversationSlicesBounded(slices, MAX_REFLECTION_SLICES_CHARS);

  const prompt = `你是一个克制、严谨的个人工程协作记忆整理助手（Personal Agent Reflector）。
当前时间（UTC ISO）：${nowIso}

请阅读用户近期的新增对话切片，对照当前已保存的个人记忆快照，提炼**确实值得长期沉淀或跨 Thread 跟进**的增量更新。

## 严格输出协议（必须遵守）
1. **只能输出一个合法的 JSON 对象**：\`{"transcription": "<你的标签化内容>"}\`。不要输出 Markdown 代码块（如 \`\`\`json）、不要输出任何 JSON 以外的前后缀说明。
2. 在 \`transcription\` 字符串内部，使用下列 XML 标签分节表达更新；若无任何值得记录的变化，输出 \`{"transcription": ""}\`。
3. 叙述统一使用中文，业务专有名词、产品名称、技术框架、代码标识符与配置名保留英文原词。
4. **绝对禁止**写入任何密码、Token、API Key、Cookie、私钥或敏感业务凭据。
5. 宁缺毋滥：不记录一次性闲聊、临时调试流水账或已存在于当前记忆中的重复内容。

## 支持的 XML 标签（写在 transcription 字段内）
- \`<profile_replace>...</profile_replace>\`
  - 仅当对话中出现**新的长期稳定偏好、协作习惯或明确纠偏**时输出；输出更新后的完整 \`profile.md\` Markdown（保留原有有效内容与用户手写偏好，总计控制在 1500 字以内）。无变化时请完全省略此标签。
- \`<lesson scope="global|project-slug">...</lesson>\`
  - 可输出多条；仅记录真正有复用价值的踩坑、根因定位、架构/决策取舍。每条简洁精炼（1~3 句）；跨项目通用用 \`scope="global"\`，项目专属用对应 \`project-slug\`。
- \`<working_upsert id="optional" priority="high|medium|low" scope="global|project-slug" expires="YYYY-MM-DD|none" threads="id1,id2">...</working_upsert>\`
  - 仅记录明确的未闭环跟进事项或跨 Thread 暗线。更新已有项时填写对应 \`id\`，新建时省略 \`id\` 或填 \`optional\`；\`expires\` 默认建议 7 天后（${defaultExpiry}），长期项可填 \`none\`。
- \`<working_close id="W-xxx" status="done|dismissed" />\`
  - 若新对话表明下方某条 open working 已完成（\`done\`）或已取消/不再需要（\`dismissed\`），输出此标签关闭它。

## 当前记忆快照
<current_guardrails>
${truncateChars(sanitizedGuardrails.text, MAX_PROMPT_GUARDRAILS_CHARS)}
</current_guardrails>

<current_profile>
${truncateChars(sanitizedProfile.text, MAX_PROMPT_PROFILE_CHARS)}
</current_profile>

<current_open_working>
${renderedWorking.text}
</current_open_working>

<current_lessons_summary>
${renderedLessons.text}
</current_lessons_summary>

## 待反思的新增对话切片
<conversations>
${renderedSlices.text}
</conversations>

请严格返回 JSON 对象 \`{"transcription": "..."}\`。`;

  return {
    prompt,
    truncatedProfile,
    truncatedLessonScopes: renderedLessons.truncatedScopes,
    includedEndIndexByThread: renderedSlices.includedEndIndexByThread,
    fullyIncludedThreadIds: renderedSlices.fullyIncludedThreadIds,
    redactedCount:
      sanitizedGuardrails.redactedCount +
      sanitizedProfile.redactedCount +
      renderedWorking.redactedCount +
      renderedLessons.redactedCount +
      renderedSlices.redactedCount,
  };
}

/**
 * Builds the daily compaction & deduplication prompt.
 * Sanitizes all snapshot fields and returns truncation metadata to prevent full-file overwrites
 * when a memory file exceeded the prompt budget.
 */
export function buildDailyCompactPrompt(params: {
  readonly snapshot: ReflectionSnapshot;
  readonly nowIso: string;
}): DailyCompactPromptResult {
  const { snapshot, nowIso } = params;
  const profileBudget = MAX_PROMPT_PROFILE_CHARS * 2;
  const sanitizedProfile = sanitizePersonalText(snapshot.profile.trim());
  const truncatedProfile = sanitizedProfile.text.length > profileBudget;
  const renderedLessons = renderLessonsForPrompt(snapshot.lessons, true);
  const renderedWorking = renderWorkingItemsForPrompt(snapshot.workingItems);

  const prompt = `你是一个克制、严谨的个人记忆整理与瘦身助手（Personal Agent Daily Compactor）。
当前时间（UTC ISO）：${nowIso}

请审查当前已保存的个人记忆快照，执行去重、合并与瘦身，保持长期记忆高信噪比、结构清晰、不膨胀。

## 严格输出协议（必须遵守）
1. **只能输出一个合法的 JSON 对象**：\`{"transcription": "<你的标签化内容>"}\`。不要输出 Markdown 代码块（如 \`\`\`json）、不要输出任何 JSON 以外的前后缀说明。
2. 在 \`transcription\` 字符串内部，使用下列 XML 标签分节表达整理结果；如果当前记忆已经很精炼无需任何改动，输出 \`{"transcription": ""}\`。
3. 叙述统一使用中文，专有名词与代码标识符保留英文原词；严禁写入任何敏感凭据。
4. 保留用户明确手写的稳定偏好与重要结论，不要随意删掉有效信息，只合并重复、去除过时噪音。

## 支持的 XML 标签（写在 transcription 字段内）
- \`<profile_replace>...</profile_replace>\`
  - 当 \`profile.md\` 存在重复条目、冗长表述或超过 1500 字时，输出压缩整理后的完整 \`profile.md\`（<= 1500 字）。无需调整则省略。
- \`<lesson_replace scope="global|project-slug">...</lesson_replace>\`
  - 可输出多个（按 scope）；当某个 scope 的 lessons 存在重复、碎片化或可归并条目时，输出整理后的完整 Markdown（保留标题）。无需调整的 scope 必须省略。
- \`<working_close id="W-xxx" status="done|dismissed" />\`
  - 对明显已过期、重复或已闭环的 \`open\` working 项输出关闭标签（已完成用 \`done\`，过期或冗余用 \`dismissed\`）。

## 当前记忆快照
<current_profile>
${truncateChars(sanitizedProfile.text, profileBudget)}
</current_profile>

<current_lessons>
${renderedLessons.text}
</current_lessons>

<current_working_items>
${renderedWorking.text}
</current_working_items>

请严格返回 JSON 对象 \`{"transcription": "..."}\`。`;

  return {
    prompt,
    truncatedProfile,
    truncatedLessonScopes: renderedLessons.truncatedScopes,
    redactedCount:
      sanitizedProfile.redactedCount +
      renderedLessons.redactedCount +
      renderedWorking.redactedCount,
  };
}

function unwrapRawReflectionText(rawText: string): string {
  let text = rawText.trim();
  if (text.length === 0) {
    return "";
  }

  // Tolerate accidental outer markdown fence around XML tags or JSON.
  const fenced = /^```(?:json|xml|markdown|text)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced?.[1] !== undefined) {
    text = fenced[1].trim();
  }

  // Tolerate double-wrapped JSON `{"transcription": "..."}`.
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "transcription" in parsed &&
        typeof (parsed as { readonly transcription?: unknown }).transcription === "string"
      ) {
        return (parsed as { readonly transcription: string }).transcription.trim();
      }
    } catch {
      // Not valid JSON; proceed to XML tag extraction directly.
    }
  }

  return text;
}

function parseTagAttributes(rawAttributes: string): Readonly<Record<string, string>> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`/]+))/g;
  let match: RegExpExecArray | null = attrPattern.exec(rawAttributes);
  while (match !== null) {
    const key = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (key.length > 0) {
      attrs[key] = value.trim();
    }
    match = attrPattern.exec(rawAttributes);
  }
  return attrs;
}

function parseWorkingPriority(raw: string | undefined): WorkingPriority {
  const lower = raw?.trim().toLowerCase();
  if (lower === "high" || lower === "medium" || lower === "low") {
    return lower;
  }
  return "medium";
}

function parseWorkingCloseStatus(raw: string | undefined): "done" | "dismissed" {
  const lower = raw?.trim().toLowerCase();
  if (
    lower === "dismissed" ||
    lower === "dismiss" ||
    lower === "cancelled" ||
    lower === "canceled"
  ) {
    return "dismissed";
  }
  return "done";
}

function parseWorkingId(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || PLACEHOLDER_WORKING_IDS.has(trimmed.toLowerCase())) {
    return undefined;
  }
  return trimmed.replace(/[|\r\n\s]+/g, "-");
}

function parseThreadIdsAttribute(raw: string | undefined): ReadonlyArray<string> {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  const parts = raw
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.toLowerCase() !== "none");
  return dedupeStrings(parts);
}

/**
 * Fault-tolerant parser for reflection XML tags inside `transcription` output.
 * Produces a patch object directly compatible with `PersonalMemoryService.applyReflectionUpdates`,
 * plus `workingClosures` for lossless status closure against existing working items.
 */
export function parseReflectionOutput(rawText: string, nowIso: string): ParsedReflectionOutput {
  const content = unwrapRawReflectionText(rawText);
  if (content.length === 0) {
    return {
      workingClosures: [],
      hasContentChanges: false,
    };
  }

  let profile: string | undefined;
  const profilePattern = /<profile_replace\b[^>]*>([\s\S]*?)<\/profile_replace>/gi;
  let profileMatch = profilePattern.exec(content);
  while (profileMatch !== null) {
    const body = dedentBlock(profileMatch[1] ?? "");
    if (body.length > 0) {
      profile = `${body}\n`;
    }
    profileMatch = profilePattern.exec(content);
  }

  const lessonsAppendMap = new Map<string, Array<string>>();
  const lessonPattern = /<lesson\b([^>]*)>([\s\S]*?)<\/lesson>/gi;
  let lessonMatch = lessonPattern.exec(content);
  while (lessonMatch !== null) {
    const attrs = parseTagAttributes(lessonMatch[1] ?? "");
    const body = dedentBlock(lessonMatch[2] ?? "");
    if (body.length > 0) {
      const scope = normalizeMemoryScope(attrs["scope"]);
      const existing = lessonsAppendMap.get(scope) ?? [];
      if (!existing.includes(body)) {
        existing.push(body);
        lessonsAppendMap.set(scope, existing);
      }
    }
    lessonMatch = lessonPattern.exec(content);
  }

  const lessonsReplaceMap = new Map<string, string>();
  const lessonReplacePattern = /<lesson_replace\b([^>]*)>([\s\S]*?)<\/lesson_replace>/gi;
  let lessonReplaceMatch = lessonReplacePattern.exec(content);
  while (lessonReplaceMatch !== null) {
    const attrs = parseTagAttributes(lessonReplaceMatch[1] ?? "");
    const body = dedentBlock(lessonReplaceMatch[2] ?? "");
    if (body.length > 0) {
      const scope = normalizeMemoryScope(attrs["scope"]);
      lessonsReplaceMap.set(scope, `${body}\n`);
    }
    lessonReplaceMatch = lessonReplacePattern.exec(content);
  }

  const workingItemsUpsert: Array<WorkingItemUpsertInput> = [];
  const workingUpsertPattern = /<working_upsert\b([^>]*)>([\s\S]*?)<\/working_upsert>/gi;
  let upsertMatch = workingUpsertPattern.exec(content);
  while (upsertMatch !== null) {
    const attrs = parseTagAttributes(upsertMatch[1] ?? "");
    const summary = dedentBlock(upsertMatch[2] ?? "");
    if (summary.length > 0) {
      const id = parseWorkingId(attrs["id"]);
      const priority = parseWorkingPriority(attrs["priority"]);
      const scope = normalizeMemoryScope(attrs["scope"]);
      const expiresAt = normalizeExpiresAttribute(attrs["expires"], nowIso);
      const sourceThreadIds = parseThreadIdsAttribute(attrs["threads"]);
      workingItemsUpsert.push({
        ...(id === undefined ? {} : { id }),
        priority,
        scope,
        expiresAt,
        ...(sourceThreadIds.length > 0 ? { sourceThreadIds } : {}),
        summary,
      });
    }
    upsertMatch = workingUpsertPattern.exec(content);
  }

  const closuresById = new Map<string, "done" | "dismissed">();
  const workingClosePattern = /<working_close\b([^>]*?)(?:\/>|>[\s\S]*?<\/working_close>)/gi;
  let closeMatch = workingClosePattern.exec(content);
  while (closeMatch !== null) {
    const attrs = parseTagAttributes(closeMatch[1] ?? "");
    const id = parseWorkingId(attrs["id"]);
    if (id !== undefined) {
      closuresById.set(id, parseWorkingCloseStatus(attrs["status"]));
    }
    closeMatch = workingClosePattern.exec(content);
  }

  const workingClosures: Array<WorkingCloseDirective> = [...closuresById.entries()].map(
    ([id, status]) => ({ id, status }),
  );

  const lessonsAppend: Readonly<Record<string, ReadonlyArray<string>>> | undefined =
    lessonsAppendMap.size > 0 ? Object.fromEntries(lessonsAppendMap.entries()) : undefined;
  const lessonsReplace: Readonly<Record<string, string>> | undefined =
    lessonsReplaceMap.size > 0 ? Object.fromEntries(lessonsReplaceMap.entries()) : undefined;

  const hasContentChanges =
    profile !== undefined ||
    lessonsAppend !== undefined ||
    lessonsReplace !== undefined ||
    workingItemsUpsert.length > 0 ||
    workingClosures.length > 0;

  return {
    ...(profile !== undefined ? { profile } : {}),
    ...(lessonsAppend !== undefined ? { lessonsAppend } : {}),
    ...(lessonsReplace !== undefined ? { lessonsReplace } : {}),
    ...(workingItemsUpsert.length > 0 ? { workingItemsUpsert } : {}),
    workingClosures,
    hasContentChanges,
  };
}

/**
 * Returns true when the model returned non-empty text containing an apparent reflection XML tag
 * (e.g. unclosed or truncated tags) yet `parseReflectionOutput` extracted zero valid changes.
 * Callers must avoid advancing cursors in this state so conversations are not silently swallowed.
 */
export function isMalformedReflectionOutput(
  rawText: string,
  parsed: ParsedReflectionOutput,
): boolean {
  if (parsed.hasContentChanges) {
    return false;
  }
  const unwrapped = unwrapRawReflectionText(rawText);
  return unwrapped.length > 0 && REFLECTION_XML_TAG_PATTERN.test(unwrapped);
}

/**
 * Returns true if the memory snapshot contains substantive user content beyond initial
 * default templates (used to skip LLM calls during `daily_compact` on empty memory).
 */
export function hasSubstantiveMemoryForCompact(snapshot: ReflectionSnapshot): boolean {
  const profileTrimmed = snapshot.profile.trim();
  if (profileTrimmed.length > 0 && profileTrimmed !== DEFAULT_PROFILE_TEMPLATE.trim()) {
    return true;
  }

  for (const [scope, content] of Object.entries(snapshot.lessons)) {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (scope !== GLOBAL_MEMORY_SCOPE) {
      return true;
    }
    if (trimmed !== DEFAULT_GLOBAL_LESSONS_TEMPLATE.trim()) {
      return true;
    }
  }

  if (snapshot.workingItems.some((item) => item.status === "open")) {
    return true;
  }

  return false;
}
