// @effect-diagnostics nodeBuiltinImport:off
import type { RuntimeMode } from "@t3tools/contracts";
import { unknownRecord, type AcpRuntimePolicy } from "@t3tools/provider-acp/server/clientPolicy";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface CtStudioReadOnlyPolicyInput {
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string | null;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}

export interface CtStudioReadOnlyPolicyOptions {
  readonly isCtStudioWorkspace?: (cwd: string) => boolean;
}

const CT_STUDIO_WORKSPACE_MARKERS = [
  ".agents/skills/query-data/scripts/cli.mjs",
  ".agents/skills/query-dw/scripts/cli.mjs",
  ".agents/skills/query-logs/scripts/cli.mjs",
] as const;

const WORKSPACE_CACHE_MAX_ENTRIES = 128;
const workspaceDetectionCache = new Map<string, boolean>();

function isCtStudioWorkspace(cwd: string | null | undefined): boolean {
  if (typeof cwd !== "string") return false;
  const trimmed = cwd.trim();
  if (trimmed.length === 0) return false;
  const normalized = NodePath.resolve(trimmed);
  const cached = workspaceDetectionCache.get(normalized);
  if (cached !== undefined) return cached;

  let detected = false;
  for (const marker of CT_STUDIO_WORKSPACE_MARKERS) {
    try {
      if (NodeFS.statSync(NodePath.join(normalized, marker)).isFile()) {
        detected = true;
        break;
      }
    } catch {
      // ignore missing marker
    }
  }

  if (workspaceDetectionCache.size >= WORKSPACE_CACHE_MAX_ENTRIES) {
    workspaceDetectionCache.clear();
  }
  workspaceDetectionCache.set(normalized, detected);
  return detected;
}

function isPolicyEligibleForReadOnlyAutoAllow(
  policy: CtStudioReadOnlyPolicyInput,
  options?: CtStudioReadOnlyPolicyOptions,
): boolean {
  if (policy.runtimeMode === "full-access") return false;
  if (policy.approvalPolicy !== undefined && policy.approvalPolicy !== "never") {
    return false;
  }
  const sandboxType = unknownRecord(policy.sandboxPolicy)?.type;
  if (
    sandboxType !== undefined &&
    sandboxType !== "dangerFullAccess" &&
    sandboxType !== "externalSandbox"
  ) {
    return false;
  }
  if (!policy.cwd) return false;
  const checkWorkspace = options?.isCtStudioWorkspace ?? isCtStudioWorkspace;
  return checkWorkspace(policy.cwd);
}

const READ_ONLY_NODE_SKILLS: Readonly<Record<string, ReadonlySet<string>>> = {
  ".agents/skills/query-data/scripts/cli.mjs": new Set([
    "profiles",
    "check",
    "mysql",
    "mongo",
    "discover",
    "--help",
    "-h",
  ]),
  ".agents/skills/query-dw/scripts/cli.mjs": new Set([
    "profiles",
    "check",
    "datasets",
    "tables",
    "describe",
    "query",
    "--help",
    "-h",
  ]),
  ".agents/skills/query-logs/scripts/cli.mjs": new Set([
    "profiles",
    "check",
    "search",
    "chain",
    "indices",
    "trace",
    "--help",
    "-h",
  ]),
  ".agents/skills/slack-relay/scripts/cli.mjs": new Set([
    "check",
    "status",
    "pending",
    "channels",
    "users",
    "--help",
    "-h",
  ]),
  ".agents/skills/slack-assist/scripts/cli.mjs": new Set([
    "status",
    "items",
    "can-reply",
    "--help",
    "-h",
  ]),
  ".agents/skills/personal-slack-reply/scripts/format-slack.mjs": new Set([
    "--convert",
    "--check",
    "--help",
    "-h",
  ]),
};

const READ_ONLY_SHELL_SCRIPTS = new Set([
  ".agents/skills/ct-vpn/scripts/check-vpn-status.sh",
  ".agents/skills/ct-vpn/scripts/proxy-port.sh",
]);

const READ_ONLY_PYTHON_SKILLS: Readonly<Record<string, ReadonlySet<string>>> = {
  ".agents/skills/link-repo/scripts/repo.py": new Set([
    "list",
    "discover",
    "status",
    "--help",
    "-h",
  ]),
  ".agents/skills/setup/scripts/doctor.py": new Set(["*"]),
};

