import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { GLOBAL_MEMORY_SCOPE, normalizeMemoryScope, toProjectSlug } from "./personalPaths.ts";
import type { PersonalContextBuildInput, WorkingItem, WorkingPriority } from "./personalTypes.ts";

export const DEFAULT_PERSONAL_CONTEXT_MAX_BYTES = 3200;
const MAX_ACTIVE_WORKING_ITEMS = 2;
const MAX_PROJECT_META_BYTES = 200;

const PRIORITY_RANK: Readonly<Record<WorkingPriority, number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

const PROTOCOL_SECTION = `[发言协议]
默认直接回答当前正事，零闲聊，不复述已知偏好；仅当下方待跟进事项与当前话题高度相关或为 high 优先级且未提醒时，在回复末尾用 1~2 行 P.S. 简短带过，并立即调用 personal_working_update 将其标记为 reminded。`;

const TOOLS_SECTION = `[个人记忆工具]
- personal_memory_search：按关键词/scope 检索长期记忆与经验。
- personal_memory_note：记录 guardrails / profile / lesson / working。
- personal_working_update：更新待跟进事项状态（reminded / done / dismiss）。
- personal_thread_privacy：开启或关闭当前会话无痕隐私（opt-out）。
- personal_reflect_now：手动触发当前记忆反思整理。`;

export interface BuildPersonalContextBlockParams {
  readonly input: PersonalContextBuildInput;
  readonly isOptOut: boolean;
  readonly guardrails: string;
  readonly profile: string;
  readonly workingItems: ReadonlyArray<WorkingItem>;
}

/**
 * Truncates a string to fit strictly within `maxBytes` in UTF-8 without splitting
 * multi-byte Unicode code points.
 */
function truncateUtf8(text: string, maxBytes: number, ellipsis = "…"): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  const budget = maxBytes >= ellipsisBytes ? maxBytes - ellipsisBytes : maxBytes;
  let used = 0;
  let out = "";

  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (used + chBytes > budget) {
      break;
    }
    out += ch;
    used += chBytes;
  }

  return maxBytes >= ellipsisBytes ? `${out.trimEnd()}${ellipsis}` : out;
}

function isExpired(expiresAt: string | null, nowIso: string): boolean {
  if (expiresAt === null) {
    return false;
  }
  const trimmed = expiresAt.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const expiresUtc = DateTime.make(trimmed);
  const nowUtc = DateTime.make(nowIso);
  if (Option.isSome(expiresUtc) && Option.isSome(nowUtc)) {
    return DateTime.toEpochMillis(expiresUtc.value) <= DateTime.toEpochMillis(nowUtc.value);
  }
  // Fallback for non-standard ISO-like strings.
  return trimmed <= nowIso;
}

/**
 * Selects up to `limit` (default 2) active, unreminded, unexpired working items visible
 * for `projectSlug` (matching `"global"` or `projectSlug`), ordered by priority (`high > medium > low`).
 */
