import { type ModelSelection, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { resolveDefaultModelSettingsPresentation } from "../settings/ProjectDefaultsSettings.logic";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../settings/settingsLayout";
import { useScopedSettings } from "../settings/useScopedSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  fetchSlackRelaySnapshot,
  reconnectSlackRelay,
  updateSlackRelayConfig,
  type SlackRelayReplyMode,
  type SlackRelayRuntimeMode,
  type SlackRelaySnapshot,
} from "./slackRelayClient";

const INPUT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 font-mono text-xs text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:w-72";

const REPLY_MODE_LABELS: Readonly<Record<SlackRelayReplyMode, string>> = {
  draft: msg("Draft only (review before sending)"),
  auto: msg("Auto reply (post directly to thread)"),
};

const RUNTIME_MODE_LABELS: Readonly<Record<SlackRelayRuntimeMode, string>> = {
  "approval-required": msg("Supervised (approval required)"),
  "full-access": msg("Full access (fully automatic)"),
};

const CONNECTION_STATE_LABELS: Readonly<
  Record<
    SlackRelaySnapshot["status"]["state"],
    { readonly variant: "success" | "secondary" | "destructive"; readonly label: string }
  >
> = {
  connected: { variant: "success", label: msg("Connected") },
  connecting: { variant: "secondary", label: msg("Connecting...") },
  error: { variant: "destructive", label: msg("Connection error") },
  disabled: { variant: "secondary", label: msg("Disabled") },
};

