import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SlackRelayService from "./SlackRelayService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const WorkspaceSchema = Schema.NullOr(
  Schema.Struct({
    team: Schema.NullOr(Schema.String),
    teamId: Schema.NullOr(Schema.String),
    url: Schema.NullOr(Schema.String),
    user: Schema.NullOr(Schema.String),
    userId: Schema.NullOr(Schema.String),
  }),
);

const CtSlackListTool = Tool.make("ct_slack_list", {
  ...shared,
  description:
    "List channels or users in the Slack workspace configured in CT Code Settings → CT Studio → Slack Relay (separate from external Slack MCP workspaces). Returns workspace name and URL so you can confirm the target before posting.",
  parameters: Schema.Struct({
    kind: Schema.optionalKey(Schema.Literals(["channels", "users"])),
    query: Schema.optionalKey(
      Schema.String.annotate({ description: "Optional case-insensitive substring filter." }),
    ),
  }),
  success: Schema.Struct({
    workspace: WorkspaceSchema,
    kind: Schema.Literals(["channels", "users"]),
    count: Schema.Number,
    channels: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          isPrivate: Schema.Boolean,
          isMember: Schema.Boolean,
        }),
      ),
    ),
    users: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          displayName: Schema.String,
          realName: Schema.String,
          isBot: Schema.Boolean,
        }),
      ),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CtSlackPostTool = Tool.make("ct_slack_post", {
  ...shared,
  description:
    "Post a message to the Slack workspace configured in CT Code Settings → CT Studio → Slack Relay (separate from external Slack MCP workspaces). Confirm target workspace when ambiguous, preview with dryRun=true first, and send only after user confirmation.",
  parameters: Schema.Struct({
    channel: Schema.String.annotate({
      description:
        "Target channel ID (C/G/D...), #channel-name, @U... user ID for DM, or Slack archive message URL.",
    }),
    text: Schema.String.annotate({ description: "Message text to post." }),
    threadTs: Schema.optionalKey(
      Schema.String.annotate({ description: "Optional parent thread_ts to reply in a thread." }),
    ),
    asBot: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Send with Bot Token instead of User Token." }),
    ),
    withPrefix: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Prepend the configured Slack Relay reply prefix." }),
    ),
    dryRun: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Preview resolved workspace, channel, thread, and text without sending.",
      }),
    ),
  }),
  success: Schema.Struct({
    dryRun: Schema.Boolean,
    workspace: WorkspaceSchema,
    as: Schema.Literals(["user", "bot"]),
    channelId: Schema.String,
    channelName: Schema.NullOr(Schema.String),
    ts: Schema.NullOr(Schema.String),
    threadTs: Schema.NullOr(Schema.String),
    text: Schema.String,
  }),
}).annotate(Tool.Destructive, true);

export const CtSlackToolkit = Toolkit.make(CtSlackListTool, CtSlackPostTool);

const requireSlackRelay = Effect.flatMap(
  Effect.serviceOption(SlackRelayService.SlackRelayService),
  Option.match({
    onNone: () =>
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "unavailable",
          message: "CT Code Slack Relay service is unavailable in this environment.",
        }),
      ),
    onSome: Effect.succeed,
  }),
);

export const layerCtSlackHandlers = McpToolAccess.toLayer(CtSlackToolkit, {
  ct_slack_list: McpToolAccess.reads(({ kind, query }) =>
    Effect.gen(function* () {
      const relay = yield* requireSlackRelay;
      const targetKind = kind ?? "channels";
      if (targetKind === "users") {
        const result = yield* relay
          .listUsers(query)
          .pipe(
            Effect.mapError(
              (err) =>
                new OrchestratorMcpFailure({ code: "invalid_request", message: err.message }),
            ),
          );
        return {
          workspace: result.workspace,
          kind: "users" as const,
          count: result.users.length,
          users: [...result.users],
        };
      }
      const result = yield* relay
        .listChannels(query)
        .pipe(
          Effect.mapError(
            (err) => new OrchestratorMcpFailure({ code: "invalid_request", message: err.message }),
          ),
        );
      return {
        workspace: result.workspace,
        kind: "channels" as const,
        count: result.channels.length,
        channels: [...result.channels],
      };
    }),
  ),
  ct_slack_post: McpToolAccess.writes(({ channel, text, threadTs, asBot, withPrefix, dryRun }) =>
    Effect.gen(function* () {
      const relay = yield* requireSlackRelay;
      return yield* relay
        .sendSlackMessage({ channel, text, threadTs, asBot, withPrefix, dryRun })
        .pipe(
          Effect.mapError(
            (err) => new OrchestratorMcpFailure({ code: "invalid_request", message: err.message }),
          ),
        );
    }),
  ),
});
