import {
  ChatAttachmentId,
  CommandId,
  isProviderSendTurnSupportedImageMimeType,
  MessageId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderInstanceId,
  ThreadId,
  toThreadGroupTag,
  type ChatAttachment,
  type ChatImageAttachment,
  type ModelSelection,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  buildSlackRelayPrompt,
  DEFAULT_SLACK_RELAY_CONFIG,
  formatSlackReplyText,
  formatSlackThreadTitle,
  isSlackNoReplyResponse,
  isTrustedSlackFileUrl,
  mergeSlackRelayConfigPatch,
  normalizeSlackRelayConfig,
  parseSlackMessageUrl,
  selectSlackImagesToDownload,
  selectSlackThreadHistoryForTurn,
  shouldProcessSlackRelayEvent,
  toPublicSlackRelayConfig,
  type SlackImageCandidate,
  type SlackRelayConfig,
  type SlackRelayConfigPatch,
  type SlackRelayConnectionState,
  type SlackRelayFile,
  type SlackRelayMentionPayload,
  type SlackRelayPendingDraft,
  type SlackRelayPublicConfig,
  type SlackRelayStatus,
  type SlackThreadHistoryCursor,
  type SlackThreadHistoryItem,
  type SlackThreadHistorySelection,
  type SlackThreadRootAnchor,
} from "./slackRelayCore.ts";

export class SlackRelayError extends Schema.TaggedError<SlackRelayError>()("SlackRelayError", {
  message: Schema.String,
}) {}

interface SlackRelayPersistedState {
  processed: string[];
  seenThreads: string[];
  threadCursors: Record<string, SlackThreadHistoryCursor>;
  threads: Record<string, { readonly threadId: string; readonly projectId: string }>;
  pending: SlackRelayPendingDraft[];
}

export interface SlackRelayProjectOption {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface SlackRelaySkillOption {
  readonly name: string;
  readonly path: string;
}

export interface SlackRelaySnapshot {
  readonly config: SlackRelayPublicConfig;
  readonly status: SlackRelayStatus;
  readonly pending: ReadonlyArray<SlackRelayPendingDraft>;
  readonly projects: ReadonlyArray<SlackRelayProjectOption>;
  readonly skills: ReadonlyArray<SlackRelaySkillOption>;
}

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);
const RUN_POLL_INTERVAL_MS = 1000;
const RUN_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const SLACK_IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;