const SIMPLE_READ_ONLY_BINARIES = new Set([
  "date",
  "pwd",
  "echo",
  "printf",
  "ls",
  "wc",
  "nl",
  "head",
  "tail",
  "sort",
  "uniq",
  "cut",
  "tr",
  "rg",
  "grep",
  "cat",
  "which",
  "jq",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "show",
  "diff",
  "grep",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "describe",
  "merge-base",
  "for-each-ref",
  "cat-file",
  "fetch",
]);

const SAFE_GIT_BRANCH_FLAGS = new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--list",
  "--show-current",
  "--no-color",
  "--color",
]);

const SAFE_STDERR_REDIRECT_TOKENS = new Set(["2>&1", "2>/dev/null"]);

const SENSITIVE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|[/\\])\.env(?:\.[^/\\]*)?$/i,
  /(?:^|[/\\])secrets(?:[/\\]|$)/i,
  /(?:^|[/\\])\.ssh(?:[/\\]|$)/i,
  /(?:^|[/\\])id_(?:rsa|ed25519|ecdsa)/i,
  /(?:^|[/\\])slack-relay\.json$/i,
  /(?:^|[/\\])credentials(?:\.[^/\\]*)?$/i,
  /(?:^|[/\\])\.netrc$/i,
  /(?:^|[/\\])\.aws(?:[/\\]|$)/i,
  /(?:^|[/\\])keychain/i,
];

function normalizeRelativeScriptPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\")) return null;
  const withoutDotPrefix = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  if (withoutDotPrefix.includes("..")) return null;
  return withoutDotPrefix;
}

function hasSensitivePathArg(args: ReadonlyArray<string>): boolean {
  for (const arg of args) {
    const trimmed = arg.trim();
    if (!trimmed) continue;
    for (const pattern of SENSITIVE_PATH_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }
  }
  return false;
}

/**
 * Strip strictly single-quoted heredocs (`<<'TAG'` / `<<-'TAG'`) whose body has no shell expansion.
 * Any unquoted/double-quoted heredoc or unclosed heredoc causes rejection (`null`).
 */
function stripSafeSingleQuotedHeredocs(command: string): string | null {
  if (!command.includes("<<")) return command;
  const lines = command.split("\n");
  const outLines: Array<string> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const pendingTags: Array<{ readonly tag: string; readonly stripTabs: boolean }> = [];
    let rebuilt = "";
    let inSingle = false;
    let inDouble = false;

    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j]!;
      if (inSingle) {
        rebuilt += ch;
        if (ch === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        rebuilt += ch;
        if (ch === "\\" && j + 1 < line.length) {
          rebuilt += line[j + 1]!;
          j += 1;
        } else if (ch === '"') {
          inDouble = false;
        }
        continue;
      }
      if (ch === "\\" && j + 1 < line.length) {
        rebuilt += ch + line[j + 1]!;
        j += 1;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        rebuilt += ch;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        rebuilt += ch;
        continue;
      }
      if (ch === "<" && line[j + 1] === "<") {
        // Reject here-strings (`<<<`) and any non-single-quoted heredoc (`<<EOF`, `<<"EOF"`).
        const rest = line.slice(j);
        const match = /^<<(-?)\s*'([A-Za-z0-9_-]+)'/.exec(rest);
        if (!match || !match[2]) {
          return null;
        }
        pendingTags.push({ tag: match[2], stripTabs: match[1] === "-" });
        rebuilt += " ";
        j += match[0].length - 1;
        continue;
      }
      rebuilt += ch;
    }

    outLines.push(rebuilt);

    for (const pending of pendingTags) {
      let closed = false;
      while (i + 1 < lines.length) {
        i += 1;
        const candidate = lines[i] ?? "";
        const normalizedCandidate = pending.stripTabs ? candidate.replace(/^\t+/, "") : candidate;
        if (normalizedCandidate === pending.tag) {
          closed = true;
          break;
        }
      }
      if (!closed) return null;
    }
  }

  return outLines.join("\n");
}