function parseCsvList(value: string): ReadonlyArray<string> {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function SlackRelaySettingsSection() {
  const gt = useGT();
  const navigate = useNavigate();
  const m = useMessages();
  const { target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();

  const [snapshot, setSnapshot] = useState<SlackRelaySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [workerWsUrl, setWorkerWsUrl] = useState("");
  const [relaySecret, setRelaySecret] = useState("");
  const [myUserId, setMyUserId] = useState("");
  const [userToken, setUserToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [replyMode, setReplyMode] = useState<SlackRelayReplyMode>("draft");
  const [replyPrefix, setReplyPrefix] = useState("🤖 [AI 代理自动回复]");
  const [runtimeMode, setRuntimeMode] = useState<SlackRelayRuntimeMode>("approval-required");
  const [projectId, setProjectId] = useState("");
  const [groupName, setGroupName] = useState("Slack");
  const [modelOverride, setModelOverride] = useState<ModelSelection | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [promptFilePath, setPromptFilePath] = useState("");
  const [allowSelfMention, setAllowSelfMention] = useState(true);
  const [addReactions, setAddReactions] = useState(true);
  const [replayOfflineEvents, setReplayOfflineEvents] = useState(false);
  const [allowedChannelsText, setAllowedChannelsText] = useState("");
  const [allowedUsersText, setAllowedUsersText] = useState("");

  function applySnapshot(next: SlackRelaySnapshot) {
    setSnapshot(next);
    const c = next.config;
    setEnabled(c.enabled);
    setWorkerWsUrl(c.workerWsUrl);
    setRelaySecret("");
    setMyUserId(c.myUserId);
    setUserToken("");
    setBotToken("");
    setReplyMode(c.replyMode);
    setReplyPrefix(c.replyPrefix);
    setRuntimeMode(c.runtimeMode);
    setProjectId(c.projectId);
    setGroupName(c.groupName);
    setModelOverride(
      c.providerInstanceId && c.model
        ? createModelSelection(
            ProviderInstanceId.make(c.providerInstanceId),
            c.model,
            c.modelOptions ?? undefined,
          )
        : null,
    );
    setCustomPrompt(c.customPrompt);
    setPromptFilePath(c.promptFilePath);
    setAllowSelfMention(c.allowSelfMention);
    setAddReactions(c.addReactions);
    setReplayOfflineEvents(c.replayOfflineEvents);
    setAllowedChannelsText(c.allowedChannels.join(", "));
    setAllowedUsersText(c.allowedUsers.join(", "));
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- initial load from local Slack relay HTTP API
  useEffect(() => {
    let cancelled = false;
    void fetchSlackRelaySnapshot()
      .then((data) => {
        if (cancelled) return;
        const c = data.config;
        setSnapshot(data);
        setEnabled(c.enabled);
        setWorkerWsUrl(c.workerWsUrl);
        setRelaySecret("");
        setMyUserId(c.myUserId);
        setUserToken("");
        setBotToken("");
        setReplyMode(c.replyMode);
        setReplyPrefix(c.replyPrefix);
        setRuntimeMode(c.runtimeMode);
        setProjectId(c.projectId);
        setGroupName(c.groupName);
        setModelOverride(
          c.providerInstanceId && c.model
            ? createModelSelection(
                ProviderInstanceId.make(c.providerInstanceId),
                c.model,
                c.modelOptions ?? undefined,
              )
            : null,
        );
        setCustomPrompt(c.customPrompt);
        setPromptFilePath(c.promptFilePath);
        setAllowSelfMention(c.allowSelfMention);
        setAddReactions(c.addReactions);
        setReplayOfflineEvents(c.replayOfflineEvents);
        setAllowedChannelsText(c.allowedChannels.join(", "));
        setAllowedUsersText(c.allowedUsers.join(", "));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : gt("Failed to load Slack Relay config"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gt]);

  const isRelayEnabled = Boolean(snapshot?.config.enabled);
  const relayConnState = snapshot?.status.state;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- poll live WebSocket status and discovered skills from server
  useEffect(() => {
    if (!isRelayEnabled) return;
    const intervalMs = relayConnState === "connecting" ? 1200 : 5000;
    const timer = window.setInterval(() => {
      void fetchSlackRelaySnapshot()
        .then((next) => {
          setSnapshot((prev) =>
            prev
              ? {
                  ...prev,
                  status: next.status,
                  pending: next.pending,
                  projects: next.projects,
                  skills: next.skills,
                }
              : next,
          );
        })
        .catch(() => {
          // ignore transient poll error
        });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isRelayEnabled, relayConnState]);

  const representative =
    (target ? environments.find((env) => env.environmentId === target.environmentId) : undefined) ??
    environments.find((env) => env.serverConfig !== null) ??
    environments[0];
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const selectedProjectId = projectId ? ProjectId.make(projectId) : null;
  const entries = providerInstanceEntriesFor(providers, scopedSettings, selectedProjectId);
  const defaultPresentation = resolveDefaultModelSettingsPresentation(
    {
      entries,
      providers,
      settings: scopedSettings,
      projectId: selectedProjectId,
    },
    m,
  );
  const shownSelection = modelOverride ?? defaultPresentation.selection;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    scopedSettings,
    providers,
    shownSelection?.instanceId,
    shownSelection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === shownSelection?.instanceId);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await updateSlackRelayConfig({
        enabled,
        workerWsUrl,
        ...(relaySecret.trim() ? { relaySecret: relaySecret.trim() } : {}),
        myUserId,
        ...(userToken.trim() ? { userToken: userToken.trim() } : {}),
        ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
        replyMode,
        replyPrefix,
        runtimeMode,
        projectId,
        groupName,
        providerInstanceId: modelOverride ? modelOverride.instanceId : "",
        model: modelOverride ? modelOverride.model : "",
        modelOptions: modelOverride?.options ? modelOverride.options : null,
        customPrompt,
        promptFilePath,
        allowSelfMention,
        addReactions,
        replayOfflineEvents,
        allowedChannels: parseCsvList(allowedChannelsText),
        allowedUsers: parseCsvList(allowedUsersText),
      });
      applySnapshot(next);
      setNotice(gt("Saved to local ~/.t3-ct/userdata/slack-relay.json."));
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("Failed to save config"));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSwitch = async (
    key: "enabled" | "allowSelfMention" | "addReactions" | "replayOfflineEvents",
    checked: boolean,
  ) => {
    if (key === "enabled") setEnabled(checked);
    else if (key === "allowSelfMention") setAllowSelfMention(checked);
    else if (key === "addReactions") setAddReactions(checked);
    else setReplayOfflineEvents(checked);

    setError(null);
    setNotice(null);
    try {
      const next = await updateSlackRelayConfig({ [key]: checked });
      setSnapshot(next);
      if (key === "enabled") {
        setNotice(checked ? gt("Slack Relay enabled.") : gt("Slack Relay disabled."));
      }
    } catch (err) {
      if (key === "enabled") setEnabled(!checked);
      else if (key === "allowSelfMention") setAllowSelfMention(!checked);
      else if (key === "addReactions") setAddReactions(!checked);
      else setReplayOfflineEvents(!checked);
      setError(err instanceof Error ? err.message : gt("Failed to toggle switch"));
    }
  };

  const handleReconnect = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await reconnectSlackRelay();
      applySnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("Failed to reconnect"));
    } finally {
      setSaving(false);
    }
  };

  const handlePickSkillFolder = async () => {
    setPickingFolder(true);
    setError(null);
    try {
      const targetProject =
        (projectId ? projects.find((project) => project.id === projectId) : undefined) ??
        projects[0];
      const initialPath = targetProject?.workspaceRoot
        ? `${targetProject.workspaceRoot}/.agents/skills`
        : undefined;
      const picked = await window.desktopBridge?.pickFolder(
        initialPath ? { initialPath } : undefined,
      );
      if (picked) {
        setPromptFilePath(picked);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("Failed to pick folder"));
    } finally {
      setPickingFolder(false);
    }
  };

  const badge = CONNECTION_STATE_LABELS[snapshot?.status.state ?? "disabled"];
  const projects = snapshot?.projects ?? [];
  const skills = snapshot?.skills ?? [];
  const canPickFolder = typeof window !== "undefined" && window.desktopBridge !== undefined;
  const selectedSkillOption = skills.find((skill) => skill.path === promptFilePath);
  const selectedSkillLabel = !promptFilePath
    ? gt("None")
    : selectedSkillOption
      ? selectedSkillOption.name
      : promptFilePath;
  const selectedProjectLabel = projectId
    ? (projects.find((project) => project.id === projectId)?.title ?? projectId)
    : gt("Default project");

  return (
    <SettingsSection id="ct-studio-slack-relay" title={gt("Slack Relay")}>
      <SettingsRow
        id="ct-studio-slack-relay-enabled"
        title={gt("Enable Slack real-time relay")}
        description={
          <T>
            Receive Slack @mentions in real time over Cloudflare Worker WebSocket and trigger local
            agent threads in CT Code.
          </T>
        }
        status={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={badge.variant} size="sm">
              {loading ? gt("Loading...") : m(badge.label)}
            </Badge>
            {snapshot?.status.lastError ? (
              <span className="text-xs text-destructive">{snapshot.status.lastError}</span>
            ) : null}
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
            {notice ? <span className="text-xs text-muted-foreground">{notice}</span> : null}
          </div>
        }
        control={
          <div className="flex items-center gap-2">
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => void handleToggleSwitch("enabled", checked)}
              disabled={loading || saving}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleReconnect()}
              disabled={loading || saving || !snapshot?.config.enabled}
            >
              <T>Reconnect</T>
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={loading || saving}>
              {saving ? gt("Saving...") : gt("Save")}
            </Button>
          </div>
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-worker-url"
        title={gt("Worker WebSocket URL")}
        description={
          <T>
            Cloudflare Worker WebSocket endpoint (for example
            wss://slack-agent-relay.example.workers.dev/ws).
          </T>
        }
        control={
          <input
            type="text"
            value={workerWsUrl}
            onChange={(event) => setWorkerWsUrl(event.target.value)}
            placeholder="wss://slack-agent-relay.example.workers.dev/ws"
            className={INPUT_CLASS}
          />
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-secret"
        title={gt("Relay Secret")}
        description={
          <T>
            Shared auth secret with your Cloudflare Worker (stored locally with 0600 permissions;
            leave blank to keep current value).
          </T>
        }
        status={
          snapshot?.config.hasRelaySecret ? (
            <Badge variant="secondary" size="sm">
              {gt("Configured ({preview})", { preview: snapshot.config.relaySecretPreview })}
            </Badge>
          ) : undefined
        }
        control={
          <input
            type="password"
            value={relaySecret}
            onChange={(event) => setRelaySecret(event.target.value)}
            placeholder={
              snapshot?.config.hasRelaySecret
                ? gt("Leave blank to keep current")
                : gt("Enter RELAY_SECRET")
            }
            className={INPUT_CLASS}
          />
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-user-id"
        title={gt("My User ID")}
        description={
          <T>Your Slack member ID (such as U01234567). Only @mentions of this ID will trigger.</T>
        }
        control={
          <input
            type="text"
            value={myUserId}
            onChange={(event) => setMyUserId(event.target.value)}
            placeholder="U01234567"
            className={INPUT_CLASS}
          />
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-user-token"
        title={gt("User Token (xoxp-...)")}
        description={
          <T>Used to post replies as your own Slack account (requires chat:write scope).</T>
        }
        status={
          snapshot?.config.hasUserToken ? (
            <Badge variant="secondary" size="sm">
              {gt("Configured ({preview})", { preview: snapshot.config.userTokenPreview })}
            </Badge>
          ) : undefined
        }
        control={
          <input
            type="password"
            value={userToken}
            onChange={(event) => setUserToken(event.target.value)}
            placeholder={
              snapshot?.config.hasUserToken ? gt("Leave blank to keep current") : "xoxp-..."
            }
            className={INPUT_CLASS}
          />
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-bot-token"
        title={gt("Bot Token (xoxb-...)")}
        description={
          <T>
            Optional. Used to read thread history, resolve channel/user names, and add status
            reactions.
          </T>
        }
        status={
          snapshot?.config.hasBotToken ? (
            <Badge variant="secondary" size="sm">
              {gt("Configured ({preview})", { preview: snapshot.config.botTokenPreview })}
            </Badge>
          ) : undefined
        }
        control={
          <input
            type="password"
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
            placeholder={
              snapshot?.config.hasBotToken
                ? gt("Leave blank to keep current")
                : gt("xoxb-... (optional)")
            }
            className={INPUT_CLASS}
          />
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-reply-mode"
        title={gt("Reply Mode")}
        description={
          <T>Choose whether replies post automatically or wait for review inside the thread.</T>
        }
        control={
          <Select
            value={replyMode}
            onValueChange={(value) => {
              if (value === "auto" || value === "draft") setReplyMode(value);
            }}
          >
            <SelectTrigger className="h-8 w-56">
              <SelectValue>{m(REPLY_MODE_LABELS[replyMode])}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="draft">{m(REPLY_MODE_LABELS.draft)}</SelectItem>
              <SelectItem value="auto">{m(REPLY_MODE_LABELS.auto)}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-reply-prefix"
        title={gt("Reply Prefix")}
        description={
          <T>First line prepended to every reply to mark it as AI-assisted and prevent loops.</T>
        }
        control={
          <input
            type="text"
            value={replyPrefix}
            onChange={(event) => setReplyPrefix(event.target.value)}
            placeholder={gt("🤖 [AI 代理自动回复]")}
            className={INPUT_CLASS}
          />
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-runtime-mode"
        title={gt("Agent permission mode")}
        description={
          <T>
            Protects against prompt injection from external messages. Supervised pauses for your
            approval before edits or commands.
          </T>
        }
        control={
          <Select
            value={runtimeMode}
            onValueChange={(value) => {
              if (value === "approval-required" || value === "full-access") {
                setRuntimeMode(value);
              }
            }}
          >
            <SelectTrigger className="h-8 w-56">
              <SelectValue>{m(RUNTIME_MODE_LABELS[runtimeMode])}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="approval-required">
                {m(RUNTIME_MODE_LABELS["approval-required"])}
              </SelectItem>
              <SelectItem value="full-access">{m(RUNTIME_MODE_LABELS["full-access"])}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-project"
        title={gt("Target project")}
        description={<T>Project where Slack-triggered threads are created.</T>}
        control={
          <Select
            value={projectId || "__auto__"}
            onValueChange={(value) => setProjectId(value === "__auto__" ? "" : (value ?? ""))}
          >
            <SelectTrigger className="h-8 w-56">
              <SelectValue>{selectedProjectLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="__auto__">{gt("Default project")}</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-group"
        title={gt("Sidebar group")}
        description={
          <T>Tags new threads with group:&lt;name&gt; in the sidebar. Leave blank to ungroup.</T>
        }
        control={
          <input
            type="text"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder={gt("Slack")}
            className={INPUT_CLASS}
          />
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-model"
        title={gt("Model & reasoning effort")}
        description={
          modelOverride ? (
            <T>Using a custom override for Slack threads. Reset to follow the target project.</T>
          ) : (
            <T>
              Following the target project default model. Pick a model or effort to override for
              Slack.
            </T>
          )
        }
        resetAction={
          modelOverride !== null ? (
            <SettingResetButton
              ariaLabel={gt("Reset Slack model to project default")}
              onClick={() => setModelOverride(null)}
            />
          ) : null
        }
        control={
          shownSelection ? (
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                environmentId={representative?.environmentId ?? null}
                activeInstanceId={shownSelection.instanceId}
                model={shownSelection.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onOpenProviderSetup={(instanceId) => {
                  if (representative) {
                    void navigate({
                      to: "/settings/providers",
                      search: { environmentId: representative.environmentId, instanceId },
                    });
                  }
                }}
                onInstanceModelChange={(instanceId, model) =>
                  setModelOverride(pickModelSelection(shownSelection, instanceId, model))
                }
              />
              {activeEntry ? (
                <TraitsPicker
                  provider={activeEntry.driverKind}
                  models={activeEntry.models}
                  model={shownSelection.model}
                  modelOptions={shownSelection.options ?? []}
                  allowPromptInjectedEffort={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    setModelOverride(
                      createModelSelection(
                        shownSelection.instanceId,
                        shownSelection.model,
                        options,
                      ),
                    )
                  }
                />
              ) : null}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">
              <T>No providers available</T>
            </span>
          )
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-custom-prompt"
        title={gt("Custom instructions (optional)")}
        description={
          <T>Define reply tone, formatting rules, or constraints for your Slack agent.</T>
        }
        control={
          <textarea
            value={customPrompt}
            onChange={(event) => setCustomPrompt(event.target.value)}
            rows={3}
            placeholder={gt("e.g. Keep replies under 3 sentences; never commit to release dates.")}
            className="w-full rounded-lg border border-input bg-background px-2.5 py-2 text-xs text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:w-80"
          />
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-prompt-file"
        title={gt("Referenced Skill / prompt folder (optional)")}
        description={
          <T>
            Pick a Skill from the target project or browse a local folder. Loads SKILL.md and
            provides its directory for bundled scripts.
          </T>
        }
        resetAction={
          promptFilePath ? (
            <SettingResetButton
              ariaLabel={gt("Clear referenced Skill folder")}
              onClick={() => setPromptFilePath("")}
            />
          ) : null
        }
        control={
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
            <Select
              value={promptFilePath || "__none__"}
              onValueChange={(value) =>
                setPromptFilePath(value === "__none__" ? "" : (value ?? ""))
              }
            >
              <SelectTrigger className="h-8 w-56">
                <SelectValue>{selectedSkillLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="__none__">{gt("None")}</SelectItem>
                {skills.map((skill) => (
                  <SelectItem key={skill.path} value={skill.path}>
                    {skill.name}
                  </SelectItem>
                ))}
                {promptFilePath && !selectedSkillOption ? (
                  <SelectItem value={promptFilePath}>{promptFilePath}</SelectItem>
                ) : null}
              </SelectPopup>
            </Select>
            {canPickFolder ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pickingFolder}
                onClick={() => void handlePickSkillFolder()}
              >
                {pickingFolder ? gt("Choosing...") : gt("Choose folder...")}
              </Button>
            ) : null}
          </div>
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-allowlists"
        title={gt("Channel / user allowlists (optional)")}
        description={
          <T>Comma-separated Slack IDs. Leave blank to accept mentions in all bot channels.</T>
        }
        control={
          <div className="flex w-full flex-col gap-2 sm:w-auto">
            <input
              type="text"
              value={allowedChannelsText}
              onChange={(event) => setAllowedChannelsText(event.target.value)}
              placeholder={gt("Allowed channel IDs (e.g. C0123, C0456)")}
              className={INPUT_CLASS}
            />
            <input
              type="text"
              value={allowedUsersText}
              onChange={(event) => setAllowedUsersText(event.target.value)}
              placeholder={gt("Allowed user IDs (e.g. U0123, U0456)")}
              className={INPUT_CLASS}
            />
          </div>
        }
      />

      <SettingsRow
        id="ct-studio-slack-relay-toggles"
        title={gt("Behavior")}
        description={<T>Toggle switches apply immediately without clicking Save.</T>}
        control={
          <div className="flex flex-col gap-2 text-xs">
            <label className="flex items-center justify-between gap-3">
              <span>
                <T>Allow self @mentions</T>
              </span>
              <Switch
                checked={allowSelfMention}
                onCheckedChange={(checked) => void handleToggleSwitch("allowSelfMention", checked)}
              />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span>
                <T>Add 👀 / ✅ reactions</T>
              </span>
              <Switch
                checked={addReactions}
                onCheckedChange={(checked) => void handleToggleSwitch("addReactions", checked)}
              />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span>
                <T>Replay offline mentions on reconnect</T>
              </span>
              <Switch
                checked={replayOfflineEvents}
                onCheckedChange={(checked) =>
                  void handleToggleSwitch("replayOfflineEvents", checked)
                }
              />
            </label>
          </div>
        }
      />
    </SettingsSection>
  );
}
