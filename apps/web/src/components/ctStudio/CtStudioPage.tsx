import { useLocation, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { LayoutGridIcon, PuzzleIcon, SettingsIcon } from "lucide-react";
import { useEffect } from "react";

import { usePluginStore } from "../plugins/pluginStore";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { useCtStudioStore } from "./ctStudioStore";

export interface CtStudioSearch {
  readonly ticket?: string | undefined;
  readonly stage?: string | undefined;
  readonly itemId?: string | undefined;
}

export function ctStudioSearchFromUrl(raw: Record<string, unknown>): CtStudioSearch {
  const ticket = typeof raw.ticket === "string" ? raw.ticket.trim().slice(0, 64) : "";
  const stage = typeof raw.stage === "string" ? raw.stage.trim().slice(0, 32) : "";
  const itemId = typeof raw.itemId === "string" ? raw.itemId.trim().slice(0, 128) : "";
  return {
    ...(ticket ? { ticket } : {}),
    ...(stage ? { stage } : {}),
    ...(itemId ? { itemId } : {}),
  };
}

export function CtStudioPage() {
  const gt = useGT();
  const navigate = useNavigate();
  const search = useLocation({ select: (location) => location.search });
  const legacyEnabled = useCtStudioStore((state) => state.legacyEnabled);
  const hasCtStudioPlugin = usePluginStore((state) =>
    state.plugins.some((plugin) => plugin.id === "ct-studio" && plugin.enabled),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- redirects legacy /ct-studio links to the enabled CT Studio plugin when legacy iframe mode is disabled
  useEffect(() => {
    if (legacyEnabled || !hasCtStudioPlugin) return;
    const forwardedSearch: Record<string, string> = {};
    if (search && typeof search === "object") {
      for (const [key, value] of Object.entries(search as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) {
          forwardedSearch[key] = value;
        }
      }
    }
    void navigate({
      to: "/plugins/$pluginId",
      params: { pluginId: "ct-studio" },
      search: forwardedSearch,
      replace: true,
    });
  }, [legacyEnabled, hasCtStudioPlugin, navigate, search]);

  if (legacyEnabled) {
    // The persistent iframe is rendered by CtStudioKeepAliveLayer in _chat.tsx so switching
    // back and forth between threads and CT Studio preserves scroll and form state.
    return null;
  }

  if (hasCtStudioPlugin) {
    return null;
  }

  return (
    <main className="relative flex h-dvh min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background surface-grain md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm/5 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2">
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty className="max-w-md">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGridIcon />
            </EmptyMedia>
            <EmptyTitle>{gt("Legacy CT Studio integration is disabled")}</EmptyTitle>
            <EmptyDescription>
              <T>
                Enable the legacy iframe integration in CT Studio settings, or install and enable
                the CT Studio plugin instead.
              </T>
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/ct-studio" })}
              >
                <SettingsIcon className="size-3.5" aria-hidden />
                <span>{gt("CT Studio settings")}</span>
              </Button>
              <Button size="sm" onClick={() => void navigate({ to: "/settings/plugins" })}>
                <PuzzleIcon className="size-3.5" aria-hidden />
                <span>{gt("Manage plugins")}</span>
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      </div>
    </main>
  );
}
