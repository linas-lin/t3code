import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { memo, useEffect, useRef } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { isElectron } from "~/env";
import { resolveShortcutCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { isModelPickerOpen } from "~/modelPickerVisibility";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { PluginErrorBoundary } from "./PluginErrorBoundary";
import { useSyncPluginHostBridge } from "./pluginHostBridge";
import { mergeKeybindingsWithPlugins, pluginIdFromToggleCommand } from "./pluginKeybindings";
import { ensurePluginRuntimeGlobal } from "./pluginRuntime";
import { usePluginStore } from "./pluginStore";
import { PLUGIN_UI_KIT } from "./pluginUiKit";

const EMPTY_SEARCH: Record<string, string> = {};

function extractActivePluginId(pathname: string): string | null {
  const match = /^\/plugins\/([^/]+)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("[data-keybinding-capture]") !== null) return true;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export const PluginHostLayer = memo(function PluginHostLayer() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const pathname = useLocation({ select: (location) => location.pathname });
  const activePluginId = extractActivePluginId(pathname);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);

  const plugins = usePluginStore((state) => state.plugins);
  const runtimeById = usePluginStore((state) => state.runtimeById);
  const navigationById = usePluginStore((state) => state.navigationById);
  const headerInsetProbeRef = useRef<HTMLDivElement>(null);

  const hasEnabledPlugins = plugins.some((plugin) => plugin.enabled);
  const isAnyPluginMainViewActive = activePluginId !== null;

  useSyncPluginHostBridge({
    enabled: hasEnabledPlugins || isAnyPluginMainViewActive,
    headerInsetProbeRef,
    isAnyPluginMainViewActive,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ensures the global plugin runtime object is registered before any plugin bundle executes
  useEffect(() => {
    ensurePluginRuntimeGlobal();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches installed plugin metadata from the primary server and activates enabled plugins on boot
  useEffect(() => {
    if (primaryEnvironmentId === null) return;
    void usePluginStore.getState().refreshPlugins();
  }, [primaryEnvironmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for configured plugin toggle keybindings (falling back to manifest defaults) to toggle plugin main views
  useEffect(() => {
    const enabledPluginIds = new Set(
      plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
    );
    if (enabledPluginIds.size === 0) return;

    const effectiveKeybindings = mergeKeybindingsWithPlugins(serverKeybindings, plugins);
    const hasPluginBindings = effectiveKeybindings.some((binding) => {
      const targetId = pluginIdFromToggleCommand(binding.command);
      return targetId !== null && enabledPluginIds.has(targetId);
    });
    if (!hasPluginBindings) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || event.isComposing) return;
      if (isCommandPaletteOpen() || isModelPickerOpen()) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]") !== null
      ) {
        return;
      }

      const command = resolveShortcutCommand(event, effectiveKeybindings, {
        context: {
          editableFocus: isEditableShortcutTarget(event.target),
        },
      });
      const targetPluginId = pluginIdFromToggleCommand(command);
      if (!targetPluginId || !enabledPluginIds.has(targetPluginId)) return;
      if (!event.metaKey && !event.ctrlKey && isEditableShortcutTarget(event.target)) {
        return;
      }

      event.preventDefault();
      if (activePluginId === targetPluginId) {
        void navigateToMainApp();
      } else {
        void navigate({
          to: "/plugins/$pluginId",
          params: { pluginId: targetPluginId },
        });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [plugins, serverKeybindings, activePluginId, navigate, navigateToMainApp]);

  const keepAliveEntries = plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    const runtime = runtimeById[plugin.id];
    const mainView = runtime?.registration?.mainView;
    if (runtime?.status !== "loaded" || !mainView?.keepAlive || !runtime.host) return [];
    return [{ plugin, runtime, Component: mainView.Component, host: runtime.host }];
  });

  if (keepAliveEntries.length === 0 && !isAnyPluginMainViewActive) {
    return null;
  }

  return (
    <>
      {isAnyPluginMainViewActive ? (
        <div
          ref={headerInsetProbeRef}
          aria-hidden
          className={cn(
            "pointer-events-none invisible fixed left-0 top-0 h-[var(--workspace-topbar-height)] w-0 overflow-hidden",
            isElectron && "wco:pr-(--workspace-native-controls-inset)",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        />
      ) : null}
      {keepAliveEntries.map(({ plugin, runtime, Component, host }) => {
        const isActive = activePluginId === plugin.id;
        const navRecord = navigationById[plugin.id];
        const pluginName = plugin.manifest?.name ?? plugin.id;
        return (
          <main
            key={plugin.id}
            data-slot="plugin-keep-alive-layer"
            data-plugin-id={plugin.id}
            data-active={isActive ? "true" : "false"}
            aria-hidden={!isActive}
            className={cn(
              isActive
                ? "relative flex h-dvh min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background surface-grain md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm/5 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2"
                : "hidden",
            )}
          >
            <PluginErrorBoundary
              pluginId={plugin.id}
              pluginName={pluginName}
              slot="mainView"
              resetKey={runtime.loadedNonce ?? plugin.reloadNonce}
            >
              <Component
                pluginId={plugin.id}
                active={isActive}
                search={navRecord?.search ?? EMPTY_SEARCH}
                host={host}
                uiKit={PLUGIN_UI_KIT}
              />
            </PluginErrorBoundary>
          </main>
        );
      })}
    </>
  );
});
