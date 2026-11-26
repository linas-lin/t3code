import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  isCtStudioSafeReadOnlyAcpRequest,
  isCtStudioSafeReadOnlyClaudeTool,
  isSafeCtStudioReadOnlyCommand,
  isSafeCtStudioReadOnlyMcpTool,
} from "./readOnlyPermissionPolicy.ts";

const CT_STUDIO_OPTIONS = {
  isCtStudioWorkspace: (cwd: string) => cwd === "/fake/ct-studio",
};

function makeExecuteRequest(
  commandLine: string,
  overrides?: Partial<EffectAcpSchema.RequestPermissionRequest["toolCall"]>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "call-1",
      title: "Ran command",
      kind: "execute",
      rawInput: { CommandLine: commandLine },
      ...overrides,
    },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  };
}

function makeMcpRequest(
  title: string,
  rawInput?: Record<string, unknown>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "call-1",
      title,
      kind: "execute",
      ...(rawInput === undefined ? {} : { rawInput }),
    },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  };
}

describe("isSafeCtStudioReadOnlyCommand", () => {
  it("allows CT Studio read-only data, DW, log, VPN, and git queries", () => {
    const safeCommands = [
      `node .agents/skills/query-data/scripts/cli.mjs profiles`,
      `node .agents/skills/query-data/scripts/cli.mjs check --env prod`,
      `node .agents/skills/query-data/scripts/cli.mjs mysql --env prod --database ba_auto_ship --request '{"operation":"tables"}'`,
      [
        `node .agents/skills/query-data/scripts/cli.mjs mysql --env prod --database ba_auto_ship --request - <<'JSON'`,
        `{"operation":"query","sql":"SELECT COUNT(*) FROM auto_ship_carts WHERE status = ?","params":["ACTIVE"]}`,
        `JSON`,
      ].join("\n"),
      `node .agents/skills/query-dw/scripts/cli.mjs profiles && node .agents/skills/query-dw/scripts/cli.mjs check --env prod`,
      `node .agents/skills/query-dw/scripts/cli.mjs tables --env prod --project wonder-raw-prod --dataset mysql_batch_ba_auto_ship`,
      `node .agents/skills/query-logs/scripts/cli.mjs check --env prod && node .agents/skills/query-logs/scripts/cli.mjs indices --env prod`,
      `.agents/skills/ct-vpn/scripts/check-vpn-status.sh prod`,
      `bash .agents/skills/ct-vpn/scripts/proxy-port.sh prod`,
      `python3 .agents/skills/link-repo/scripts/repo.py status blueapron --fetch`,
      `date -u && ls -la .config/query-logs/notes/ .config/query-data/notes/ 2>&1; echo "=== profiles ==="; node .agents/skills/query-logs/scripts/cli.mjs profiles`,
      `git -C repos/blueapron-project show origin/uat:backend/App.java | nl -ba | sed -n '235,355p'`,
      `git -C repos/blueapron-project diff origin/uat..origin/develop -- backend/App.java`,
      `node .agents/skills/personal-slack-reply/scripts/format-slack.mjs --check`,
    ];

    for (const cmd of safeCommands) {
      expect(isSafeCtStudioReadOnlyCommand(cmd), cmd).toBe(true);
    }
  });

  it("rejects mutating subcommands, cost overrides, shell escapes, redirections, and secret reads", () => {
    const unsafeCommands = [
      // Mutating skill subcommands
      `node .agents/skills/query-data/scripts/cli.mjs add-databases --env prod --request -`,
      `node .agents/skills/query-data/scripts/cli.mjs login --env prod`,
      `node .agents/skills/query-logs/scripts/cli.mjs login --env prod`,
      `node .agents/skills/query-dw/scripts/cli.mjs query --env prod --max-gb 100 --request -`,
      `node .agents/skills/query-dw/scripts/cli.mjs query --env prod --max-gb=50 --request -`,
      `node .agents/skills/slack-relay/scripts/cli.mjs post --channel "#test" --text "hi"`,
      `node .agents/skills/slack-relay/scripts/cli.mjs send draft-1`,
      `.agents/skills/ct-vpn/scripts/warp-service.sh stop prod`,
      `python3 .agents/skills/link-repo/scripts/repo.py update blueapron`,
      `python3 .agents/skills/setup/scripts/steps.py update --apply`,
      // Arbitrary node/python execution or env injection
      `node -e "console.log(1)"`,
      `NODE_OPTIONS="--require ./evil.js" node .agents/skills/query-data/scripts/cli.mjs profiles`,
      `python3 -c "import os; os.system('id')"`,
      // Chained destructive commands or shell escapes
      `node .agents/skills/query-data/scripts/cli.mjs profiles && rm -rf /tmp/x`,
      `node .agents/skills/query-data/scripts/cli.mjs profiles; touch pwned`,
      `echo $(whoami)`,
      `echo "$(whoami)"`,
      "echo `whoami`",
      // Unquoted or double-quoted heredocs allow command substitution
      `node .agents/skills/query-data/scripts/cli.mjs mysql --env prod --request - <<JSON\n$(whoami)\nJSON`,
      `node .agents/skills/query-data/scripts/cli.mjs mysql --env prod --request - <<"JSON"\n$(whoami)\nJSON`,
      // File redirections
      `node .agents/skills/query-data/scripts/cli.mjs profiles > out.txt`,
      `echo hello >> notes.md`,
      `cat < .config/query-data/.env`,
      // Mutating git / sed
      `git checkout main`,
      `git -C repos/blueapron-project push`,
      `git -C repos/blueapron-project show HEAD --output=/tmp/x`,
      `git branch -D old-branch`,
      `sed -i '' 's/a/b/g' file.txt`,
      `sed -n '1,5w /tmp/leak' file.txt`,
      // Sensitive paths
      `cat .config/query-data/.env`,
      `cat ~/.t3-ct/userdata/slack-relay.json`,
      `rg token ~/.ssh/id_rsa`,
      `ls -la ~/.t3-ct/userdata/secrets`,
    ];

    for (const cmd of unsafeCommands) {
      expect(isSafeCtStudioReadOnlyCommand(cmd), cmd).toBe(false);
    }
  });
});

