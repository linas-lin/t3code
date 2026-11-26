import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { DEFAULT_CT_STUDIO_URL, normalizeCtStudioUrl } from "./ctStudioConfig";
import { useCtStudioStore } from "./ctStudioStore";
import { useSidebarFocusTopEnabled, writeSidebarFocusTopEnabled } from "./sidebarFocusSection";

export function CtStudioSettingsSection() {
  const gt = useGT();
  const navigate = useNavigate();
  const connected = useCtStudioStore((state) => state.connected);
  const baseUrl = useCtStudioStore((state) => state.baseUrl);
  const setBaseUrl = useCtStudioStore((state) => state.setBaseUrl);
  const sidebarFocusTopEnabled = useSidebarFocusTopEnabled();

  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const dirty = urlDraft.trim() !== baseUrl;

  const handleSave = () => {
    const normalized = normalizeCtStudioUrl(urlDraft);
    if (!normalized) {
      setUrlError(gt("Enter a valid http:// or https:// URL."));
      return;
    }
    setUrlError(null);
    setBaseUrl(normalized);
    setUrlDraft(normalized);
  };

  return (
    <SettingsSection id="ct-studio" title={gt("CT Studio")}>
      <SettingsRow
        id="ct-studio-status"
        title={gt("Local workspace")}
        description={
          <T>
            Connect a local CT Studio service for Jira boards, Inbox triage, and multi-repo coding
            flows inside T3 Code.
          </T>
        }
        status={
          <Badge variant={connected ? "success" : "secondary"} size="sm">
            {connected ? gt("Connected") : gt("Not connected")}
          </Badge>
        }
        control={
          <Button
            size="sm"
            variant={connected ? "outline" : "default"}
            onClick={() => void navigate({ to: "/ct-studio", search: {} })}
          >
            {connected ? gt("Open CT Studio") : gt("Setup & Connect")}
          </Button>
        }
      />
      <SettingsRow
        id="ct-studio-url"
        title={gt("Service URL")}
        description={<T>Local HTTP address where your CT Studio app is running.</T>}
        status={urlError ? <span className="text-destructive">{urlError}</span> : undefined}
        resetAction={
          baseUrl !== DEFAULT_CT_STUDIO_URL ? (
            <SettingResetButton
              ariaLabel={gt("Reset CT Studio URL to default")}
              onClick={() => {
                setUrlError(null);
                setBaseUrl(DEFAULT_CT_STUDIO_URL);
                setUrlDraft(DEFAULT_CT_STUDIO_URL);
              }}
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <input
              type="text"
              value={urlDraft}
              onChange={(event) => {
                setUrlDraft(event.target.value);
                setUrlError(null);
              }}
              aria-label={gt("CT Studio service URL")}
              placeholder={DEFAULT_CT_STUDIO_URL}
              className="h-8 w-full rounded-lg border border-input bg-background px-2.5 font-mono text-xs text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:w-56"
            />
            {dirty ? (
              <Button size="sm" variant="outline" onClick={handleSave}>
                <T>Save</T>
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        id="ct-studio-sidebar-focus-top"
        title={gt("Pin active & unread threads to top")}
        description={
          <T>
            Keep threads needing attention, unread completions, and running tasks at the very top of
            the sidebar across all projects.
          </T>
        }
        control={
          <Switch
            checked={sidebarFocusTopEnabled}
            onCheckedChange={(checked) => writeSidebarFocusTopEnabled(Boolean(checked))}
            aria-label={gt("Pin active & unread threads to top")}
          />
        }
      />
    </SettingsSection>
  );
}