export function selectActiveWorkingItems(
  workingItems: ReadonlyArray<WorkingItem>,
  projectSlug: string | null,
  nowIso: string,
  limit = MAX_ACTIVE_WORKING_ITEMS,
): ReadonlyArray<WorkingItem> {
  const normalizedProject =
    projectSlug !== null && projectSlug.trim().length > 0 ? toProjectSlug(projectSlug) : null;

  return workingItems
    .filter((item) => {
      if (item.status !== "open" || item.reminded) {
        return false;
      }
      if (isExpired(item.expiresAt, nowIso)) {
        return false;
      }
      const itemScope = normalizeMemoryScope(item.scope);
      if (itemScope === GLOBAL_MEMORY_SCOPE) {
        return true;
      }
      return normalizedProject !== null && itemScope === normalizedProject;
    })
    .toSorted((a, b) => {
      const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (rankDiff !== 0) {
        return rankDiff;
      }
      if (normalizedProject !== null) {
        const aExact = normalizeMemoryScope(a.scope) === normalizedProject ? 0 : 1;
        const bExact = normalizeMemoryScope(b.scope) === normalizedProject ? 0 : 1;
        if (aExact !== bExact) {
          return aExact - bExact;
        }
      }
      const updatedDiff = b.updatedAt.localeCompare(a.updatedAt);
      if (updatedDiff !== 0) {
        return updatedDiff;
      }
      return a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

/** Compacts markdown prose into concise bullet lines suitable for a bounded prompt block. */
function summarizeMarkdown(markdown: string): string {
  const lines = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      if (line.startsWith("#")) return false;
      if (line.startsWith(">")) return false;
      if (line.startsWith("<!--") && line.endsWith("-->")) return false;
      return true;
    })
    .map((line) => line.replace(/\s+/g, " "));

  return lines.join("\n");
}

function formatWorkingItems(items: ReadonlyArray<WorkingItem>): string {
  return items
    .map((item) => {
      const singleLineSummary = item.summary.replace(/\s+/g, " ").trim();
      const scope = normalizeMemoryScope(item.scope);
      return `- [${item.id}] (${item.priority}, ${scope}): ${singleLineSummary}`;
    })
    .join("\n");
}

function renderSection(title: string, body: string, maxBytes: number): string {
  if (body.trim().length === 0 || maxBytes <= 0) {
    return "";
  }
  const header = `${title}\n`;
  const headerBytes = Buffer.byteLength(header, "utf8");
  if (maxBytes <= headerBytes + 4) {
    return "";
  }
  const clippedBody = truncateUtf8(body, maxBytes - headerBytes);
  return `${header}${clippedBody}`;
}

function buildProjectMeta(
  projectTitle: string | null | undefined,
  normalizedProjectSlug: string | null,
): string {
  const rawTitle = projectTitle?.replace(/\s+/g, " ").trim() ?? "";
  if (rawTitle.length > 0) {
    const prefix = "[当前项目] ";
    if (normalizedProjectSlug !== null) {
      const suffix = ` (${normalizedProjectSlug})`;
      const titleBudget =
        MAX_PROJECT_META_BYTES -
        Buffer.byteLength(prefix, "utf8") -
        Buffer.byteLength(suffix, "utf8");
      if (titleBudget >= 16) {
        return `${prefix}${truncateUtf8(rawTitle, titleBudget)}${suffix}`;
      }
      return truncateUtf8(`${prefix}${rawTitle}${suffix}`, MAX_PROJECT_META_BYTES);
    }
    return truncateUtf8(`${prefix}${rawTitle}`, MAX_PROJECT_META_BYTES);
  }
  if (normalizedProjectSlug !== null) {
    return truncateUtf8(`[当前项目] ${normalizedProjectSlug}`, MAX_PROJECT_META_BYTES);
  }
  return "";
}

/**
 * Pure builder for the `<personal_context>` prompt block injected into agent turns.
 * Guarantees `Buffer.byteLength(result, "utf8") <= maxBytes` (default 3200) and never emits
 * malformed XML missing its closing `</personal_context>` tag.
 */
export function buildPersonalContextBlock(params: BuildPersonalContextBlockParams): string {
  if (params.isOptOut) {
    return "";
  }

  const maxBytes = Math.floor(params.input.maxBytes ?? DEFAULT_PERSONAL_CONTEXT_MAX_BYTES);
  const openTag = "<personal_context>\n";
  const closeTag = "\n</personal_context>";
  const wrapperBytes = Buffer.byteLength(openTag, "utf8") + Buffer.byteLength(closeTag, "utf8");
  if (maxBytes <= wrapperBytes + 8) {
    return "";
  }

  const normalizedProjectSlug =
    params.input.projectSlug !== undefined &&
    params.input.projectSlug !== null &&
    params.input.projectSlug.trim().length > 0
      ? toProjectSlug(params.input.projectSlug)
      : null;

  const activeWorking = selectActiveWorkingItems(
    params.workingItems,
    normalizedProjectSlug,
    params.input.nowIso,
    MAX_ACTIVE_WORKING_ITEMS,
  );

  const projectMeta = buildProjectMeta(params.input.projectTitle, normalizedProjectSlug);

  // Keep PROTOCOL_SECTION first so a long projectTitle or tight budget can never crowd it out.
  const coreParts = [
    PROTOCOL_SECTION,
    ...(projectMeta.length > 0 ? [projectMeta] : []),
    TOOLS_SECTION,
  ];
  const coreText = coreParts.join("\n\n");
  const coreBytes = Buffer.byteLength(coreText, "utf8");

  // If maxBytes is too tight to even hold the core protocol + tools cleanly, hard-truncate inside intact tags.
  if (wrapperBytes + coreBytes >= maxBytes) {
    const innerBudget = maxBytes - wrapperBytes;
    const clippedCore = truncateUtf8(coreText, innerBudget);
    if (clippedCore.trim().length === 0) {
      return "";
    }
    return `${openTag}${clippedCore}${closeTag}`;
  }

  const guardrailsRaw = summarizeMarkdown(params.guardrails);
  const workingRaw = formatWorkingItems(activeWorking);
  const profileRaw = summarizeMarkdown(params.profile);

  // Reserve separator bytes (`\n\n` = 2 bytes) per optional section dynamically.
  // Priority: Guardrails (hard redlines) -> Working (<= 2 items) -> Profile.
  let remaining = maxBytes - wrapperBytes - coreBytes;
  const optionalSections: Array<string> = [];

  const entries: ReadonlyArray<{
    readonly title: string;
    readonly body: string;
    readonly share: number;
  }> = [
    { title: "[红线 Guardrails]", body: guardrailsRaw, share: 0.55 },
    { title: "[待跟进 Working]", body: workingRaw, share: 0.55 },
    { title: "[偏好 Profile]", body: profileRaw, share: 1.0 },
  ];

  const nonEmptyEntries = entries.filter((entry) => entry.body.trim().length > 0);
  for (let i = 0; i < nonEmptyEntries.length; i += 1) {
    const entry = nonEmptyEntries[i]!;
    const sepBytes = 2; // "\n\n"
    if (remaining <= sepBytes + 12) {
      break;
    }
    const available = remaining - sepBytes;
    const isLast = i === nonEmptyEntries.length - 1;
    const headerBytes = Buffer.byteLength(`${entry.title}\n`, "utf8");
    const minViable = headerBytes + 16;
    const fullSection = `${entry.title}\n${entry.body}`;
    const fullBytes = Buffer.byteLength(fullSection, "utf8");
    const targetBudget = isLast
      ? available
      : Math.min(available, Math.max(Math.floor(available * entry.share), minViable));
    const allocated = fullBytes <= targetBudget ? fullBytes : targetBudget;
    const rendered = renderSection(entry.title, entry.body, allocated);
    if (rendered.length > 0) {
      optionalSections.push(rendered);
      remaining -= sepBytes + Buffer.byteLength(rendered, "utf8");
    }
  }

  const assembled = `${openTag}${[coreText, ...optionalSections].join("\n\n")}${closeTag}`;
  if (Buffer.byteLength(assembled, "utf8") <= maxBytes) {
    return assembled;
  }

  // Unbreakable final UTF-8 byte ceiling guard with guaranteed well-formed wrapper tags.
  const inner = [coreText, ...optionalSections].join("\n\n");
  const clippedInner = truncateUtf8(inner, maxBytes - wrapperBytes);
  return clippedInner.trim().length === 0 ? "" : `${openTag}${clippedInner}${closeTag}`;
}