/**
 * Lex a shell command into segments separated by `&&`, `||`, `;`, `|`, or `\n`.
 * Rejects command substitution, process substitution, subshells, backgrounding,
 * unclosed quotes, and file redirections (other than literal `2>&1` and `2>/dev/null`).
 */
function parseSafeShellSegments(rawCommand: string): ReadonlyArray<ReadonlyArray<string>> | null {
  const normalized = rawCommand.replace(/\r\n/g, "\n").trim();
  if (!normalized || normalized.includes("\r")) return null;

  const withoutHeredocs = stripSafeSingleQuotedHeredocs(normalized);
  if (withoutHeredocs === null) return null;

  const segments: Array<Array<string>> = [];
  let currentSegment: Array<string> = [];
  let currentToken = "";
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;

  const flushToken = () => {
    if (hasToken) {
      currentSegment.push(currentToken);
      currentToken = "";
      hasToken = false;
    }
  };

  const flushSegment = () => {
    flushToken();
    if (currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [];
    }
  };

  for (let i = 0; i < withoutHeredocs.length; i += 1) {
    const ch = withoutHeredocs[i]!;
    const next = withoutHeredocs[i + 1];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        currentToken += ch;
        hasToken = true;
      }
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && next !== undefined) {
        // Keep escaped characters literal inside double quotes
        currentToken += next;
        hasToken = true;
        i += 1;
        continue;
      }
      if (ch === "`" || (ch === "$" && next === "(")) {
        return null;
      }
      if (ch === '"') {
        inDouble = false;
      } else {
        currentToken += ch;
        hasToken = true;
      }
      continue;
    }

    // Outside quotes
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      if (next === "\n") {
        // Line continuation
        i += 1;
        continue;
      }
      currentToken += next;
      hasToken = true;
      i += 1;
      continue;
    }

    // Reject command/process substitution, subshells, brace groups
    if (ch === "`" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      return null;
    }
    if (ch === "$" && next === "(") {
      return null;
    }

    // Allow only exact safe stderr redirections (`2>&1`, `2>/dev/null`) as standalone tokens
    if (!hasToken && ch === "2" && next === ">") {
      if (withoutHeredocs.startsWith("2>&1", i)) {
        const after = withoutHeredocs[i + 4];
        if (after === undefined || /[\s;|&]/.test(after)) {
          currentSegment.push("2>&1");
          i += 3;
          continue;
        }
      }
      if (withoutHeredocs.startsWith("2>/dev/null", i)) {
        const after = withoutHeredocs[i + 11];
        if (after === undefined || /[\s;|&]/.test(after)) {
          currentSegment.push("2>/dev/null");
          i += 10;
          continue;
        }
      }
      return null;
    }

    // Reject any other redirections
    if (ch === ">" || ch === "<") {
      return null;
    }

    // Command separators: &&, ||, |, ;, \n
    if (ch === "&") {
      if (next === "&") {
        flushSegment();
        i += 1;
        continue;
      }
      // Single `&` (backgrounding) is disallowed
      return null;
    }
    if (ch === "|") {
      flushSegment();
      if (next === "|") {
        i += 1;
      }
      continue;
    }
    if (ch === ";" || ch === "\n") {
      flushSegment();
      continue;
    }

    if (ch === " " || ch === "\t") {
      flushToken();
      continue;
    }

    currentToken += ch;
    hasToken = true;
  }

  if (inSingle || inDouble) return null;
  flushSegment();
  return segments.length > 0 ? segments : null;
}

function isSafeSedSegment(args: ReadonlyArray<string>): boolean {
  if (hasSensitivePathArg(args)) return false;
  let hasQuietPrintFlag = false;
  for (const arg of args) {
    if (
      arg === "-i" ||
      arg.startsWith("-i") ||
      arg === "--in-place" ||
      arg.startsWith("--in-place=")
    ) {
      return false;
    }
    if (arg === "-f" || arg === "--file" || arg.startsWith("--file=")) {
      return false;
    }
    if (arg === "-n" || arg === "--quiet" || arg === "--silent") {
      hasQuietPrintFlag = true;
    }
  }
  if (!hasQuietPrintFlag) return false;
  // Disallow sed write commands (`w` / `W`) or execute (`e`) in expressions
  const nonFlagArgs = args.filter((a) => !a.startsWith("-"));
  if (nonFlagArgs.length === 0) return false;
  const scriptExpr = nonFlagArgs[0] ?? "";
  return /^[0-9$,\s;p!=q]+$/.test(scriptExpr);
}

