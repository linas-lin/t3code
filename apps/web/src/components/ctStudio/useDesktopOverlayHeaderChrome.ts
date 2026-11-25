import { useSyncExternalStore, type CSSProperties } from "react";

import { isElectron } from "~/env";
import { cn, isMacPlatform } from "~/lib/utils";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 90px)";

let overlayFullscreenSnapshot: boolean | null = null;

function readMacosDesktopBridge() {
  if (typeof window === "undefined" || !isElectron || !isMacPlatform(navigator.platform)) {
    return null;
  }
  return window.desktopBridge ?? null;
}

function subscribeToOverlayWindowFullscreen(onChange: () => void): () => void {
  const bridge = readMacosDesktopBridge();
  if (
    typeof bridge?.getWindowFullscreenState !== "function" ||
    typeof bridge.onWindowFullscreenStateChange !== "function"
  ) {
    return () => {};
  }
  const unsubscribe = bridge.onWindowFullscreenStateChange((fullscreen) => {
    overlayFullscreenSnapshot = fullscreen;
    onChange();
  });
  overlayFullscreenSnapshot = bridge.getWindowFullscreenState();
  return () => {
    unsubscribe();
    overlayFullscreenSnapshot = null;
  };
}

function readOverlayWindowFullscreen(): boolean {
  if (overlayFullscreenSnapshot === null) {
    const getWindowFullscreenState = readMacosDesktopBridge()?.getWindowFullscreenState;
    overlayFullscreenSnapshot =
      typeof getWindowFullscreenState === "function" ? getWindowFullscreenState() : false;
  }
  return overlayFullscreenSnapshot;
}

/**
 * Computes desktop titlebar safe-area padding and drag-region classes for fullscreen overlays
 * portaled to `document.body` (outside `AppSidebarLayout`), keeping content clear of macOS
 * traffic lights on the left and Windows WCO window controls on the right.
 */
export function useDesktopOverlayHeaderChrome(): {
  readonly isDesktopOverlay: boolean;
  readonly needsMacTrafficLightInset: boolean;
  readonly headerClassName: string;
  readonly headerStyle: CSSProperties | undefined;
} {
  const isMacosDesktop =
    typeof navigator !== "undefined" && isElectron && isMacPlatform(navigator.platform);
  const isWindowFullscreen = useSyncExternalStore(
    subscribeToOverlayWindowFullscreen,
    readOverlayWindowFullscreen,
    () => false,
  );
  const needsMacTrafficLightInset = isMacosDesktop && !isWindowFullscreen;

  return {
    isDesktopOverlay: isElectron,
    needsMacTrafficLightInset,
    headerClassName: cn(isElectron && "drag-region wco:pr-(--workspace-native-controls-inset)"),
    headerStyle: needsMacTrafficLightInset
      ? { paddingLeft: MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : undefined,
  };
}
