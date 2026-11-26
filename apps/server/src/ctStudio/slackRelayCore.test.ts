import { describe, expect, it } from "vite-plus/test";

import {
  buildSlackRelayPrompt,
  DEFAULT_SLACK_RELAY_CONFIG,
  formatSlackReplyText,
  formatSlackThreadTitle,
  isSlackNoReplyResponse,
  maskSecretValue,
  mergeSlackRelayConfigPatch,
  parseSlackMentions,
  parseSlackMessageUrl,
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
      ),
    ).toEqual({
      ok: true,
      key: "C001:1700000000.000005",
      threadKey: "C001:1700000000.000005",
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
});
