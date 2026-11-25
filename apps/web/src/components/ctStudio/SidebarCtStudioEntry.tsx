import { useLocation, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { LayoutGridIcon, RefreshCwIcon } from "lucide-react";
import { memo } from "react";

import { isMacPlatform } from "~/lib/utils";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { CT_STUDIO_ROUTE_PATH } from "./CtStudioKeepAliveLayer";
import { useCtStudioStore } from "./ctStudioStore";

export const SidebarCtStudioEntry = memo(function SidebarCtStudioEntry() {
  const gt = useGT();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isActive = useLocation({
    select: (location) => location.pathname === CT_STUDIO_ROUTE_PATH,
  });
  const badgeCount = useCtStudioStore((state) => state.badgeCount);
  const connected = useCtStudioStore((state) => state.connected);
  const triggerReload = useCtStudioStore((state) => state.triggerReload);
  const shortcutLabel = isMacPlatform(navigator.platform) ? "⌘⇧J" : "Ctrl+⇧J";

  if (!connected && !isActive) {
    return null;
  }

  const handleClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (isActive) {
      void navigateToMainApp();
      return;
    }
    void navigate({ to: "/ct-studio", search: {} });
  };

  return (
    <div className="shrink-0 border-b border-border/60 px-2 py-1.5">
      <SidebarMenu>
        <SidebarMenuItem className="group/ct-studio">
          <SidebarMenuButton
            isActive={isActive}
            onClick={handleClick}
            aria-label={
              badgeCount > 0 ? gt("CT Studio ({count})", { count: badgeCount }) : gt("CT Studio")
            }
            className="justify-between"
          >
            <span className="flex min-w-0 items-center gap-2">
              <LayoutGridIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                <T>CT Studio</T>
              </span>
              {connected ? (
                <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {isActive ? (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={gt("Reload CT Studio")}
                  onClick={(event) => {
                    event.stopPropagation();
                    triggerReload();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      triggerReload();
                    }
                  }}
                  className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/ct-studio:opacity-100"
                >
                  <RefreshCwIcon className="size-3" />
                </span>
              ) : null}
              {badgeCount > 0 ? (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-md border border-warning/30 bg-warning/15 px-1.5 text-3xs leading-none font-medium tabular-nums text-warning">
                  {badgeCount > 99 ? "99+" : badgeCount}
                </span>
              ) : (
                <span className="text-3xs text-muted-foreground/70">{shortcutLabel}</span>
              )}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  );
});