function isSafeGitSegment(args: ReadonlyArray<string>): boolean {
  if (args.length === 0) return false;
  let idx = 0;

  while (idx < args.length) {
    const token = args[idx]!;
    if (token === "-C") {
      const dir = args[idx + 1];
      if (!dir || dir.includes("..") || hasSensitivePathArg([dir])) return false;
      idx += 2;
      continue;
    }
    if (token === "--no-pager") {
      idx += 1;
      continue;
    }
    // Reject arbitrary git global flags like `-c core.sshCommand=...` or `--git-dir=...`
    if (token.startsWith("-")) return false;
    break;
  }

  const subcommand = args[idx];
  if (!subcommand) return false;
  const rest = args.slice(idx + 1);
  if (hasSensitivePathArg(rest)) return false;

  if (subcommand === "branch") {
    return rest.every((token) => SAFE_GIT_BRANCH_FLAGS.has(token));
  }

  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;

  // Guard against `git diff --output=...` or `git show --output=...` writing files
  for (const token of rest) {
    if (token === "--output" || token.startsWith("--output=")) return false;
  }
  return true;
}

function isSafeNodeSkillSegment(args: ReadonlyArray<string>): boolean {
  const scriptArg = args[0];
  if (!scriptArg || scriptArg.startsWith("-")) return false;
  const normalizedScript = normalizeRelativeScriptPath(scriptArg);
  if (!normalizedScript) return false;

  const allowedSubcommands = READ_ONLY_NODE_SKILLS[normalizedScript];
  if (!allowedSubcommands) return false;

  const rest = args.slice(1);
  if (normalizedScript === ".agents/skills/personal-slack-reply/scripts/format-slack.mjs") {
    // Disallow reading arbitrary sensitive files via --file
    if (hasSensitivePathArg(rest)) return false;
    return rest.every(
      (token, index) =>
        allowedSubcommands.has(token) ||
        token === "--file" ||
        token.startsWith("--file=") ||
        rest[index - 1] === "--file",
    );
  }

  const subcommand = rest[0];
  if (!subcommand || !allowedSubcommands.has(subcommand)) return false;

  // Raising BigQuery scan cost ceiling requires explicit user confirmation.
  if (normalizedScript === ".agents/skills/query-dw/scripts/cli.mjs") {
    for (const token of rest) {
      if (token === "--max-gb" || token.startsWith("--max-gb=")) return false;
    }
  }

  return true;
}

function isSafePythonSkillSegment(args: ReadonlyArray<string>): boolean {
  const scriptArg = args[0];
  if (!scriptArg || scriptArg.startsWith("-")) return false;
  const normalizedScript = normalizeRelativeScriptPath(scriptArg);
  if (!normalizedScript) return false;

  const rest = args.slice(1);
  if (normalizedScript === ".agents/skills/setup/scripts/steps.py") {
    if (rest[0] === "update" && rest.length === 2 && rest[1] === "--hook") return true;
    if (rest[0] === "whats-new" && (rest[1] === "list" || rest[1] === "check")) return true;
    return false;
  }

  const allowedSubcommands = READ_ONLY_PYTHON_SKILLS[normalizedScript];
  if (!allowedSubcommands) return false;
  if (allowedSubcommands.has("*")) return true;

  // Support optional `--target repos|hosts` before subcommand in link-repo/repo.py
  let subIdx = 0;
  while (subIdx < rest.length && rest[subIdx]?.startsWith("--")) {
    const flag = rest[subIdx]!;
    if (flag === "--target") {
      subIdx += 2;
      continue;
    }
    if (flag.startsWith("--target=")) {
      subIdx += 1;
      continue;
    }
    break;
  }
  const subcommand = rest[subIdx];
  return subcommand !== undefined && allowedSubcommands.has(subcommand);
}

