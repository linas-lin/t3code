import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const THREAD_GROUP_TAG_PREFIX = "group:";
export const SCHEDULED_TASK_GROUP_NAME = "定时任务";
export const INBOX_GROUP_NAME = "inbox";
export const MAX_THREAD_GROUP_NAME_LENGTH = 64 - THREAD_GROUP_TAG_PREFIX.length;

/** Tags match by exact spelling and case after trimming. */
export const ThreadTag = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) =>
    /[\p{Cc}]/u.test(value) ? "A thread tag must be a single line of text." : true,
  ),
);
export type ThreadTag = typeof ThreadTag.Type;

/** Tags read back from storage or a peer. Lenient so a later tag rule never fails a whole thread. */
export const StoredThreadTags = Schema.Array(Schema.String).pipe(
  Schema.catchDecoding(() => Effect.succeedSome([])),
);

function truncateCodeUnits(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliced = value.slice(0, maxLength);
  const lastCodeUnit = sliced.charCodeAt(sliced.length - 1);
  // Avoid splitting a UTF-16 surrogate pair at the boundary.
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    return sliced.slice(0, -1).trimEnd();
  }
  return sliced.trimEnd();
}

export function normalizeThreadGroupName(raw: string): string | null {
  let text = raw.trim();
  if (text.startsWith(THREAD_GROUP_TAG_PREFIX)) {
    text = text.slice(THREAD_GROUP_TAG_PREFIX.length).trim();
  }
  text = text.replace(/[\p{Cc}]+/gu, " ").trim();
  if (text.length === 0) return null;
  const truncated = truncateCodeUnits(text, MAX_THREAD_GROUP_NAME_LENGTH);
  return truncated.length > 0 ? truncated : null;
}

export function toThreadGroupTag(rawName: string): ThreadTag | null {
  const normalized = normalizeThreadGroupName(rawName);
  if (normalized === null) return null;
  return `${THREAD_GROUP_TAG_PREFIX}${normalized}` as ThreadTag;
}

export function isThreadGroupTag(tag: string): boolean {
  if (!tag.startsWith(THREAD_GROUP_TAG_PREFIX)) return false;
  return normalizeThreadGroupName(tag.slice(THREAD_GROUP_TAG_PREFIX.length)) !== null;
}

export function getThreadGroupTags(
  tags: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  if (!tags || tags.length === 0) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (!tag.startsWith(THREAD_GROUP_TAG_PREFIX) || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

export function parseThreadGroupName(
  tags: ReadonlyArray<string> | null | undefined,
): string | null {
  if (!tags || tags.length === 0) return null;
  let resolved: string | null = null;
  for (const tag of tags) {
    if (!tag.startsWith(THREAD_GROUP_TAG_PREFIX)) continue;
    const name = normalizeThreadGroupName(tag.slice(THREAD_GROUP_TAG_PREFIX.length));
    if (name !== null) resolved = name;
  }
  return resolved;
}
