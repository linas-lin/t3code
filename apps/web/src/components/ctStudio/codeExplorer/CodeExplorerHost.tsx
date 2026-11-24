import { lazy, Suspense, useEffect, useRef } from "react";

import { isMacPlatform } from "~/lib/utils";
import { useCodeExplorerStore } from "./codeExplorerStore";

const CodeExplorerOverlay = lazy(() => import("./CodeExplorerOverlay"));

const DOUBLE_SHIFT_WINDOW_MS = 350;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function isTerminalTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(".xterm, [data-terminal-surface]"));
}

/**
 * Lightweight global host mounted in `_chat.tsx` so Monaco stays out of the initial bundle
 * until opened via Cmd+Shift+F, Cmd+Shift+O / Ctrl+Shift+N, or Double Shift.
 */
export function CodeExplorerHost() {
  const open = useCodeExplorerStore((state) => state.open);
  const lastShiftTapRef = useRef<{ timestamp: number; clean: boolean }>({
    timestamp: 0,
    clean: false,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers global IntelliJ IDEA keyboard shortcuts to open Code Explorer
  useEffect(() => {
    const isMac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTerminalTarget(event.target)) return;
      const mod = isMac ? event.metaKey : event.ctrlKey;

      if (event.key !== "Shift") {
        lastShiftTapRef.current.clean = false;
      } else if (!event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
        lastShiftTapRef.current.clean = !isTypingTarget(event.target);
        return;
      }

      if (mod && event.shiftKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "f") {
          event.preventDefault();
          event.stopPropagation();
          useCodeExplorerStore.getState().openExplorer("code");
          return;
        }
        if ((isMac && key === "o") || (!isMac && key === "n")) {
          event.preventDefault();
          event.stopPropagation();
          useCodeExplorerStore.getState().openExplorer("files");
        }
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Shift" || !lastShiftTapRef.current.clean) return;
      if (isTerminalTarget(event.target) || isTypingTarget(event.target)) {
        lastShiftTapRef.current = { timestamp: 0, clean: false };
        return;
      }
      const now = event.timeStamp;
      const prev = lastShiftTapRef.current.timestamp;
      if (prev > 0 && now - prev <= DOUBLE_SHIFT_WINDOW_MS) {
        lastShiftTapRef.current = { timestamp: 0, clean: false };
        useCodeExplorerStore.getState().openExplorer();
      } else {
        lastShiftTapRef.current = { timestamp: now, clean: false };
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <CodeExplorerOverlay />
    </Suspense>
  );
}