function isSafeReadOnlySegment(rawTokens: ReadonlyArray<string>): boolean {
  const tokens = rawTokens.filter((token) => !SAFE_STDERR_REDIRECT_TOKENS.has(token));
  if (tokens.length === 0) return false;

  const cmd = tokens[0]!;
  // Reject inline env assignments (`NODE_OPTIONS=... node ...`)
  if (cmd.includes("=")) return false;
  const args = tokens.slice(1);

  if (cmd === "node") {
    return isSafeNodeSkillSegment(args);
  }

  if (cmd === "python3" || cmd === "python") {
    return isSafePythonSkillSegment(args);
  }

  if (cmd === "bash" || cmd === "sh") {
    const scriptArg = args[0];
    if (!scriptArg || scriptArg.startsWith("-")) return false;
    const normalized = normalizeRelativeScriptPath(scriptArg);
    return normalized !== null && READ_ONLY_SHELL_SCRIPTS.has(normalized);
  }

  const normalizedDirectScript = normalizeRelativeScriptPath(cmd);
  if (normalizedDirectScript !== null && READ_ONLY_SHELL_SCRIPTS.has(normalizedDirectScript)) {
    return true;
  }

  if (cmd === "git") {
    return isSafeGitSegment(args);
  }

  if (cmd === "sed") {
    return isSafeSedSegment(args);
  }

  if (SIMPLE_READ_ONLY_BINARIES.has(cmd)) {
    if (cmd === "jq" && args.some((a) => a === "-i" || a === "--in-place")) return false;
    return !hasSensitivePathArg(args);
  }

  return false;
}

export function isSafeCtStudioReadOnlyCommand(command: string): boolean {
  const segments = parseSafeShellSegments(command);
  if (segments === null) return false;
  return segments.every(isSafeReadOnlySegment);
}

const READ_ONLY_DATADOG_TOOLS = new Set([
  "aggregate_events",
  "aggregate_rum_events",
  "aggregate_spans",
  "analyze_datadog_logs",
  "ask_widget_expert",
  "get_change_stories",
  "get_datadog_dashboard",
  "get_datadog_incident",
  "get_datadog_metric",
  "get_datadog_metric_context",
  "get_datadog_notebook",
  "get_datadog_trace",
  "get_widget_reference",
  "list_datadog_skills",
  "load_datadog_skill",
  "search_datadog_dashboards",
  "search_datadog_entities",
  "search_datadog_events",
  "search_datadog_hosts",
  "search_datadog_incidents",
  "search_datadog_logs",
  "search_datadog_metrics",
  "search_datadog_monitors",
  "search_datadog_notebooks",
  "search_datadog_rum_events",
  "search_datadog_sdk",
  "search_datadog_spans",
]);

const READ_ONLY_SLACK_MCP_TOOLS = new Set([
  "slack_get_reactions",
  "slack_list_channel_members",
  "slack_list_user_channels",
  "slack_read_canvas",
  "slack_read_channel",
  "slack_read_file",
  "slack_read_list",
  "slack_read_list_comments",
  "slack_read_thread",
  "slack_read_user_profile",
  "slack_search_channels",
  "slack_search_emojis",
  "slack_search_public",
  "slack_search_public_and_private",
  "slack_search_users",
]);

const READ_ONLY_T3_CODE_TOOLS = new Set([
  "ci_logs",
  "ct_slack_list",
  "list_issues",
  "list_scheduled_tasks",
  "list_thread_issues",
  "list_thread_pull_requests",
  "orchestrator_capabilities",
  "pull_request_list",
  "pull_request_read",
  "read_issue",
  "read_pull_request_guide",
  "t3_environment_read",
  "t3_project_list",
  "t3_project_read",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_search",
  "t3_worktree_list",
  "t3_worktree_status",
]);

const READ_ONLY_ATLASSIAN_PREFIX = /^(?:get|search|list|fetch|lookup|read)[A-Z_]/;

export function isSafeCtStudioReadOnlyMcpTool(serverName: string, toolName: string): boolean {
  const server = serverName.trim().toLowerCase();
  const tool = toolName.trim();
  if (!server || !tool) return false;

  if (server === "ct-mcp_datadog" || server === "datadog") {
    return READ_ONLY_DATADOG_TOOLS.has(tool);
  }
  if (server === "ct-mcp_slack" || server === "slack") {
    return READ_ONLY_SLACK_MCP_TOOLS.has(tool);
  }
  if (server === "t3-code") {
    return READ_ONLY_T3_CODE_TOOLS.has(tool);
  }
  if (server === "atlassian" || server === "ct-mcp_atlassian") {
    return READ_ONLY_ATLASSIAN_PREFIX.test(tool);
  }
  return false;
}