describe("isCtStudioSafeReadOnlyAcpRequest", () => {
  it("allows safe read-only commands and MCP tools in approval-required and auto-accept-edits for ct-studio", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const policy = { runtimeMode, cwd: "/fake/ct-studio" };
      expect(
        isCtStudioSafeReadOnlyAcpRequest(
          policy,
          makeExecuteRequest(`node .agents/skills/query-data/scripts/cli.mjs check --env prod`),
          CT_STUDIO_OPTIONS,
        ),
      ).toBe(true);
      expect(
        isCtStudioSafeReadOnlyAcpRequest(
          policy,
          makeMcpRequest("Run mcp_ct-mcp_datadog_analyze_datadog_logs?"),
          CT_STUDIO_OPTIONS,
        ),
      ).toBe(true);
      expect(
        isCtStudioSafeReadOnlyAcpRequest(
          policy,
          makeMcpRequest("MCP Tool slack_read_thread", {
            ServerName: "ct-mcp_slack",
            ToolName: "slack_read_thread",
          }),
          CT_STUDIO_OPTIONS,
        ),
      ).toBe(true);
      expect(
        isCtStudioSafeReadOnlyAcpRequest(
          policy,
          makeMcpRequest("Run mcp_t3-code_ct_slack_list?"),
          CT_STUDIO_OPTIONS,
        ),
      ).toBe(true);
    }
  });

  it("blocks non-ct-studio workspaces, explicit approvalPolicy, restrictive sandboxes, and mutating MCP tools", () => {
    const req = makeExecuteRequest(
      `node .agents/skills/query-data/scripts/cli.mjs check --env prod`,
    );

    // Non-ct-studio workspace stays completely untouched
    expect(
      isCtStudioSafeReadOnlyAcpRequest(
        { runtimeMode: "approval-required", cwd: "/other/project" },
        req,
        CT_STUDIO_OPTIONS,
      ),
    ).toBe(false);

    // Explicit approvalPolicy must not be bypassed
    expect(
      isCtStudioSafeReadOnlyAcpRequest(
        { runtimeMode: "approval-required", cwd: "/fake/ct-studio", approvalPolicy: "on-request" },
        req,
        CT_STUDIO_OPTIONS,
      ),
    ).toBe(false);

    // Restrictive sandbox must not be bypassed
    expect(
      isCtStudioSafeReadOnlyAcpRequest(
        {
          runtimeMode: "approval-required",
          cwd: "/fake/ct-studio",
          sandboxPolicy: { type: "readOnly" },
        },
        req,
        CT_STUDIO_OPTIONS,
      ),
    ).toBe(false);

    // Mutating MCP tools must still require approval
    const policy = { runtimeMode: "approval-required" as const, cwd: "/fake/ct-studio" };
    for (const mutatingMcp of [
      makeMcpRequest("Run mcp_t3-code_ct_slack_post?"),
      makeMcpRequest("Run mcp_ct-mcp_slack_slack_send_message?"),
      makeMcpRequest("Run mcp_ct-mcp_datadog_create_datadog_notebook?"),
      makeMcpRequest("Run mcp_ct-mcp_datadog_execute_code?"),
      makeMcpRequest("Run mcp_ct-mcp_datadog_analyze_datadog_logs", {
        CommandLine: "rm -rf /",
      }),
    ]) {
      expect(isCtStudioSafeReadOnlyAcpRequest(policy, mutatingMcp, CT_STUDIO_OPTIONS)).toBe(false);
    }
  });
});

describe("isCtStudioSafeReadOnlyClaudeTool & MCP helper", () => {
  it("handles Claude Bash and mcp__server__tool checks", () => {
    const policy = { runtimeMode: "approval-required" as const, cwd: "/fake/ct-studio" };
    expect(
      isCtStudioSafeReadOnlyClaudeTool(
        policy,
        "Bash",
        {
          command: `node .agents/skills/query-dw/scripts/cli.mjs tables --env prod --project p --dataset d`,
        },
        CT_STUDIO_OPTIONS,
      ),
    ).toBe(true);
    expect(
      isCtStudioSafeReadOnlyClaudeTool(
        policy,
        "Bash",
        { command: `rm -rf /tmp/foo` },
        CT_STUDIO_OPTIONS,
      ),
    ).toBe(false);
    expect(
      isCtStudioSafeReadOnlyClaudeTool(
        policy,
        "mcp__ct-mcp_datadog__search_datadog_logs",
        {},
        CT_STUDIO_OPTIONS,
      ),
    ).toBe(true);
    expect(
      isCtStudioSafeReadOnlyClaudeTool(
        policy,
        "mcp__ct-mcp_slack__slack_send_message",
        {},
        CT_STUDIO_OPTIONS,
      ),
    ).toBe(false);
    expect(isSafeCtStudioReadOnlyMcpTool("atlassian", "getJiraIssue")).toBe(true);
    expect(isSafeCtStudioReadOnlyMcpTool("atlassian", "createJiraIssue")).toBe(false);
  });
});
