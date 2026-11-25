import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  getThreadGroupTags,
  INBOX_GROUP_NAME,
  isThreadGroupTag,
  MAX_THREAD_GROUP_NAME_LENGTH,
  normalizeThreadGroupName,
  parseThreadGroupName,
  SCHEDULED_TASK_GROUP_NAME,
  THREAD_GROUP_TAG_PREFIX,
  ThreadTag,
  toThreadGroupTag,
} from "./threadTags.ts";

const isValidThreadTag = Schema.is(ThreadTag);

describe("threadTags group helpers", () => {
  it("normalizes names, strips prefix and control chars, and truncates safely", () => {
    expect(normalizeThreadGroupName("  BLUE-123  ")).toBe("BLUE-123");
    expect(normalizeThreadGroupName("group:  BLUE-123  ")).toBe("BLUE-123");
    expect(normalizeThreadGroupName("line1\nline2\tpart")).toBe("line1 line2 part");
    expect(normalizeThreadGroupName("   \n\t  ")).toBeNull();
    expect(normalizeThreadGroupName("group:   ")).toBeNull();

    const longName = "a".repeat(MAX_THREAD_GROUP_NAME_LENGTH + 12);
    const truncated = normalizeThreadGroupName(longName);
    expect(truncated).toHaveLength(MAX_THREAD_GROUP_NAME_LENGTH);

    const emojiBoundary = `${"a".repeat(MAX_THREAD_GROUP_NAME_LENGTH - 1)}🚀`;
    const truncatedEmoji = normalizeThreadGroupName(emojiBoundary);
    expect(truncatedEmoji).toBe("a".repeat(MAX_THREAD_GROUP_NAME_LENGTH - 1));
  });

  it("builds valid ThreadTag values for built-in and custom groups", () => {
    const scheduledTag = toThreadGroupTag(SCHEDULED_TASK_GROUP_NAME);
    const inboxTag = toThreadGroupTag(INBOX_GROUP_NAME);
    const ticketTag = toThreadGroupTag("BLUE-123");

    expect(scheduledTag).toBe(`${THREAD_GROUP_TAG_PREFIX}定时任务`);
    expect(inboxTag).toBe(`${THREAD_GROUP_TAG_PREFIX}inbox`);
    expect(ticketTag).toBe(`${THREAD_GROUP_TAG_PREFIX}BLUE-123`);
    expect(scheduledTag !== null && isValidThreadTag(scheduledTag)).toBe(true);
    expect(inboxTag !== null && isValidThreadTag(inboxTag)).toBe(true);
    expect(ticketTag !== null && isValidThreadTag(ticketTag)).toBe(true);
    expect(toThreadGroupTag("   ")).toBeNull();
  });

  it("identifies, lists, and resolves group tags with last-write precedence", () => {
    expect(isThreadGroupTag("group:BLUE-123")).toBe(true);
    expect(isThreadGroupTag("group:   ")).toBe(false);
    expect(isThreadGroupTag("private")).toBe(false);

    const tags = ["private", "group:OLD-1", "group:BLUE-123", "group:OLD-1", "other"];
    expect(getThreadGroupTags(tags)).toEqual(["group:OLD-1", "group:BLUE-123"]);
    expect(parseThreadGroupName(tags)).toBe("OLD-1");
    expect(parseThreadGroupName(["private", "group:OLD-1", "group:BLUE-123"])).toBe("BLUE-123");
    expect(parseThreadGroupName(["private"])).toBeNull();
    expect(parseThreadGroupName(undefined)).toBeNull();
  });
});
