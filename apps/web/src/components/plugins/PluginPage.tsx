import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  AlertTriangleIcon,
  PowerIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { PluginErrorBoundary } from "./PluginErrorBoundary";
import { usePluginStore } from "./pluginStore";
import { PLUGIN_UI_KIT } from "./pluginUiKit";

export type PluginRouteSearch = Record<string, string>;

export function parsePluginSearchString(searchStr: string): PluginRouteSearch {
  const result: Record<string, string> = {};
  if (!searchStr) return result;
  const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr);
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function pluginSearchFromRaw(raw: unknown): PluginRouteSearch {
  const result: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return result;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      result[key] = String(value);
    }
  }
  return result;
}

const PAGE_SHELL_CLASS =
  "relative flex h-dvh min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background surface-grain md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm/5 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2";

export function PluginPage({
  pluginId,
  search,
}: {
  readonly pluginId: string;
  readonly search: PluginRouteSearch;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const initialized = usePluginStore((state) => state.initialized);
  const plugin = usePluginStore((state) => state.plugins.find((item) => item.id === pluginId));
  const runtime = usePluginStore((state) => state.runtimeById[pluginId]);
  const reloadPlugin = usePluginStore((state) => state.reloadPlugin);
  const enablePlugin = usePluginStore((state) => state.enablePlugin);

  // Keep-alive main views are rendered persistently by PluginHostLayer in _chat.tsx.
  if (
    plugin?.enabled &&
    runtime?.status === "loaded" &&
    runtime.registration?.mainView?.keepAlive === true &&
    runtime.host
  ) {
    return null;
  }

  if (
    plugin?.enabled &&
    runtime?.status === "loaded" &&
    runtime.registration?.mainView &&
    runtime.host
  ) {
    const MainView = runtime.registration.mainView.Component;
    return (
      <main data-slot="plugin-page" data-plugin-id={plugin.id} className={PAGE_SHELL_CLASS}>
        <PluginErrorBoundary
          pluginId={plugin.id}
          pluginName={plugin.manifest?.name ?? plugin.id}
          slot="mainView"
          resetKey={runtime.loadedNonce ?? plugin.reloadNonce}
        >
          <MainView
            pluginId={plugin.id}
            active
            search={search}
            host={runtime.host}
            uiKit={PLUGIN_UI_KIT}
          />
        </PluginErrorBoundary>
      </main>
    );
  }

  if (!initialized || runtime?.status === "loading") {
    return (
      <main data-slot="plugin-page" data-plugin-id={pluginId} className={PAGE_SHELL_CLASS}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <Spinner className="size-5" />
          <span>
            {gt("Loading plugin {name}...", { name: plugin?.manifest?.name ?? pluginId })}
          </span>
        </div>
      </main>
    );
  }

  const errorMessage = plugin?.manifestError ?? runtime?.error ?? null;
  if (plugin?.enabled && (runtime?.status === "error" || errorMessage)) {
    return (
      <main data-slot="plugin-page" data-plugin-id={pluginId} className={PAGE_SHELL_CLASS}>
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty className="max-w-md">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertTriangleIcon className="text-destructive" />
              </EmptyMedia>
              <EmptyTitle>
                {gt("Failed to load {name}", { name: plugin.manifest?.name ?? plugin.id })}
              </EmptyTitle>
              <EmptyDescription>
                {errorMessage || gt("The plugin UI could not be loaded.")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" onClick={() => void reloadPlugin(plugin.id)}>
                  <RefreshCwIcon className="size-3.5" aria-hidden />
                  <span>{gt("Reload plugin")}</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void navigate({ to: "/settings/plugins" })}
                >
                  <SettingsIcon className="size-3.5" aria-hidden />
                  <span>{gt("Plugin settings")}</span>
                </Button>
              </div>
            </EmptyContent>
          </Empty>
        </div>
      </main>
    );
  }

  if (plugin && !plugin.enabled) {
    return (
      <main data-slot="plugin-page" data-plugin-id={pluginId} className={PAGE_SHELL_CLASS}>
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty className="max-w-md">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PuzzleIcon />
              </EmptyMedia>
              <EmptyTitle>
                {gt("{name} is disabled", { name: plugin.manifest?.name ?? plugin.id })}
              </EmptyTitle>
              <EmptyDescription>
                {gt("Enable this plugin to open its workspace view.")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" onClick={() => void enablePlugin(plugin.id, true)}>
                  <PowerIcon className="size-3.5" aria-hidden />
                  <span>{gt("Enable plugin")}</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void navigate({ to: "/settings/plugins" })}
                >
                  <SettingsIcon className="size-3.5" aria-hidden />
                  <span>{gt("Plugin settings")}</span>
                </Button>
              </div>
            </EmptyContent>
          </Empty>
        </div>
      </main>
    );
  }

  return (
    <main data-slot="plugin-page" data-plugin-id={pluginId} className={PAGE_SHELL_CLASS}>
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty className="max-w-md">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PuzzleIcon />
            </EmptyMedia>
            <EmptyTitle>
              {plugin
                ? gt("{name} has no main view", { name: plugin.manifest?.name ?? plugin.id })
                : gt("Plugin not found")}
            </EmptyTitle>
            <EmptyDescription>
              {plugin
                ? gt("This plugin does not register a workspace page.")
                : gt("No installed plugin matches {id}.", { id: pluginId })}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/plugins" })}
            >
              <SettingsIcon className="size-3.5" aria-hidden />
              <span>{gt("Manage plugins")}</span>
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    </main>
  );
}