async function fetchSlackBinaryWithRedirects(
  initialUrl: string,
  token: string,
  maxRedirects = 5,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const headers: Record<string, string> = isTrustedSlackFileUrl(currentUrl)
      ? { Authorization: `Bearer ${token}` }
      : {};
    const controller = new AbortController();
    // @effect-diagnostics-next-line globalTimers:off -- abort timeout for manual redirect fetch.
    const timer = setTimeout(() => controller.abort(), SLACK_IMAGE_DOWNLOAD_TIMEOUT_MS);
    let res: Response;
    try {
      // @effect-diagnostics-next-line globalFetch:off -- manual redirect hop helper outside Effect.
      res = await fetch(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`HTTP ${res.status} 缺少 Location`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error("重定向次数过多");
}

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeStringifyJson(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function safeSendWs(ws: WebSocket | null, message: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(message);
  } catch {
    // ignore
  }
}

export interface SlackWorkspaceIdentity {
  readonly team: string | null;
  readonly teamId: string | null;
  readonly url: string | null;
  readonly user: string | null;
  readonly userId: string | null;
}

export interface SlackChannelSummary {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isMember: boolean;
}

export interface SlackUserSummary {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly realName: string;
  readonly isBot: boolean;
}

export interface SlackPostMessageInput {
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string | undefined;
  readonly asBot?: boolean | undefined;
  readonly withPrefix?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface SlackPostMessageResult {
  readonly dryRun: boolean;
  readonly workspace: SlackWorkspaceIdentity | null;
  readonly as: "user" | "bot";
  readonly channelId: string;
  readonly channelName: string | null;
  readonly ts: string | null;
  readonly threadTs: string | null;
  readonly text: string;
}

export interface SlackRelaySnapshotOptions {
  readonly includeDiscovery?: boolean;
}

export interface SlackRelayServiceShape {
  readonly getSnapshot: (options?: SlackRelaySnapshotOptions) => Effect.Effect<SlackRelaySnapshot>;
  readonly updateConfig: (patch: SlackRelayConfigPatch) => Effect.Effect<SlackRelaySnapshot>;
  readonly reconnect: () => Effect.Effect<SlackRelaySnapshot>;
  readonly sendDraft: (
    draftId: string,
    overrideText?: string,
  ) => Effect.Effect<SlackRelaySnapshot, SlackRelayError>;
  readonly discardDraft: (draftId: string) => Effect.Effect<SlackRelaySnapshot, SlackRelayError>;
  readonly listChannels: (query?: string) => Effect.Effect<
    {
      readonly workspace: SlackWorkspaceIdentity | null;
      readonly channels: ReadonlyArray<SlackChannelSummary>;
    },
    SlackRelayError
  >;
  readonly listUsers: (query?: string) => Effect.Effect<
    {
      readonly workspace: SlackWorkspaceIdentity | null;
      readonly users: ReadonlyArray<SlackUserSummary>;
    },
    SlackRelayError
  >;
  readonly sendSlackMessage: (
    input: SlackPostMessageInput,
  ) => Effect.Effect<SlackPostMessageResult, SlackRelayError>;
}

export class SlackRelayService extends Context.Service<SlackRelayService, SlackRelayServiceShape>()(
  "t3/ctStudio/SlackRelayService",
) {
  static readonly layer = Layer.effect(
    SlackRelayService,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const projectService = yield* ProjectService.ProjectService;
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectionStore = yield* ProjectionStoreV2.ProjectionStoreV2;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;

      const configPath = path.join(serverConfig.baseDir, "userdata", "slack-relay.json");
      const statePath = path.join(serverConfig.baseDir, "userdata", "slack-relay-state.json");

      const readJsonFile = Effect.fn("SlackRelayService.readJsonFile")(function* <T>(
        filePath: string,
        fallback: T,
      ) {
        const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return fallback;
        const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
        if (!raw) return fallback;
        return safeParseJson(raw, fallback);
      });

      const writeJsonAtomic = Effect.fn("SlackRelayService.writeJsonAtomic")(function* (
        filePath: string,
        data: unknown,
      ) {
        const nowMs = yield* Clock.currentTimeMillis;
        yield* fs
          .makeDirectory(path.dirname(filePath), { recursive: true, mode: 0o700 })
          .pipe(Effect.ignore);
        const tmp = `${filePath}.${process.pid}.${nowMs}.tmp`;
        yield* fs
          .writeFileString(tmp, safeStringifyJson(data), { mode: 0o600 })
          .pipe(Effect.andThen(fs.rename(tmp, filePath)), Effect.ignore);
      });

      const slackApiCall = Effect.fn("SlackRelayService.slackApiCall")(function* (
        method: string,
        token: string,
        body?: Record<string, unknown>,
        options?: { readonly isGet?: boolean },
      ) {
        if (!token) {
          return yield* new SlackRelayError({ message: `Slack API ${method} requires a token.` });
        }

        let url = `https://slack.com/api/${method}`;
        let req: HttpClientRequest.HttpClientRequest;
        if (options?.isGet) {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(body ?? {})) {
            if (value !== undefined && value !== null) {
              params.set(key, String(value));
            }
          }
          const qs = params.toString();
          if (qs) url += `?${qs}`;
          req = HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(token));
        } else {
          req = yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.bodyJson(body ?? {}),
            Effect.mapError((err) => new SlackRelayError({ message: String(err) })),
          );
        }

        const response = yield* httpClient
          .execute(req)
          .pipe(
            Effect.mapError(
              (err) =>
                new SlackRelayError({ message: `Slack API ${method} failed: ${String(err)}` }),
            ),
          );
        const json = (yield* response.json.pipe(
          Effect.mapError(
            (err) =>
              new SlackRelayError({ message: `Slack API ${method} invalid JSON: ${String(err)}` }),
          ),
        )) as Record<string, unknown>;
        if (!json.ok) {
          return yield* new SlackRelayError({
            message: `Slack API ${method} failed: ${String(json.error ?? response.status)}`,
          });
        }
        return json;
      });

      let config: SlackRelayConfig = normalizeSlackRelayConfig(
        yield* readJsonFile(configPath, DEFAULT_SLACK_RELAY_CONFIG),
      );
      const loadedState = yield* readJsonFile<Partial<SlackRelayPersistedState>>(statePath, {});
      const state: SlackRelayPersistedState = {
        processed: Array.isArray(loadedState.processed) ? [...loadedState.processed] : [],
        seenThreads: Array.isArray(loadedState.seenThreads) ? [...loadedState.seenThreads] : [],
        threadCursors:
          loadedState.threadCursors &&
          typeof loadedState.threadCursors === "object" &&
          !Array.isArray(loadedState.threadCursors)
            ? { ...loadedState.threadCursors }
            : {},
        threads:
          loadedState.threads &&
          typeof loadedState.threads === "object" &&
          !Array.isArray(loadedState.threads)
            ? { ...loadedState.threads }
            : {},
        pending: Array.isArray(loadedState.pending) ? [...loadedState.pending] : [],
      };

      let connectionState: SlackRelayConnectionState = config.enabled ? "connecting" : "disabled";
      let lastConnectedAt: string | null = null;
      let lastEventAt: string | null = null;
      let lastError: string | null = null;

      let activeSocket: WebSocket | null = null;
      let cleanupActiveSocketListeners: (() => void) | null = null;
      let backoffMs = 1000;
      let stopped = false;

      const mentionQueue = yield* Queue.unbounded<SlackRelayMentionPayload>();
      const reconnectQueue = yield* Queue.unbounded<"connect" | "reconnect_later">();
      const channelNameCache = new Map<string, string>();
      const userNameCache = new Map<string, string>();
      const botUserIdCache = new Map<string, string>();
      const userTokenIdentityCache = new Map<string, SlackWorkspaceIdentity>();

      const resolveUserTokenIdentity = Effect.fn("SlackRelayService.resolveUserTokenIdentity")(
        function* (token: string) {
          if (!token) return null as SlackWorkspaceIdentity | null;
          const cached = userTokenIdentityCache.get(token);
          if (cached !== undefined) return cached;
          const res = yield* slackApiCall("auth.test", token, {}, { isGet: true }).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (!res) return null;
          const identity: SlackWorkspaceIdentity = {
            team: typeof res.team === "string" ? res.team : null,
            teamId: typeof res.team_id === "string" ? res.team_id : null,
            url: typeof res.url === "string" ? res.url : null,
            user: typeof res.user === "string" ? res.user : null,
            userId: typeof res.user_id === "string" ? res.user_id : null,
          };
          userTokenIdentityCache.set(token, identity);
          return identity;
        },
      );

      const verifyUserTokenOwnership = Effect.fn("SlackRelayService.verifyUserTokenOwnership")(
        function* (cfg: SlackRelayConfig) {
          if (!cfg.userToken || !cfg.myUserId) return;
          const identity = yield* resolveUserTokenIdentity(cfg.userToken);
          if (identity?.userId && identity.userId !== cfg.myUserId) {
            return yield* new SlackRelayError({
              message: `User Token (xoxp-...) 属于用户 ${identity.user ?? "unknown"} (${identity.userId})，与 My User ID (${cfg.myUserId}) 不一致！请勿使用他人或 App 安装者的 User Token，请通过团队 OAuth 授权页（/oauth/start）获取属于你自己的 Token。`,
            });
          }
        },
      );

      const resolveBotUserId = Effect.fn("SlackRelayService.resolveBotUserId")(function* (
        cfg: SlackRelayConfig,
      ) {
        const token = cfg.botToken;
        if (!token) return null;
        const cached = botUserIdCache.get(token);
        if (cached !== undefined) return cached;
        const res = yield* slackApiCall("auth.test", token, {}, { isGet: true }).pipe(
          Effect.orElseSucceed(() => null),
        );
        const uid = typeof res?.user_id === "string" ? res.user_id.trim() : "";
        if (!uid) return null;
        botUserIdCache.set(token, uid);
        return uid;
      });

      const resolveChannelName = Effect.fn("SlackRelayService.resolveChannelName")(function* (
        cfg: SlackRelayConfig,
        channelId: string,
      ) {
        const cached = channelNameCache.get(channelId);
        if (cached !== undefined) return cached;
        const token = cfg.botToken || cfg.userToken;
        if (!token) return null;
        const res = yield* slackApiCall(
          "conversations.info",
          token,
          { channel: channelId },
          { isGet: true },
        ).pipe(Effect.orElseSucceed(() => null));
        const channel = res?.channel as { name?: string } | undefined;
        const name = typeof channel?.name === "string" ? channel.name.trim() : "";
        if (!name) return null;
        channelNameCache.set(channelId, name);
        return name;
      });

      const resolveUserName = Effect.fn("SlackRelayService.resolveUserName")(function* (
        cfg: SlackRelayConfig,
        userId: string | null | undefined,
      ) {
        if (!userId) return null;
        const cached = userNameCache.get(userId);
        if (cached !== undefined) return cached;
        const token = cfg.botToken || cfg.userToken;
        if (!token) return null;
        const res = yield* slackApiCall(
          "users.info",
          token,
          { user: userId },
          { isGet: true },
        ).pipe(Effect.orElseSucceed(() => null));
        const user = res?.user as
          | {
              name?: string;
              real_name?: string;
              profile?: { display_name?: string; real_name?: string };
            }
          | undefined;
        const displayName =
          user?.profile?.display_name?.trim() ||
          user?.profile?.real_name?.trim() ||
          user?.real_name?.trim() ||
          user?.name?.trim() ||
          "";
        if (!displayName) return null;
        userNameCache.set(userId, displayName);
        return displayName;
      });

      const loadPromptFile = Effect.fn("SlackRelayService.loadPromptFile")(function* (
        rawPath: string,
        workspaceRoot: string | null,
      ) {
        const trimmed = rawPath.trim();
        if (!trimmed) return null;
        const expanded = yield* expandHomePath(trimmed);
        const resolved = path.isAbsolute(expanded)
          ? expanded
          : workspaceRoot
            ? path.resolve(workspaceRoot, expanded)
            : path.resolve(expanded);

        const info = yield* fs.stat(resolved).pipe(Effect.orElseSucceed(() => null));
        if (!info) return null;
        const filePath = info.type === "Directory" ? path.join(resolved, "SKILL.md") : resolved;
        const content = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
        if (!content.trim()) return null;
        return {
          filePath,
          dirPath: path.dirname(filePath),
          content,
        };
      });

      const persistState = Effect.fn("SlackRelayService.persistState")(function* () {
        if (state.processed.length > 500) {
          state.processed = state.processed.slice(-500);
        }
        if (state.seenThreads.length > 500) {
          state.seenThreads = state.seenThreads.slice(-500);
        }
        const cursorEntries = Object.entries(state.threadCursors);
        if (cursorEntries.length > 500) {
          state.threadCursors = Object.fromEntries(cursorEntries.slice(-500));
        }
        const threadEntries = Object.entries(state.threads);
        if (threadEntries.length > 500) {
          state.threads = Object.fromEntries(threadEntries.slice(-500));
        }
        yield* writeJsonAtomic(statePath, state);
      });

      const disconnectSocket = () => {
        if (cleanupActiveSocketListeners) {
          cleanupActiveSocketListeners();
          cleanupActiveSocketListeners = null;
        }
        if (activeSocket) {
          const socket = activeSocket;
          activeSocket = null;
          try {
            socket.close(1000, "reconfigure");
          } catch {
            // ignore close error
          }
        }
      };

      const connectSocket = Effect.fn("SlackRelayService.connectSocket")(function* () {
        disconnectSocket();
        if (stopped || !config.enabled) {
          connectionState = "disabled";
          lastError = null;
          return;
        }
        if (!config.workerWsUrl || !config.relaySecret || !config.myUserId) {
          connectionState = "error";
          lastError = "请完整填写 Worker WS URL、Relay Secret 与 My User ID。";
          return;
        }

        const ownershipCheck = yield* verifyUserTokenOwnership(config).pipe(Effect.result);
        if (ownershipCheck._tag === "Failure") {
          connectionState = "error";
          lastError = ownershipCheck.failure.message;
          return;
        }

        const wsUrl = tryParseUrl(config.workerWsUrl);
        if (!wsUrl) {
          connectionState = "error";
          lastError = "Worker WS URL 格式不正确（应为 wss://...）。";
          return;
        }

        wsUrl.searchParams.set("userId", config.myUserId);
        wsUrl.searchParams.set("token", config.relaySecret);
        if (config.replayOfflineEvents) {
          wsUrl.searchParams.set("replay", "1");
        }

        connectionState = "connecting";
        lastError = null;

        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const ws = new WebSocket(wsUrl.toString());

        const onOpen = () => {
          if (activeSocket !== ws) return;
          backoffMs = 1000;
          connectionState = "connected";
          lastConnectedAt = nowIso;
          lastError = null;
        };

        const onMessage = (event: MessageEvent) => {
          if (activeSocket !== ws) return;
          const raw = String(event.data);
          if (raw === "pong") return;
          try {
            const parsed = JSON.parse(raw) as SlackRelayMentionPayload | { type?: string };
            if (parsed?.type === "slack_mention" && "event" in parsed) {
              Queue.offerUnsafe(mentionQueue, parsed);
            }
          } catch {
            // ignore malformed message
          }
        };

        const onError = () => {
          if (activeSocket !== ws) return;
          connectionState = "error";
          lastError = "WebSocket 连接异常";
        };

        const cleanupListeners = () => {
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("message", onMessage);
          ws.removeEventListener("close", onClose);
          ws.removeEventListener("error", onError);
        };

        const onClose = (event: CloseEvent) => {
          if (activeSocket !== ws) return;
          activeSocket = null;
          if (cleanupActiveSocketListeners === cleanupListeners) {
            cleanupActiveSocketListeners = null;
          }
          cleanupListeners();
          if (stopped || !config.enabled) {
            connectionState = "disabled";
            return;
          }
          connectionState = "error";
          lastError = `连接已断开 (code=${event.code})，准备重连…`;
          Queue.offerUnsafe(reconnectQueue, "reconnect_later");
        };

        activeSocket = ws;
        cleanupActiveSocketListeners = cleanupListeners;

        ws.addEventListener("open", onOpen);
        ws.addEventListener("message", onMessage);
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);
      });

      const tryReaction = Effect.fn("SlackRelayService.tryReaction")(function* (
        action: "add" | "remove",
        cfg: SlackRelayConfig,
        channel: string,
        timestamp: string,
        name: string,
      ) {
        if (!cfg.addReactions) return;
        const token = cfg.botToken || cfg.userToken;
        if (!token) return;
        yield* slackApiCall(`reactions.${action}`, token, { channel, timestamp, name }).pipe(
          Effect.ignore,
        );
      });

      const fetchRawThreadMessages = Effect.fn("SlackRelayService.fetchRawThreadMessages")(
        function* (cfg: SlackRelayConfig, event: SlackRelayMentionPayload["event"]) {
          const token = cfg.botToken || cfg.userToken;
          if (!token || !event.thread_ts) {
            return [] as ReadonlyArray<SlackThreadHistoryItem>;
          }
          const allMessages: Array<SlackThreadHistoryItem> = [];
          let cursor: string | undefined;
          const maxPages = 3;
          for (let page = 0; page < maxPages; page += 1) {
            const res = yield* slackApiCall(
              "conversations.replies",
              token,
              { channel: event.channel, ts: event.thread_ts, limit: 100, cursor },
              { isGet: true },
            ).pipe(Effect.orElseSucceed(() => null));
            if (!res || !Array.isArray(res.messages)) break;
            allMessages.push(
              ...(res.messages as Array<{
                ts?: string;
                user?: string;
                text?: string;
                files?: ReadonlyArray<SlackRelayFile>;
              }>),
            );
            const meta = res.response_metadata as { next_cursor?: string } | undefined;
            const next = typeof meta?.next_cursor === "string" ? meta.next_cursor.trim() : "";
            if (!next) break;
            cursor = next;
          }
          return allMessages;
        },
      );

      const resolveHistorySelectionSenders = Effect.fn(
        "SlackRelayService.resolveHistorySelectionSenders",
      )(function* (cfg: SlackRelayConfig, selection: SlackThreadHistorySelection) {
        const userIds = [
          ...selection.messages.map((item) => item.user),
          selection.rootAnchor?.user,
        ].filter(
          (uid): uid is string => typeof uid === "string" && uid.length > 0 && uid !== "system",
        );
        const uniqueUsers = [...new Set(userIds)];
        yield* Effect.forEach(uniqueUsers, (uid) => resolveUserName(cfg, uid), {
          concurrency: 4,
          discard: true,
        });
        const labelFor = (user: string | undefined): string => {
          if (user === "system") return "system";
          const displayName = user ? userNameCache.get(user) : undefined;
          return displayName ? `${displayName} (${user})` : user || "unknown";
        };
        const messages = selection.messages.map((item): SlackThreadHistoryItem => ({
          ...item,
          senderLabel: labelFor(item.user),
        }));
        const rootAnchor: SlackThreadRootAnchor | null = selection.rootAnchor
          ? {
              ...selection.rootAnchor,
              senderLabel: labelFor(selection.rootAnchor.user),
            }
          : null;
        return {
          ...selection,
          messages,
          rootAnchor,
        };
      });

      const resolveTargetProjectAndModel = Effect.fn(
        "SlackRelayService.resolveTargetProjectAndModel",
      )(function* () {
        const snapshot = yield* projectService.snapshot.pipe(Effect.orElseSucceed(() => null));
        const activeProjects = (snapshot?.projects ?? []).filter(
          (project) => project.deletedAt === null,
        );
        const targetProject =
          (config.projectId
            ? activeProjects.find((project) => project.id === config.projectId)
            : undefined) ?? activeProjects[0];

        if (!targetProject) {
          return yield* new SlackRelayError({
            message: "未找到可用的 CT Code 项目，请先在设置中指定目标项目。",
          });
        }

        const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
        let modelSelection: ModelSelection | null = null;

        if (config.providerInstanceId && config.model) {
          modelSelection = {
            instanceId: ProviderInstanceId.make(config.providerInstanceId),
            model: config.model,
            ...(config.modelOptions && config.modelOptions.length > 0
              ? { options: config.modelOptions }
              : {}),
          };
        } else if (settings) {
          modelSelection =
            resolveProjectSettings(settings, targetProject.id, targetProject).settings
              .defaultModelSelection ?? null;
        }

        if (!modelSelection) {
          const providers = yield* providerRegistry.getProviders.pipe(
            Effect.orElseSucceed(() => []),
          );
          const firstReady = providers.find((p) => p.enabled && p.models.length > 0);
          if (firstReady && firstReady.models[0]) {
            modelSelection = {
              instanceId: firstReady.instanceId,
              model: firstReady.models[0].slug,
            };
          }
        }

        if (!modelSelection) {
          return yield* new SlackRelayError({
            message: "未找到可用的模型配置，请先在 CT Code 中配置默认模型或指定 Provider/Model。",
          });
        }

        return {
          projectId: targetProject.id,
          workspaceRoot: targetProject.workspaceRoot,
          modelSelection,
        };
      });

      const waitForAssistantReply = Effect.fn("SlackRelayService.waitForAssistantReply")(function* (
        threadId: ThreadId,
        runId: string | null,
      ) {
        const startMs = yield* Clock.currentTimeMillis;
        const deadline = startMs + RUN_WAIT_TIMEOUT_MS;
        while ((yield* Clock.currentTimeMillis) < deadline) {
          const records = yield* projectionStore
            .getThreadRecords(threadId, ["runs", "messages"])
            .pipe(Effect.orElseSucceed(() => null));
          if (records) {
            const targetRun = runId
              ? records.runs.find((r) => r.id === runId)
              : records.runs[records.runs.length - 1];
            if (targetRun && TERMINAL_RUN_STATUSES.has(targetRun.status)) {
              if (targetRun.status !== "completed") {
                return yield* new SlackRelayError({
                  message: `Agent 运行未完成（status=${targetRun.status}）。`,
                });
              }
              const assistantMsg = [...records.messages]
                .reverse()
                .find(
                  (m) =>
                    m.role === "assistant" &&
                    (runId === null || m.runId === runId) &&
                    typeof m.text === "string" &&
                    m.text.trim().length > 0,
                );
              return assistantMsg?.text?.trim() ?? "";
            }
          }
          yield* Effect.sleep(Duration.millis(RUN_POLL_INTERVAL_MS));
        }
        return yield* new SlackRelayError({ message: "等待 Agent 回复超时。" });
      });

      const downloadSlackImagesToAttachments = Effect.fn(
        "SlackRelayService.downloadSlackImagesToAttachments",
      )(function* (
        cfg: SlackRelayConfig,
        targetThreadId: ThreadId,
        imageFiles: ReadonlyArray<SlackImageCandidate>,
      ) {
        if (imageFiles.length === 0) {
          return {
            attachments: [] as ReadonlyArray<ChatAttachment>,
            savedPaths: [] as ReadonlyArray<string>,
            notes: [] as ReadonlyArray<string>,
          };
        }
        const token = cfg.botToken || cfg.userToken;
        if (!token) {
          return {
            attachments: [] as ReadonlyArray<ChatAttachment>,
            savedPaths: [] as ReadonlyArray<string>,
            notes: ["消息包含图片附件，但未配置 Bot/User Token，无法下载图片。"],
          };
        }

        yield* fs
          .makeDirectory(serverConfig.attachmentsDir, { recursive: true })
          .pipe(Effect.ignore);

        const attachments: ChatImageAttachment[] = [];
        const savedPaths: string[] = [];
        const notes: string[] = [];

        yield* Effect.forEach(
          imageFiles,
          (img) =>
            Effect.gen(function* () {
              if (img.size !== null && img.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
                notes.push(`图片 ${img.name} 超过 10MB 限制，已跳过下载。`);
                return;
              }
              const downloaded = yield* Effect.tryPromise({
                try: async () => {
                  const res = await fetchSlackBinaryWithRedirects(img.url, token);
                  if (!res.ok) {
                    return { error: `HTTP ${res.status}` } as const;
                  }
                  const rawType = (res.headers.get("content-type") || "")
                    .split(";")[0]
                    ?.trim()
                    .toLowerCase();
                  const normalizedMime = rawType === "image/jpg" ? "image/jpeg" : rawType || "";
                  if (!normalizedMime.startsWith("image/")) {
                    return {
                      error: `返回非图片内容（${normalizedMime || "unknown"}，请确认 Slack App Bot Token Scopes 已添加 files:read）`,
                    } as const;
                  }
                  const finalMime = isProviderSendTurnSupportedImageMimeType(normalizedMime)
                    ? normalizedMime
                    : isProviderSendTurnSupportedImageMimeType(img.mimetype)
                      ? img.mimetype
                      : "";
                  if (!finalMime) {
                    return { error: `暂不支持的图片格式 ${normalizedMime}` } as const;
                  }
                  const bytes = new Uint8Array(await res.arrayBuffer());
                  if (bytes.byteLength === 0) {
                    return { error: "图片内容为空" } as const;
                  }
                  if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
                    return { error: "超过 10MB 限制" } as const;
                  }
                  return { bytes, mimeType: finalMime } as const;
                },
                catch: (err) => (err instanceof Error ? err.message : String(err)),
              }).pipe(Effect.catch((msg) => Effect.succeed({ error: msg } as const)));

              if ("error" in downloaded) {
                notes.push(`图片 ${img.name} 下载失败：${downloaded.error}`);
                return;
              }

              const rawId = createAttachmentId(targetThreadId);
              if (!rawId) {
                notes.push(`图片 ${img.name} 无法生成附件 ID，已跳过。`);
                return;
              }
              const attachment: ChatImageAttachment = {
                type: "image",
                id: ChatAttachmentId.make(rawId),
                name: img.name,
                mimeType: downloaded.mimeType,
                sizeBytes: downloaded.bytes.byteLength,
              };
              const targetPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!targetPath) {
                notes.push(`图片 ${img.name} 附件路径无效，已跳过。`);
                return;
              }
              const written = yield* fs.writeFile(targetPath, downloaded.bytes).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
              if (!written) {
                notes.push(`图片 ${img.name} 写入本地附件目录失败，已跳过。`);
                return;
              }
              attachments.push(attachment);
              savedPaths.push(targetPath);
            }),
          { concurrency: 4, discard: true },
        );

        return { attachments, savedPaths, notes };
      });

      const handleMention = Effect.fn("SlackRelayService.handleMention")(function* (
        payload: SlackRelayMentionPayload,
      ) {
        const currentConfig = config;
        if (stopped || !currentConfig.enabled) {
          return;
        }
        const now = yield* DateTime.now;
        lastEventAt = DateTime.formatIso(now);
        const processedSet = new Set(state.processed);
        const botUserId = currentConfig.requireBotMention
          ? yield* resolveBotUserId(currentConfig)
          : null;
        const check = shouldProcessSlackRelayEvent(payload, currentConfig, processedSet, {
          botUserId,
          now,
        });
        if (!check.ok) {
          return;
        }

        const event = payload.event;
        const replyThreadTs = event.thread_ts || event.ts;
        state.processed.push(check.key);
        yield* persistState();

        yield* tryReaction("add", currentConfig, event.channel, event.ts, "eyes");

        const nowMs = yield* Clock.currentTimeMillis;
        const rawThreadMessages = yield* fetchRawThreadMessages(currentConfig, event);
        const channelName = yield* resolveChannelName(currentConfig, event.channel);
        const senderName = yield* resolveUserName(currentConfig, event.user);
        const mapped = state.threads[check.sessionKey];
        const isReturningThread =
          mapped !== undefined &&
          (check.sessionScope === "thread" ||
            state.seenThreads.includes(`${mapped.threadId}:${check.threadKey}`));

        const mappedWorkspaceRoot = mapped
          ? yield* projectService.getShell(ProjectId.make(mapped.projectId)).pipe(
              Effect.map((opt) => (Option.isSome(opt) ? opt.value.workspaceRoot : null)),
              Effect.orElseSucceed(() => null),
            )
          : null;

        let threadId: ThreadId | null = null;
        let runId: string | null = null;
        let recordedRunCount = 1;

        if (mapped) {
          const existingThreadId = ThreadId.make(mapped.threadId);
          const existingRecords = yield* projectionStore
            .getThreadRecords(existingThreadId, ["runs"])
            .pipe(Effect.orElseSucceed(() => null));
          const currentRunCount = existingRecords ? existingRecords.runs.length : null;
          const existingCursor =
            state.threadCursors[`${existingThreadId}:${check.threadKey}`] ?? null;
          const historySelection = yield* resolveHistorySelectionSenders(
            currentConfig,
            selectSlackThreadHistoryForTurn(rawThreadMessages, event.ts, {
              cursor: existingCursor,
              currentRunCount,
              nowMs,
            }),
          );
          const { selected: followUpImages, omittedCount: followUpOmitted } =
            selectSlackImagesToDownload(event, historySelection.messages, {
              isExistingSession: isReturningThread && historySelection.mode === "full",
            });
          const downloadedFollowUp = yield* downloadSlackImagesToAttachments(
            currentConfig,
            existingThreadId,
            followUpImages,
          );
          const followUpNotes = [
            ...downloadedFollowUp.notes,
            ...(followUpOmitted > 0
              ? [
                  isReturningThread
                    ? `另有 ${followUpOmitted} 张超出数量上限的图片未下载。`
                    : `另有 ${followUpOmitted} 张历史或超出数量上限的图片未下载。`,
                ]
              : []),
          ];
          const promptFile = yield* loadPromptFile(
            currentConfig.promptFilePath,
            mappedWorkspaceRoot,
          );
          const prompt = buildSlackRelayPrompt(payload, {
            channelName,
            senderName,
            threadMessages: historySelection.messages,
            historyMode: historySelection.mode,
            rootAnchor: historySelection.rootAnchor,
            customPrompt: currentConfig.customPrompt,
            promptFile,
            attachedImageNames: downloadedFollowUp.attachments.map((att) => att.name),
            imageNotes: followUpNotes,
            sessionScope: check.sessionScope,
            isReturningThread,
          });
          const sendUuid = yield* randomUuidV4;
          const msgUuid = yield* randomUuidV4;
          const sendRes = yield* threadManagement
            .sendToThread({
              projectId: ProjectId.make(mapped.projectId),
              commandId: CommandId.make(`slack-relay:send:${sendUuid}`),
              threadId: existingThreadId,
              messageId: MessageId.make(`slack-relay:msg:${msgUuid}`),
              text: prompt,
              attachments: downloadedFollowUp.attachments,
              mode: "queue",
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.option);

          if (Option.isSome(sendRes)) {
            threadId = existingThreadId;
            runId = sendRes.value.run?.id ?? null;
            recordedRunCount = (currentRunCount ?? 0) + 1;
          } else {
            yield* Effect.forEach(
              downloadedFollowUp.savedPaths,
              (filePath) => fs.remove(filePath, { force: true }).pipe(Effect.ignore),
              { discard: true },
            );
            delete state.threads[check.sessionKey];
            yield* persistState();
          }
        }

        if (threadId === null) {
          const { projectId, workspaceRoot, modelSelection } =
            yield* resolveTargetProjectAndModel();
          const newThreadId = ThreadId.make(yield* randomUuidV4);
          const historySelection = yield* resolveHistorySelectionSenders(
            currentConfig,
            selectSlackThreadHistoryForTurn(rawThreadMessages, event.ts, { nowMs }),
          );
          const { selected: initialImages, omittedCount: initialOmitted } =
            selectSlackImagesToDownload(event, historySelection.messages, {
              isExistingSession: false,
            });
          const downloadedInitial = yield* downloadSlackImagesToAttachments(
            currentConfig,
            newThreadId,
            initialImages,
          );
          const initialNotes = [
            ...downloadedInitial.notes,
            ...(initialOmitted > 0
              ? [`另有 ${initialOmitted} 张历史或超出数量上限的图片未下载。`]
              : []),
          ];
          const promptFile = yield* loadPromptFile(currentConfig.promptFilePath, workspaceRoot);
          const prompt = buildSlackRelayPrompt(payload, {
            channelName,
            senderName,
            threadMessages: historySelection.messages,
            historyMode: historySelection.mode,
            rootAnchor: historySelection.rootAnchor,
            customPrompt: currentConfig.customPrompt,
            promptFile,
            attachedImageNames: downloadedInitial.attachments.map((att) => att.name),
            imageNotes: initialNotes,
            sessionScope: check.sessionScope,
            isReturningThread: false,
          });
          const title = formatSlackThreadTitle(event, {
            channelName,
            senderName,
            sessionScope: check.sessionScope,
            dateKey: check.dateKey,
          });
          const launchUuid = yield* randomUuidV4;
          const msgUuid = yield* randomUuidV4;
          const commandId = CommandId.make(`slack-relay:launch:${launchUuid}`);
          const launched = yield* threadLaunch.launch({
            commandId,
            threadId: newThreadId,
            projectId,
            title,
            titleRenamed: true,
            modelSelection,
            runtimeMode: currentConfig.runtimeMode,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make(`slack-relay:msg:${msgUuid}`),
              text: prompt,
              attachments: downloadedInitial.attachments,
            },
            createdBy: "user",
            creationSource: "web",
          });

          threadId = launched.threadId;
          runId = launched.projection.runs.at(-1)?.id ?? null;
          recordedRunCount = Math.max(1, launched.projection.runs.length);
          state.threads[check.sessionKey] = { threadId, projectId };
          yield* persistState();

          const groupTag = currentConfig.groupName
            ? toThreadGroupTag(currentConfig.groupName)
            : null;
          if (groupTag !== null) {
            yield* threadManagement
              .dispatch({
                type: "thread.tag.set",
                commandId: CommandId.make(`${commandId}:group`),
                threadId,
                tag: groupTag,
                tagged: true,
              })
              .pipe(Effect.ignore);
          }
        }

        const seenThreadKey = `${threadId}:${check.threadKey}`;
        if (!state.seenThreads.includes(seenThreadKey)) {
          state.seenThreads.push(seenThreadKey);
        }
        const prevOwnReplyTs = state.threadCursors[seenThreadKey]?.ownReplyTs ?? [];
        delete state.threadCursors[seenThreadKey];
        state.threadCursors[seenThreadKey] = {
          lastSeenTs: event.ts,
          lastSeenAtMs: nowMs,
          lastRunCount: recordedRunCount,
          ...(prevOwnReplyTs.length > 0 ? { ownReplyTs: prevOwnReplyTs.slice(-5) } : {}),
        };
        yield* persistState();

        const replyBody = yield* waitForAssistantReply(threadId, runId);
        if (stopped || !config.enabled) {
          yield* tryReaction("remove", currentConfig, event.channel, event.ts, "eyes");
          return;
        }
        if (isSlackNoReplyResponse(replyBody)) {
          yield* tryReaction("remove", currentConfig, event.channel, event.ts, "eyes");
          return;
        }
        const formatted = formatSlackReplyText(replyBody, currentConfig);
        if (!formatted) {
          yield* tryReaction("remove", currentConfig, event.channel, event.ts, "eyes");
          return;
        }

        if (config.replyMode === "auto") {
          if (!config.userToken) {
            return yield* new SlackRelayError({
              message: "未配置 User Token (xoxp-...)，无法自动回复。",
            });
          }
          yield* verifyUserTokenOwnership(config);
          const postRes = yield* slackApiCall("chat.postMessage", config.userToken, {
            channel: event.channel,
            thread_ts: replyThreadTs,
            text: formatted,
          });
          const postedTs = typeof postRes.ts === "string" ? postRes.ts.trim() : "";
          const prevCursor = state.threadCursors[seenThreadKey];
          if (postedTs && prevCursor) {
            const nextOwnReplies = [
              ...(prevCursor.ownReplyTs ?? []).filter((ts) => ts !== postedTs),
              postedTs,
            ].slice(-5);
            delete state.threadCursors[seenThreadKey];
            state.threadCursors[seenThreadKey] = {
              ...prevCursor,
              ownReplyTs: nextOwnReplies,
            };
            yield* persistState();
          }
          yield* tryReaction("remove", config, event.channel, event.ts, "eyes");
          yield* tryReaction("add", config, event.channel, event.ts, "white_check_mark");
        } else {
          const nowIso = DateTime.formatIso(yield* DateTime.now);
          const draftUuid = yield* randomUuidV4;
          state.pending.unshift({
            id: `draft-${draftUuid.slice(0, 8)}`,
            createdAt: nowIso,
            channel: event.channel,
            channelName: channelName ?? null,
            ts: event.ts,
            threadTs: replyThreadTs,
            t3ThreadId: threadId,
            senderUserId: event.user ?? null,
            senderName: senderName ?? null,
            originalText: event.text,
            replyText: formatted,
          });
          yield* persistState();
        }
      });

      const handleMentionSafe = (payload: SlackRelayMentionPayload) =>
        handleMention(payload).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              lastError = String(cause).slice(0, 300);
              yield* Effect.logWarning("SlackRelayService failed to process mention", {
                error: lastError,
              });
              yield* tryReaction("remove", config, payload.event.channel, payload.event.ts, "eyes");
              yield* tryReaction("add", config, payload.event.channel, payload.event.ts, "x");
            }),
          ),
        );

      const mentionFiber = yield* Effect.forkScoped(
        Effect.forever(
          Effect.flatMap(Queue.take(mentionQueue), (payload) => handleMentionSafe(payload)),
        ),
      );

      const pingFiber = yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.seconds(25));
            safeSendWs(activeSocket, "ping");
          }),
        ),
      );

      const reconnectFiber = yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const action = yield* Queue.take(reconnectQueue);
            if (action === "reconnect_later") {
              const delay = backoffMs;
              backoffMs = Math.min(backoffMs * 2, 30_000);
              yield* Effect.sleep(Duration.millis(delay));
            }
            if (!stopped && config.enabled) {
              yield* connectSocket();
            }
          }),
        ),
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          stopped = true;
          disconnectSocket();
          yield* Fiber.interrupt(mentionFiber);
          yield* Fiber.interrupt(pingFiber);
          yield* Fiber.interrupt(reconnectFiber);
        }),
      );

      if (config.enabled) {
        yield* connectSocket();
      }

      const SKILLS_CACHE_TTL_MS = 30_000;
      let cachedSkills: {
        readonly workspaceRoot: string;
        readonly expiresAt: number;
        readonly options: ReadonlyArray<SlackRelaySkillOption>;
      } | null = null;

      const scanProjectSkills = Effect.fn("SlackRelayService.scanProjectSkills")(function* (
        workspaceRoot: string | null,
      ) {
        if (!workspaceRoot) return [] as ReadonlyArray<SlackRelaySkillOption>;
        const now = Date.now();
        if (
          cachedSkills &&
          cachedSkills.workspaceRoot === workspaceRoot &&
          now < cachedSkills.expiresAt
        ) {
          return cachedSkills.options;
        }
        const skillsRoot = path.join(workspaceRoot, ".agents", "skills");
        const exists = yield* fs.exists(skillsRoot).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          cachedSkills = {
            workspaceRoot,
            expiresAt: now + SKILLS_CACHE_TTL_MS,
            options: [],
          };
          return [] as ReadonlyArray<SlackRelaySkillOption>;
        }
        const entries = yield* fs
          .readDirectory(skillsRoot)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        const options: SlackRelaySkillOption[] = [];
        for (const name of [...entries].sort()) {
          if (name.startsWith(".")) continue;
          const skillMd = path.join(skillsRoot, name, "SKILL.md");
          const hasSkillMd = yield* fs.exists(skillMd).pipe(Effect.orElseSucceed(() => false));
          if (hasSkillMd) {
            options.push({ name, path: `.agents/skills/${name}` });
          }
        }
        cachedSkills = {
          workspaceRoot,
          expiresAt: now + SKILLS_CACHE_TTL_MS,
          options,
        };
        return options;
      });

      const buildSnapshot = Effect.fn("SlackRelayService.buildSnapshot")(function* (
        options?: SlackRelaySnapshotOptions,
      ) {
        const includeDiscovery = options?.includeDiscovery !== false;
        let projects: ReadonlyArray<SlackRelayProjectOption> = [];
        let skills: ReadonlyArray<SlackRelaySkillOption> = [];
        if (includeDiscovery) {
          const shells = yield* projectService
            .listShells()
            .pipe(Effect.orElseSucceed(() => [] as const));
          const targetShell =
            (config.projectId ? shells.find((p) => p.id === config.projectId) : undefined) ??
            shells[0];
          skills = yield* scanProjectSkills(targetShell?.workspaceRoot ?? null);
          projects = shells.map((project) => ({
            id: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          }));
        }
        return {
          config: toPublicSlackRelayConfig(config),
          status: {
            state: connectionState,
            lastConnectedAt,
            lastEventAt,
            lastError,
            mappedThreads: Object.keys(state.threads).length,
          },
          pending: [...state.pending],
          projects,
          skills,
        } satisfies SlackRelaySnapshot;
      });

      const getSnapshot = Effect.fn("SlackRelayService.getSnapshot")(function* (
        options?: SlackRelaySnapshotOptions,
      ) {
        return yield* buildSnapshot(options);
      });

      const updateConfig = Effect.fn("SlackRelayService.updateConfig")(function* (
        patch: SlackRelayConfigPatch,
      ) {
        const prev = config;
        config = mergeSlackRelayConfigPatch(config, patch);
        yield* writeJsonAtomic(configPath, config);

        const connectionChanged =
          prev.enabled !== config.enabled ||
          prev.workerWsUrl !== config.workerWsUrl ||
          prev.relaySecret !== config.relaySecret ||
          prev.myUserId !== config.myUserId ||
          prev.userToken !== config.userToken ||
          prev.replayOfflineEvents !== config.replayOfflineEvents;

        if (connectionChanged) {
          yield* connectSocket();
        }
        return yield* buildSnapshot();
      });

      const reconnect = Effect.fn("SlackRelayService.reconnect")(function* () {
        yield* connectSocket();
        return yield* buildSnapshot();
      });

      const sendDraft = Effect.fn("SlackRelayService.sendDraft")(function* (
        draftId: string,
        overrideText?: string,
      ) {
        const idx = state.pending.findIndex((item) => item.id === draftId);
        if (idx === -1) {
          return yield* new SlackRelayError({ message: `未找到草稿：${draftId}` });
        }
        const item = state.pending[idx]!;
        if (!config.userToken) {
          return yield* new SlackRelayError({
            message: "未配置 User Token (xoxp-...)，无法发送。",
          });
        }
        yield* verifyUserTokenOwnership(config);
        const textToSend =
          typeof overrideText === "string" && overrideText.trim().length > 0
            ? overrideText.trim()
            : item.replyText;
        const postRes = yield* slackApiCall("chat.postMessage", config.userToken, {
          channel: item.channel,
          thread_ts: item.threadTs,
          text: textToSend,
        });
        const postedTs = typeof postRes.ts === "string" ? postRes.ts.trim() : "";
        if (postedTs && item.t3ThreadId) {
          const cursorKey = `${item.t3ThreadId}:${item.channel}:${item.threadTs}`;
          const prevCursor = state.threadCursors[cursorKey];
          if (prevCursor) {
            const nextOwnReplies = [
              ...(prevCursor.ownReplyTs ?? []).filter((ts) => ts !== postedTs),
              postedTs,
            ].slice(-5);
            delete state.threadCursors[cursorKey];
            state.threadCursors[cursorKey] = {
              ...prevCursor,
              ownReplyTs: nextOwnReplies,
            };
          }
        }
        yield* tryReaction("remove", config, item.channel, item.ts, "eyes");
        yield* tryReaction("add", config, item.channel, item.ts, "white_check_mark");
        state.pending.splice(idx, 1);
        yield* persistState();
        return yield* buildSnapshot();
      });

      const discardDraft = Effect.fn("SlackRelayService.discardDraft")(function* (draftId: string) {
        const idx = state.pending.findIndex((item) => item.id === draftId);
        if (idx === -1) {
          return yield* new SlackRelayError({ message: `未找到草稿：${draftId}` });
        }
        state.pending.splice(idx, 1);
        yield* persistState();
        return yield* buildSnapshot();
      });

      const fetchWorkspaceIdentity = Effect.fn("SlackRelayService.fetchWorkspaceIdentity")(
        function* (token: string) {
          if (!token) return null as SlackWorkspaceIdentity | null;
          const res = yield* slackApiCall("auth.test", token, {}, { isGet: true }).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (!res) return null;
          return {
            team: typeof res.team === "string" ? res.team : null,
            teamId: typeof res.team_id === "string" ? res.team_id : null,
            url: typeof res.url === "string" ? res.url : null,
            user: typeof res.user === "string" ? res.user : null,
            userId: typeof res.user_id === "string" ? res.user_id : null,
          } satisfies SlackWorkspaceIdentity;
        },
      );

      const listChannelsInternal = Effect.fn("SlackRelayService.listChannelsInternal")(function* (
        token: string,
        query?: string,
      ) {
        const all: Array<{
          id?: string;
          name?: string;
          is_private?: boolean;
          is_member?: boolean;
        }> = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const res = yield* slackApiCall(
            "conversations.list",
            token,
            {
              types: "public_channel,private_channel",
              exclude_archived: true,
              limit: 200,
              cursor,
            },
            { isGet: true },
          );
          if (Array.isArray(res.channels)) {
            all.push(
              ...(res.channels as Array<{
                id?: string;
                name?: string;
                is_private?: boolean;
                is_member?: boolean;
              }>),
            );
          }
          const meta = res.response_metadata as { next_cursor?: string } | undefined;
          const next = typeof meta?.next_cursor === "string" ? meta.next_cursor.trim() : "";
          if (!next) break;
          cursor = next;
        }
        const q = (query ?? "").trim().toLowerCase().replace(/^#/, "");
        return all
          .filter(
            (ch): ch is { id: string; name?: string; is_private?: boolean; is_member?: boolean } =>
              typeof ch.id === "string" && ch.id.length > 0,
          )
          .map((ch): SlackChannelSummary => ({
            id: ch.id,
            name: ch.name ?? "",
            isPrivate: Boolean(ch.is_private),
            isMember: Boolean(ch.is_member),
          }))
          .filter(
            (ch) => !q || ch.name.toLowerCase().includes(q) || ch.id.toLowerCase().includes(q),
          );
      });

      const listChannels = Effect.fn("SlackRelayService.listChannels")(function* (query?: string) {
        const token = config.botToken || config.userToken;
        if (!token) {
          return yield* new SlackRelayError({
            message:
              "未配置 Slack Bot Token 或 User Token，请先在 CT Code 设置 → CT Studio → Slack Relay 中配置。",
          });
        }
        const workspace = yield* fetchWorkspaceIdentity(token);
        const channels = yield* listChannelsInternal(token, query);
        return { workspace, channels };
      });

      const listUsers = Effect.fn("SlackRelayService.listUsers")(function* (query?: string) {
        const token = config.botToken || config.userToken;
        if (!token) {
          return yield* new SlackRelayError({
            message:
              "未配置 Slack Bot Token 或 User Token，请先在 CT Code 设置 → CT Studio → Slack Relay 中配置。",
          });
        }
        const workspace = yield* fetchWorkspaceIdentity(token);
        const all: Array<{
          id?: string;
          name?: string;
          real_name?: string;
          deleted?: boolean;
          is_bot?: boolean;
          profile?: { display_name?: string; real_name?: string };
        }> = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const res = yield* slackApiCall(
            "users.list",
            token,
            { limit: 200, cursor },
            { isGet: true },
          );
          if (Array.isArray(res.members)) {
            all.push(
              ...(res.members as Array<{
                id?: string;
                name?: string;
                real_name?: string;
                deleted?: boolean;
                is_bot?: boolean;
                profile?: { display_name?: string; real_name?: string };
              }>),
            );
          }
          const meta = res.response_metadata as { next_cursor?: string } | undefined;
          const next = typeof meta?.next_cursor === "string" ? meta.next_cursor.trim() : "";
          if (!next) break;
          cursor = next;
        }
        const q = (query ?? "").trim().toLowerCase().replace(/^@/, "");
        const users = all
          .filter(
            (
              u,
            ): u is {
              id: string;
              name?: string;
              real_name?: string;
              deleted?: boolean;
              is_bot?: boolean;
              profile?: { display_name?: string; real_name?: string };
            } => !u.deleted && typeof u.id === "string" && u.id.length > 0,
          )
          .map((u): SlackUserSummary => ({
            id: u.id,
            name: u.name ?? "",
            displayName: u.profile?.display_name ?? "",
            realName: u.profile?.real_name ?? u.real_name ?? "",
            isBot: Boolean(u.is_bot),
          }))
          .filter(
            (u) =>
              !q ||
              u.id.toLowerCase().includes(q) ||
              u.name.toLowerCase().includes(q) ||
              u.displayName.toLowerCase().includes(q) ||
              u.realName.toLowerCase().includes(q),
          );
        return { workspace, users };
      });

      const sendSlackMessage = Effect.fn("SlackRelayService.sendSlackMessage")(function* (
        input: SlackPostMessageInput,
      ) {
        const asBot = Boolean(input.asBot);
        const postToken = asBot ? config.botToken : config.userToken;
        if (!postToken) {
          return yield* new SlackRelayError({
            message: asBot
              ? "未配置 Slack Bot Token (xoxb-...)，请在设置 → CT Studio → Slack Relay 中配置。"
              : "未配置 Slack User Token (xoxp-...)，请在设置 → CT Studio → Slack Relay 中配置。",
          });
        }
        const lookupToken = config.botToken || config.userToken;
        const finalText = input.withPrefix
          ? formatSlackReplyText(input.text, config)
          : input.text.trim();
        if (!finalText) {
          return yield* new SlackRelayError({ message: "消息正文不能为空。" });
        }

        const trimmedTarget = input.channel.trim();
        if (!trimmedTarget) {
          return yield* new SlackRelayError({ message: "目标频道或用户不能为空。" });
        }

        let channelId: string;
        let channelName: string | null = null;
        let threadTsFromUrl: string | null = null;

        const fromUrl = parseSlackMessageUrl(trimmedTarget);
        if (fromUrl) {
          channelId = fromUrl.channelId;
          channelName = yield* resolveChannelName(config, channelId);
          threadTsFromUrl = fromUrl.threadTs;
        } else if (/^[CGD][A-Z0-9]+$/.test(trimmedTarget)) {
          channelId = trimmedTarget;
          channelName = yield* resolveChannelName(config, channelId);
        } else {
          const normalizedUser = trimmedTarget.replace(/^@/, "");
          if (/^U[A-Z0-9]+$/.test(normalizedUser)) {
            const opened = yield* slackApiCall("conversations.open", postToken, {
              users: normalizedUser,
            });
            const openedChannel = opened.channel as { id?: string } | undefined;
            if (!openedChannel?.id) {
              return yield* new SlackRelayError({
                message: `无法打开与用户 ${normalizedUser} 的私信频道（请确认 Token 具备 im:write 权限）。`,
              });
            }
            channelId = openedChannel.id;
            const resolvedName = yield* resolveUserName(config, normalizedUser);
            channelName = `@${resolvedName ?? normalizedUser}`;
          } else {
            const wantedName = trimmedTarget.replace(/^#/, "").toLowerCase();
            const channels = yield* listChannelsInternal(lookupToken, wantedName);
            const exact = channels.find((ch) => ch.name.toLowerCase() === wantedName);
            if (!exact) {
              const suggestions = channels
                .slice(0, 5)
                .map((ch) => `#${ch.name} (${ch.id})`)
                .join(", ");
              return yield* new SlackRelayError({
                message:
                  `未找到频道 #${wantedName}` + (suggestions ? `；相近频道：${suggestions}` : ""),
              });
            }
            channelId = exact.id;
            channelName = exact.name;
          }
        }

        const workspace = yield* fetchWorkspaceIdentity(postToken);
        const resolvedThreadTs = input.threadTs?.trim() || threadTsFromUrl || null;

        if (input.dryRun) {
          return {
            dryRun: true,
            workspace,
            as: asBot ? "bot" : "user",
            channelId,
            channelName,
            ts: null,
            threadTs: resolvedThreadTs,
            text: finalText,
          } satisfies SlackPostMessageResult;
        }

        const res = yield* slackApiCall("chat.postMessage", postToken, {
          channel: channelId,
          ...(resolvedThreadTs ? { thread_ts: resolvedThreadTs } : {}),
          text: finalText,
        });
        return {
          dryRun: false,
          workspace,
          as: asBot ? "bot" : "user",
          channelId,
          channelName,
          ts: typeof res.ts === "string" ? res.ts : null,
          threadTs: resolvedThreadTs,
          text: finalText,
        } satisfies SlackPostMessageResult;
      });

      return {
        getSnapshot,
        updateConfig,
        reconnect,
        sendDraft,
        discardDraft,
        listChannels,
        listUsers,
        sendSlackMessage,
      };
    }),
  );
}
