import type { ModelSelection } from "@t3tools/contracts";

import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

export type SlackRelayReplyMode = "auto" | "draft";
export type SlackRelaySessionScope = "thread" | "channel" | "channel-daily";
export type SlackRelayRuntimeMode = "approval-required" | "full-access";
export type SlackRelayConnectionState = "disabled" | "connecting" | "connected" | "error";

export interface SlackRelayPublicConfig {
  readonly enabled: boolean;
  readonly workerWsUrl: string;
  readonly hasRelaySecret: boolean;
  readonly relaySecretPreview: string;
  readonly myUserId: string;
  readonly hasUserToken: boolean;
  readonly userTokenPreview: string;
  readonly hasBotToken: boolean;
  readonly botTokenPreview: string;
  readonly replyMode: SlackRelayReplyMode;
  readonly replyPrefix: string;
  readonly sessionScope: SlackRelaySessionScope;
  readonly channelSessionScopes: Readonly<Record<string, SlackRelaySessionScope>>;
  readonly allowSelfMention: boolean;
  readonly requireBotMention: boolean;
  readonly triggerKeywords: ReadonlyArray<string>;
  readonly replayOfflineEvents: boolean;
  readonly addReactions: boolean;
  readonly allowedChannels: ReadonlyArray<string>;
  readonly allowedUsers: ReadonlyArray<string>;
  readonly projectId: string;
  readonly groupName: string;
  readonly runtimeMode: SlackRelayRuntimeMode;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly modelOptions: ModelSelection["options"] | null;
  readonly customPrompt: string;
  readonly promptFilePath: string;
}

export interface SlackRelayConfigPatch {
  readonly enabled?: boolean;
  readonly workerWsUrl?: string;
  readonly relaySecret?: string;
  readonly clearRelaySecret?: boolean;
  readonly myUserId?: string;
  readonly userToken?: string;
  readonly clearUserToken?: boolean;
  readonly botToken?: string;
  readonly clearBotToken?: boolean;
  readonly replyMode?: SlackRelayReplyMode;
  readonly replyPrefix?: string;
  readonly sessionScope?: SlackRelaySessionScope;
  readonly channelSessionScopes?: Readonly<Record<string, SlackRelaySessionScope>>;
  readonly allowSelfMention?: boolean;
  readonly requireBotMention?: boolean;
  readonly triggerKeywords?: ReadonlyArray<string>;
  readonly replayOfflineEvents?: boolean;
  readonly addReactions?: boolean;
  readonly allowedChannels?: ReadonlyArray<string>;
  readonly allowedUsers?: ReadonlyArray<string>;
  readonly projectId?: string;
  readonly groupName?: string;
  readonly runtimeMode?: SlackRelayRuntimeMode;
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly modelOptions?: ModelSelection["options"] | null;
  readonly customPrompt?: string;
  readonly promptFilePath?: string;
}

export interface SlackRelayStatus {
  readonly state: SlackRelayConnectionState;
  readonly lastConnectedAt: string | null;
  readonly lastEventAt: string | null;
  readonly lastError: string | null;
  readonly mappedThreads: number;
}

export interface SlackRelayPendingDraft {
  readonly id: string;
  readonly createdAt: string;
  readonly channel: string;
  readonly channelName?: string | null;
  readonly ts: string;
  readonly threadTs: string;
  readonly t3ThreadId: string | null;
  readonly senderUserId: string | null;
  readonly senderName?: string | null;
  readonly originalText: string;
  readonly replyText: string;
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

const ROUTE_PREFIX = "/api/ct-studio/slack-relay";

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }
  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

async function requestSlackRelay<T>(
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<T> {
  const url = resolvePrimaryEnvironmentHttpUrl(`${ROUTE_PREFIX}${path}`);
  const headers: Record<string, string> = {};
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let credentials: RequestCredentials = "omit";
  if (isSameOriginBrowserPrimary()) {
    credentials = "include";
  } else {
    const token = await readDesktopPrimaryBearerToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    credentials,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

export function fetchSlackRelaySnapshot(options?: {
  readonly lite?: boolean;
}): Promise<SlackRelaySnapshot> {
  return requestSlackRelay<SlackRelaySnapshot>(options?.lite ? "?lite=1" : "");
}

export function updateSlackRelayConfig(patch: SlackRelayConfigPatch): Promise<SlackRelaySnapshot> {
  // Desktop renderer sends cross-origin requests; server CORS only permits GET, POST, and OPTIONS.
  return requestSlackRelay<SlackRelaySnapshot>("/config", { method: "POST", body: patch });
}

export function reconnectSlackRelay(): Promise<SlackRelaySnapshot> {
  return requestSlackRelay<SlackRelaySnapshot>("/reconnect", { method: "POST" });
}

export function sendSlackRelayDraft(id: string, text?: string): Promise<SlackRelaySnapshot> {
  return requestSlackRelay<SlackRelaySnapshot>("/drafts/send", {
    method: "POST",
    body: text !== undefined ? { id, text } : { id },
  });
}

export function discardSlackRelayDraft(id: string): Promise<SlackRelaySnapshot> {
  return requestSlackRelay<SlackRelaySnapshot>("/drafts/discard", { method: "POST", body: { id } });
}
