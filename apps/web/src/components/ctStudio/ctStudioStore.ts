import { create } from "zustand";

import { EMPTY_CT_STUDIO_WORKSPACE_CONTEXT, type CtStudioWorkspaceContext } from "./ctStudioBridge";
import { buildCtStudioUrl, readCtStudioUrl, writeCtStudioUrl } from "./ctStudioConfig";

export interface CtStudioNavRequest {
  readonly ticket?: string | undefined;
  readonly stage?: string | undefined;
  readonly itemId?: string | undefined;
  readonly nonce: number;
}

interface CtStudioStoreState {
  readonly mounted: boolean;
  readonly connected: boolean;
  readonly badgeCount: number;
  readonly baseUrl: string;
  readonly iframeSrc: string;
  readonly reloadNonce: number;
  readonly pendingNav: CtStudioNavRequest | null;
  readonly workspaceContext: CtStudioWorkspaceContext;
  readonly openFromRoute: (target?: {
    ticket?: string | undefined;
    stage?: string | undefined;
    itemId?: string | undefined;
  }) => void;
  readonly markBackgroundMounted: () => void;
  readonly setConnected: (connected: boolean) => void;
  readonly setBadgeCount: (count: number) => void;
  readonly setWorkspaceContext: (context: CtStudioWorkspaceContext) => void;
  readonly setBaseUrl: (url: string) => string | null;
  readonly triggerReload: () => void;
  readonly clearPendingNav: (nonce: number) => void;
}

let navSequence = 0;
const initialBaseUrl = readCtStudioUrl();

export const useCtStudioStore = create<CtStudioStoreState>((set) => ({
  mounted: false,
  connected: false,
  badgeCount: 0,
  baseUrl: initialBaseUrl,
  iframeSrc: buildCtStudioUrl(initialBaseUrl),
  reloadNonce: 0,
  pendingNav: null,
  workspaceContext: EMPTY_CT_STUDIO_WORKSPACE_CONTEXT,
  openFromRoute: (target) =>
    set((state) => {
      const hasTarget = Boolean(target?.ticket || target?.stage || target?.itemId);
      if (!state.mounted) {
        const nextSrc = buildCtStudioUrl(state.baseUrl, target);
        return {
          mounted: true,
          iframeSrc: nextSrc,
          pendingNav: hasTarget
            ? {
                ticket: target?.ticket,
                stage: target?.stage,
                itemId: target?.itemId,
                nonce: ++navSequence,
              }
            : state.pendingNav,
        };
      }
      if (!hasTarget) return state;
      return {
        pendingNav: {
          ticket: target?.ticket,
          stage: target?.stage,
          itemId: target?.itemId,
          nonce: ++navSequence,
        },
      };
    }),
  markBackgroundMounted: () => set((state) => (state.mounted ? state : { mounted: true })),
  setConnected: (connected) =>
    set((state) => (state.connected === connected ? state : { connected })),
  setBadgeCount: (count) =>
    set((state) => (state.badgeCount === count ? state : { badgeCount: count })),
  setWorkspaceContext: (workspaceContext) => set({ workspaceContext }),
  setBaseUrl: (url) => {
    const normalized = writeCtStudioUrl(url);
    if (!normalized) return null;
    set((state) => ({
      baseUrl: normalized,
      iframeSrc: buildCtStudioUrl(normalized),
      connected: false,
      reloadNonce: state.reloadNonce + 1,
    }));
    return normalized;
  },
  triggerReload: () =>
    set((state) => ({
      connected: false,
      reloadNonce: state.reloadNonce + 1,
    })),
  clearPendingNav: (nonce) =>
    set((state) => (state.pendingNav?.nonce === nonce ? { pendingNav: null } : state)),
}));
