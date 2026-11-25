import { create } from "zustand";

import type { DraftId } from "../../../composerDraftStore";
import { normalizeThreadGroupName } from "./threadGrouping.logic";

interface DraftThreadGroupStoreState {
  readonly groupNameByDraftId: Readonly<Record<string, string>>;
  readonly setDraftGroupName: (draftId: DraftId, groupName: string | null) => void;
  readonly getDraftGroupName: (draftId: DraftId | null | undefined) => string | null;
  readonly consumeDraftGroupName: (draftId: DraftId | null | undefined) => string | null;
}

export const useDraftThreadGroupStore = create<DraftThreadGroupStoreState>((set, get) => ({
  groupNameByDraftId: {},
  setDraftGroupName: (draftId, groupName) => {
    const normalized = groupName === null ? null : normalizeThreadGroupName(groupName);
    set((state) => {
      const existing = state.groupNameByDraftId[draftId];
      if (normalized === null) {
        if (existing === undefined) return state;
        const next = { ...state.groupNameByDraftId };
        delete next[draftId];
        return { groupNameByDraftId: next };
      }
      if (existing === normalized) return state;
      return {
        groupNameByDraftId: {
          ...state.groupNameByDraftId,
          [draftId]: normalized,
        },
      };
    });
  },
  getDraftGroupName: (draftId) => {
    if (!draftId) return null;
    return get().groupNameByDraftId[draftId] ?? null;
  },
  consumeDraftGroupName: (draftId) => {
    if (!draftId) return null;
    const existing = get().groupNameByDraftId[draftId] ?? null;
    if (existing !== null) {
      get().setDraftGroupName(draftId, null);
    }
    return existing;
  },
}));