const ANTIGRAVITY_DIRECT_MCP_TITLE =
  /^Run mcp_(?<server>ct-mcp_datadog|ct-mcp_slack|ct-mcp_atlassian|datadog|slack|atlassian|t3-code)_(?<tool>[A-Za-z0-9_]+)\??$/;
const ANTIGRAVITY_PROXIED_MCP_TITLE = /^MCP Tool (?<tool>[A-Za-z0-9_]+)\??$/;
const CLAUDE_MCP_TOOL_NAME = /^mcp__(?<server>[A-Za-z0-9_-]+)__(?<tool>[A-Za-z0-9_]+)$/;

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const parts: Array<string> = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      parts.push(entry.trim());
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractAcpCommandLine(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const rawInput = unknownRecord(request.toolCall.rawInput);
  if (rawInput !== undefined) {
    const fromCommandLine = normalizeCommandValue(rawInput.CommandLine);
    if (fromCommandLine) return fromCommandLine;
    const fromCommand = normalizeCommandValue(rawInput.command);
    if (fromCommand) return fromCommand;
    const executable = typeof rawInput.executable === "string" ? rawInput.executable.trim() : "";
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) return `${executable} ${args}`;
    if (executable) return executable;
  }
  if (request.toolCall.kind === "execute" && typeof request.toolCall.title === "string") {
    const match = /`([^`]+)`/.exec(request.toolCall.title);
    return match?.[1]?.trim() || undefined;
  }
  return undefined;
}

function isSafeCtStudioReadOnlyAcpMcpRequest(
  request: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  const title = request.toolCall.title?.trim() ?? "";
  const rawInput = unknownRecord(request.toolCall.rawInput);
  const proxiedTool = ANTIGRAVITY_PROXIED_MCP_TITLE.exec(title)?.groups?.tool;
  if (proxiedTool !== undefined) {
    return (
      typeof rawInput?.ServerName === "string" &&
      rawInput.ToolName === proxiedTool &&
      isSafeCtStudioReadOnlyMcpTool(rawInput.ServerName, proxiedTool)
    );
  }
  if (typeof rawInput?.CommandLine === "string") return false;
  const direct = ANTIGRAVITY_DIRECT_MCP_TITLE.exec(title)?.groups;
  if (!direct?.server || !direct.tool) return false;
  return isSafeCtStudioReadOnlyMcpTool(direct.server, direct.tool);
}

/**
 * Allows verified CT Studio read-only data/log/code inspection commands and read-only MCP calls
 * in `approval-required` / `auto-accept-edits` / `auto` modes without requiring `full-access`.
 */
export function isCtStudioSafeReadOnlyAcpRequest(
  policy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
  options?: CtStudioReadOnlyPolicyOptions,
): boolean {
  if (!isPolicyEligibleForReadOnlyAutoAllow(policy, options)) {
    return false;
  }
  if (isSafeCtStudioReadOnlyAcpMcpRequest(request)) {
    return true;
  }
  if (request.toolCall.kind !== "execute") {
    return false;
  }
  const command = extractAcpCommandLine(request);
  if (!command) return false;
  return isSafeCtStudioReadOnlyCommand(command);
}

export function isCtStudioSafeReadOnlyClaudeTool(
  policy: CtStudioReadOnlyPolicyInput,
  toolName: string,
  toolInput: unknown,
  options?: CtStudioReadOnlyPolicyOptions,
): boolean {
  if (!isPolicyEligibleForReadOnlyAutoAllow(policy, options)) {
    return false;
  }
  if (toolName === "Bash") {
    const input = unknownRecord(toolInput);
    const command = typeof input?.command === "string" ? input.command : "";
    return command.length > 0 && isSafeCtStudioReadOnlyCommand(command);
  }
  const mcp = CLAUDE_MCP_TOOL_NAME.exec(toolName)?.groups;
  if (mcp?.server && mcp.tool) {
    return isSafeCtStudioReadOnlyMcpTool(mcp.server, mcp.tool);
  }
  return false;
}
