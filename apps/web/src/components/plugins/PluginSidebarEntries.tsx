import { useLocation, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn, isMacPlatform } from "~/lib/utils";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { formatPluginShortcutLabel, PluginIcon } from "./pluginRuntime";
import { usePluginStore } from "./pluginStore";

export const PluginSidebarEntries = memo(function PluginSidebarEntries() {
  const gt = useGT();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const plugins = usePluginStore((state) => state.plugins);
  const runtimeById = usePluginStore((state) => state.runtimeById);
  const reloadPlugin = usePluginStore((state) => state.reloadPlugin);
  const [reloadingId, setReloadingId] = useState<string | null>(null);

  const visiblePlugins = plugins.filter((plugin) => {
    if (!plugin.enabled) return false;
    const runtime = runtimeById[plugin.id];
    const hasSidebar = Boolean(plugin.manifest?.contributes?.sidebar);
    const hasMainView = Boolean(runtime?.registration?.mainView);
    return hasSidebar || hasMainView;
  });

  if (visiblePlugins.length === 0) {
    return null;
  }

  const isMac = isMacPlatform(navigator.platform);

  return (
    <div
      data-slot="plugin-sidebar-entries"
      className="shrink-0 border-b border-border/60 px-2 py-1.5"
    >
      <SidebarMenu>
        {visiblePlugins.map((plugin) => {
          const runtime = runtimeById[plugin.id];
          const routePath = `/plugins/${encodeURIComponent(plugin.id)}`;
          const isActive = pathname === routePath || pathname === `/plugins/${plugin.id}`;
          const sidebarMeta = plugin.manifest?.contributes?.sidebar;
          const label = sidebarMeta?.label || plugin.manifest?.name || plugin.id;
          const badgeCount = runtime?.badgeCount ?? 0;
          const shortcutLabel = formatPluginShortcutLabel(sidebarMeta?.shortcut, isMac);
          const hasError =
            Boolean(plugin.manifestError) ||
            runtime?.status === "error" ||
            plugin.backend.status === "error";
          const isLoading =
            reloadingId === plugin.id ||
            runtime?.status === "loading" ||
            plugin.backend.status === "starting";
          const isReady = runtime?.status === "loaded" && !hasError;

          const statusDotClass = hasError
            ? "bg-destructive"
            : isLoading
              ? "bg-warning"
              : isReady
                ? "bg-success"
                : null;

          const handleClick = () => {
            if (isMobile) {
              setOpenMobile(false);
            }
            if (isActive) {
              void navigateToMainApp();
              return;
            }
            void navigate({
              to: "/plugins/$pluginId",
              params: { pluginId: plugin.id },
            });
          };

          const handleReload = () => {
            setReloadingId(plugin.id);
            void reloadPlugin(plugin.id).finally(() => {
              setReloadingId((current) => (current === plugin.id ? null : current));
            });
          };

          return (
            <SidebarMenuItem key={plugin.id} className="group/plugin-entry">
              <SidebarMenuButton
                isActive={isActive}
                onClick={handleClick}
                aria-label={
                  badgeCount > 0 ? gt("{label} ({count})", { label, count: badgeCount }) : label
                }
                className="justify-between"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <PluginIcon name={sidebarMeta?.icon} className="size-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                  {statusDotClass ? (
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", statusDotClass)}
                      aria-hidden
                    />
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={gt("Reload {label}", { label })}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleReload();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        handleReload();
                      }
                    }}
                    className={cn(
                      "inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/plugin-entry:opacity-100",
                      isLoading && "opacity-100",
                    )}
                  >
                    <RefreshCwIcon
                      className={cn("size-3", isLoading && "animate-spin")}
                      aria-hidden
                    />
                  </span>
                  {badgeCount > 0 ? (
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-md border border-warning/30 bg-warning/15 px-1.5 text-3xs leading-none font-medium tabular-nums text-warning">
                      {badgeCount > 99 ? "99+" : badgeCount}
                    </span>
                  ) : shortcutLabel ? (
                    <span className="text-3xs text-muted-foreground/70">{shortcutLabel}</span>
                  ) : null}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </div>
  );
});
