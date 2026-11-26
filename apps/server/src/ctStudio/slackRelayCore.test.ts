import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSlackRelayPrompt,
  DEFAULT_SLACK_RELAY_CONFIG,
  extractSlackImageFiles,
  formatSlackReplyText,
  formatSlackThreadTitle,
  isSlackNoReplyResponse,
  isTrustedSlackFileUrl,
  maskSecretValue,
  mergeSlackRelayConfigPatch,
  parseSlackMentions,
  parseSlackMessageUrl,
  resolveSlackSessionKey,
  resolveSlackSessionScope,
  selectSlackImagesToDownload,
  selectSlackThreadHistory,
  shouldProcessSlackRelayEvent,
  toPublicSlackRelayConfig,
} from "./slackRelayCore.ts";

describe("slackRelayCore", () => {
  it("extracts unique Slack user mentions", () => {
    expect(parseSlackMentions("hi <@U111> and <@U222|alice> and <@U111>")).toEqual([
      "U111",
      "U222",
    ]);
    expect(parseSlackMentions("plain message")).toEqual([]);
  });

  it("enforces dedupe, prefix loop guard, self-mention, and allowlists", () => {
    const config = {
      ...DEFAULT_SLACK_RELAY_CONFIG,
      enabled: true,
      myUserId: "U100",
      allowSelfMention: true,
      allowedChannels: ["C001"],
      allowedUsers: ["U200"],
    };
    const processed = new Set(["C001:1700000000.000001"]);

    expect(
      shouldProcessSlackRelayEvent(
        {
          type: "slack_mention",
          event: { channel: "C001", ts: "1700000000.000001", user: "U200", text: "<@U100> hi" },
        },
        config,
        processed,
      ),
    ).toEqual({ ok: false, reason: "duplicate" });

    expect(
      shouldProcessSlackRelayEvent(
        {
          type: "slack_mention",
          event: {
            channel: "C001",
            ts: "1700000000.000002",
            user: "U100",
            text: `${config.replyPrefix}\n\n<@U100> echo`,
          },
        },
        config,
        processed,
      ),
    ).toEqual({ ok: false, reason: "self_bot_reply" });

    expect(
      shouldProcessSlackRelayEvent(
        {
          type: "slack_mention",
          event: { channel: "C999", ts: "1700000000.000003", user: "U200", text: "<@U100> hi" },
        },
        config,
        processed,
      ),
    ).toEqual({ ok: false, reason: "channel_not_allowed" });

    expect(
      shouldProcessSlackRelayEvent(
        {
          type: "slack_mention",
          event: { channel: "C001", ts: "1700000000.000004", user: "U999", text: "<@U100> hi" },
        },
        config,
        processed,
      ),
    ).toEqual({ ok: false, reason: "user_not_allowed" });

    expect(
      shouldProcessSlackRelayEvent(
        {
          type: "slack_mention",
          event: { channel: "C001", ts: "1700000000.000005", user: "U100", text: "<@U100> test" },
        },
        config,
        processed,
        { now: DateTime.makeZonedUnsafe("2026-11-26T15:00:00+08:00") },
      ),
    ).toEqual({
      ok: true,
      key: "C001:1700000000.000005",
      threadKey: "C001:1700000000.000005",
      sessionScope: "thread",
      sessionKey: "C001:1700000000.000005",
      dateKey: "2026-11-26",
    });
  });

  it("preserves existing secrets on partial patch and masks public config", () => {
    const initial = mergeSlackRelayConfigPatch(DEFAULT_SLACK_RELAY_CONFIG, {
      enabled: true,
      relaySecret: "secret-1234567890",
      userToken: "xoxp-1111-2222-3333",
      botToken: "xoxb-4444-5555-6666",
      replyMode: "auto",
    });

    const updated = mergeSlackRelayConfigPatch(initial, {
      replyPrefix: "🤖 [Bot]",
      clearBotToken: true,
    });

    expect(updated.relaySecret).toBe("secret-1234567890");
    expect(updated.userToken).toBe("xoxp-1111-2222-3333");
    expect(updated.botToken).toBe("");
    expect(updated.replyPrefix).toBe("🤖 [Bot]");

    const pub = toPublicSlackRelayConfig(updated);
    expect(pub.hasRelaySecret).toBe(true);
    expect(pub.relaySecretPreview).toBe(maskSecretValue("secret-1234567890"));
    expect(pub.hasUserToken).toBe(true);
    expect(pub.hasBotToken).toBe(false);
    expect(pub.runtimeMode).toBe("approval-required");
  });

  it("formats thread titles with channel, sender, and mention-stripped summary", () => {
    expect(
      formatSlackThreadTitle(
        { channel: "C001", text: "<@U100> 帮我看一下订单报错" },
        { channelName: "ba-dev", senderName: "Alice" },
      ),
    ).toBe("#ba-dev · Alice：帮我看一下订单报错");

    expect(
      formatSlackThreadTitle({ channel: "C001", text: "<@U100>" }, { channelName: "ba-dev" }),
    ).toBe("#ba-dev · @提及");

    expect(formatSlackThreadTitle({ channel: "C001", text: "<@U100> hello" })).toBe("C001 · hello");
  });

  it("formats reply prefix once and injects user instructions and skill path cleanly", () => {
    expect(formatSlackReplyText("好的，马上看", { replyPrefix: "🤖 [AI]" })).toBe(
      "🤖 [AI]\n\n好的，马上看",
    );
    expect(formatSlackReplyText("🤖 [AI]\n\n已带前缀", { replyPrefix: "🤖 [AI]" })).toBe(
      "🤖 [AI]\n\n已带前缀",
    );

    const prompt = buildSlackRelayPrompt(
      {
        type: "slack_mention",
        event: { channel: "C001", ts: "1700000001.000001", user: "U200", text: "<@U100> 查一下" },
      },
      {
        channelName: "ba-dev",
        senderName: "Alice",
        threadMessages: [{ user: "U200", text: "之前报错了" }],
        customPrompt: "回复控制在 3 句话以内。",
        promptFile: {
          filePath: "/repo/.agents/skills/my-bot/SKILL.md",
          dirPath: "/repo/.agents/skills/my-bot",
          content: "使用 scripts/check.mjs 检查状态。",
        },
      },
    );
    expect(prompt).toContain("<user_instructions>");
    expect(prompt).toContain("回复控制在 3 句话以内。");
    expect(prompt).toContain("所在目录：/repo/.agents/skills/my-bot");
    expect(prompt).toContain("<slack_thread_history>");
    expect(prompt).toContain("<slack_message>");
    expect(prompt).toContain("外部不可信输入");
    expect(prompt).toContain("[[NO_REPLY]]");
  });

  it("enforces requireBotMention, triggerKeywords, thread pagination selection, and NO_REPLY sentinel", () => {
    const config = {
      ...DEFAULT_SLACK_RELAY_CONFIG,
      enabled: true,
      myUserId: "U100",
      requireBotMention: true,
      triggerKeywords: ["ai", "帮查"],
    };
    const processed = new Set<string>();

    expect(
      shouldProcessSlackRelayEvent(
        {
          type: "slack_mention",
          event: { channel: "C001", ts: "1.1", user: "U200", text: "<@U100> 帮查一下" },
        },
        config,
        processed,
        { botUserId: null },
      ),
    ).toEqual({ ok: false, reason: "missing_bot_user_id" });

    expect(
      shouldProcessSlackRelayEvent(
        {
          type: "slack_mention",
          event: { channel: "C001", ts: "1.2", user: "U200", text: "<@U100> 帮查一下" },
        },
        config,
        processed,
        { botUserId: "UBOT1" },
      ),
    ).toEqual({ ok: false, reason: "bot_not_mentioned" });

    expect(
      shouldProcessSlackRelayEvent(
        {
          type: "slack_mention",
          event: { channel: "C001", ts: "1.3", user: "U200", text: "<@U100> <@UBOT1> 约个会" },
        },
        config,
        processed,
        { botUserId: "UBOT1" },
      ),
    ).toEqual({ ok: false, reason: "keyword_not_matched" });

    expect(
      shouldProcessSlackRelayEvent(
        {
          type: "slack_mention",
          event: { channel: "C001", ts: "1.4", user: "U200", text: "<@U100> <@UBOT1> AI 帮查" },
        },
        config,
        processed,
        { botUserId: "UBOT1" },
      ).ok,
    ).toBe(true);

    const history = Array.from({ length: 30 }, (_, idx) => ({
      ts: `100.${idx}`,
      user: `U${idx}`,
      text: `msg-${idx}`,
    }));
    const selected = selectSlackThreadHistory(history, "100.29", 5);
    expect(selected).toHaveLength(7);
    expect(selected[0]?.text).toBe("msg-0");
    expect(selected[1]?.user).toBe("system");
    expect(selected.at(-1)?.text).toBe("msg-28");

    expect(isSlackNoReplyResponse("[[NO_REPLY]]")).toBe(true);
    expect(isSlackNoReplyResponse(" `[[no_reply]]` ")).toBe(true);
    expect(isSlackNoReplyResponse("我来查一下日志")).toBe(false);

    expect(
      parseSlackMessageUrl(
        "https://xm-bahq.slack.com/archives/C0CLWAVC273/p1764079801123456?thread_ts=1764079000.000100",
      ),
    ).toEqual({
      workspaceSubdomain: "xm-bahq",
      channelId: "C0CLWAVC273",
      messageTs: "1764079801.123456",
      threadTs: "1764079000.000100",
    });
    expect(parseSlackMessageUrl("https://example.com/nope")).toBeNull();
  });

  it("cleans Slack link tokens, Jira/PR URLs, and special mrkdwn symbols in thread titles", () => {
    expect(
      formatSlackThreadTitle(
        {
          channel: "C001",
          text: "<@U100> <@UBOT> <https://wonder.atlassian.net/browse/BLUE-1234> 帮看下这个需求",
        },
        { channelName: "linas-box-test", senderName: "linaslin" },
      ),
    ).toBe("#linas-box-test · linaslin：BLUE-1234 帮看下这个需求");

    expect(
      formatSlackThreadTitle(
        {
          channel: "C001",
          text: "<@U100> <https://github.com/org/repo/pull/88> *加粗* `auto_ship` <!here> <#C123|ba-dev>",
        },
        { channelName: "ba-dev", senderName: "Alice" },
      ),
    ).toBe("#ba-dev · Alice：PR#88 加粗 auto_ship #ba-dev");

    expect(
      formatSlackThreadTitle(
        {
          channel: "C001",
          text: "<@U100> <https://example.com/path|订单文档> &lt;详情&gt;",
        },
        { channelName: "ba-dev" },
      ),
    ).toBe("#ba-dev · 订单文档 详情");

    expect(
      formatSlackThreadTitle(
        {
          channel: "C001",
          text: "<@U100> <https://wonder.atlassian.net/wiki/spaces/BA/pages/12345/AutoShip+Flow>",
        },
        { channelName: "ba-dev" },
      ),
    ).toBe("#ba-dev · AutoShip Flow");
  });

  it("extracts trusted Slack image files and skips history images on existing threads", () => {
    expect(isTrustedSlackFileUrl("https://files.slack.com/files-pri/T1-F1/download/a.png")).toBe(
      true,
    );
    expect(isTrustedSlackFileUrl("https://evil.example.com/a.png")).toBe(false);
    expect(isTrustedSlackFileUrl("http://files.slack.com/a.png")).toBe(false);

    const img = (id: string, name = `${id}.png`) => ({
      id,
      name,
      mimetype: "image/png",
      size: 2048,
      url_private_download: `https://files.slack.com/files-pri/T1-${id}/download/${name}`,
    });

    const extracted = extractSlackImageFiles([
      img("F1"),
      {
        id: "F2",
        name: "spec.pdf",
        mimetype: "application/pdf",
        url_private_download: "https://files.slack.com/files-pri/T1-F2/spec.pdf",
      },
      {
        id: "F3",
        name: "bad.png",
        mimetype: "image/png",
        url_private_download: "https://attacker.example/bad.png",
      },
    ]);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]?.id).toBe("F1");

    const event = { channel: "C001", ts: "100.5", text: "<@U100> 帮看下报错", files: [img("F5")] };
    const history = [
      { ts: "100.1", user: "U200", text: "第一张图", files: [img("F1"), img("F2")] },
      { ts: "100.2", user: "U200", text: "第二张图", files: [img("F3"), img("F4")] },
    ];

    const fresh = selectSlackImagesToDownload(event, history, {
      isExistingSession: false,
      maxImages: 4,
    });
    expect(fresh.selected.map((f) => f.id)).toEqual(["F2", "F3", "F4", "F5"]);
    expect(fresh.omittedCount).toBe(1);

    const followUp = selectSlackImagesToDownload(event, history, {
      isExistingSession: true,
      maxImages: 4,
    });
    expect(followUp.selected.map((f) => f.id)).toEqual(["F5"]);
    expect(followUp.omittedCount).toBe(0);

    const prompt = buildSlackRelayPrompt(
      { type: "slack_mention", event },
      {
        channelName: "ba-dev",
        threadMessages: history,
        attachedImageNames: ["F5.png"],
        imageNotes: ["另有 1 张历史图片未下载。"],
      },
    );
    expect(prompt).toContain("[附图片: F1.png, F2.png]");
    expect(prompt).toContain("已作为本条消息的图片附件直接传入（共 1 张）：F5.png");
    expect(prompt).toContain("另有 1 张历史图片未下载。");
  });

  it("supports thread, channel, channel-daily, and per-channel sessionScope overrides", () => {
    const cfg = mergeSlackRelayConfigPatch(DEFAULT_SLACK_RELAY_CONFIG, {
      enabled: true,
      myUserId: "U100",
      sessionScope: "channel",
      channelSessionScopes: {
        c002: "channel-daily",
        C003: "thread",
      },
    });
    expect(cfg.sessionScope).toBe("channel");
    expect(cfg.channelSessionScopes).toEqual({ C002: "channel-daily", C003: "thread" });
    expect(resolveSlackSessionScope(cfg, "C001")).toBe("channel");
    expect(resolveSlackSessionScope(cfg, "C002")).toBe("channel-daily");
    expect(resolveSlackSessionScope(cfg, "C003")).toBe("thread");

    const day1 = DateTime.makeZonedUnsafe("2026-11-26T10:00:00+08:00");
    const day2 = DateTime.makeZonedUnsafe("2026-11-27T09:00:00+08:00");

    expect(
      resolveSlackSessionKey({ channel: "C001", ts: "100.1", thread_ts: "100.0" }, cfg, day1),
    ).toEqual({
      sessionScope: "channel",
      sessionKey: "channel:C001",
      dateKey: "2026-11-26",
    });
    expect(
      resolveSlackSessionKey({ channel: "C001", ts: "200.1", thread_ts: "200.0" }, cfg, day2),
    ).toEqual({
      sessionScope: "channel",
      sessionKey: "channel:C001",
      dateKey: "2026-11-27",
    });
    expect(
      resolveSlackSessionKey({ channel: "C002", ts: "100.1", thread_ts: "100.0" }, cfg, day1),
    ).toEqual({
      sessionScope: "channel-daily",
      sessionKey: "channel:C002:2026-11-26",
      dateKey: "2026-11-26",
    });
    expect(
      resolveSlackSessionKey({ channel: "C002", ts: "200.1", thread_ts: "200.0" }, cfg, day2),
    ).toEqual({
      sessionScope: "channel-daily",
      sessionKey: "channel:C002:2026-11-27",
      dateKey: "2026-11-27",
    });
    expect(
      resolveSlackSessionKey({ channel: "C003", ts: "100.2", thread_ts: "100.0" }, cfg, day1),
    ).toEqual({
      sessionScope: "thread",
      sessionKey: "C003:100.0",
      dateKey: "2026-11-26",
    });

    expect(
      formatSlackThreadTitle(
        { channel: "C001", text: "<@U100> 随便问一句" },
        { channelName: "ba-oncall", senderName: "Alice", sessionScope: "channel" },
      ),
    ).toBe("#ba-oncall");
    expect(
      formatSlackThreadTitle(
        { channel: "C002", text: "<@U100> 随便问一句" },
        {
          channelName: "ba-oncall",
          senderName: "Alice",
          sessionScope: "channel-daily",
          dateKey: "2026-11-26",
        },
      ),
    ).toBe("#ba-oncall · 11-26");

    const sharedPrompt = buildSlackRelayPrompt(
      {
        type: "slack_mention",
        event: {
          channel: "C001",
          ts: "1700000005.000002",
          thread_ts: "1700000005.000001",
          user: "U200",
          text: "<@U100> 新问题",
        },
      },
      {
        channelName: "ba-oncall",
        senderName: "Alice",
        sessionScope: "channel-daily",
        isReturningThread: false,
      },
    );
    expect(sharedPrompt).toContain("按天共享会话");
    expect(sharedPrompt).toContain("Thread ts：1700000005.000001");
    expect(sharedPrompt).toContain("新 thread（与此前其他 thread 话题相互独立）");
  });
});
