import { describe, expect, it } from "vite-plus/test";

import {
  buildViewedFileFingerprint,
  isEntryViewedInRecord,
  NARROW_DIFF_BREAKPOINT_PX,
  resolveEffectiveDiffLayout,
  useIdeDiffViewedStore,
} from "./ideDiffPreferences";
import type { IdeDiffFileEntry } from "./types";

function makeEntry(overrides: Partial<IdeDiffFileEntry> = {}): IdeDiffFileEntry {
  return {
    fileKey: "src/app.ts:0",
    path: "src/app.ts",
    status: "modified",
    additions: 10,
    deletions: 3,
    isTest: false,
    ...overrides,
  };
}

describe("ideDiffPreferences", () => {
  it("switches to unified and hides file tree on narrow non-fullscreen widths", () => {
    expect(
      resolveEffectiveDiffLayout({
        containerWidth: NARROW_DIFF_BREAKPOINT_PX - 1,
        fullscreen: false,
        userLayout: "split",
        userTreeOpen: true,
      }),
    ).toEqual({
      effectiveLayout: "unified",
      effectiveTreeOpen: false,
      isNarrow: true,
    });
  });

  it("restores user layout and tree preference when wide or in fullscreen", () => {
    expect(
      resolveEffectiveDiffLayout({
        containerWidth: 500,
        fullscreen: true,
        userLayout: "split",
        userTreeOpen: true,
      }),
    ).toEqual({
      effectiveLayout: "split",
      effectiveTreeOpen: true,
      isNarrow: false,
    });

    expect(
      resolveEffectiveDiffLayout({
        containerWidth: NARROW_DIFF_BREAKPOINT_PX,
        fullscreen: false,
        userLayout: "split",
        userTreeOpen: false,
      }),
    ).toEqual({
      effectiveLayout: "split",
      effectiveTreeOpen: false,
      isNarrow: false,
    });
  });

  it("invalidates viewed status when file fingerprint changes", () => {
    useIdeDiffViewedStore.getState().resetAllForTest();
    const original = makeEntry({ additions: 5, deletions: 1 });
    useIdeDiffViewedStore.getState().setViewed("scope:1", original, true);

    const record = useIdeDiffViewedStore.getState().data.scopes["scope:1"];
    expect(isEntryViewedInRecord(record, original)).toBe(true);

    const updated = makeEntry({ additions: 8, deletions: 1 });
    expect(buildViewedFileFingerprint(updated)).not.toBe(buildViewedFileFingerprint(original));
    expect(isEntryViewedInRecord(record, updated)).toBe(false);
  });

  it("enforces LRU scope cap when persisting many scopes", () => {
    useIdeDiffViewedStore.getState().resetAllForTest();
    const entry = makeEntry();
    for (let index = 0; index < 75; index += 1) {
      useIdeDiffViewedStore.getState().setViewed(`scope:${index}`, entry, true);
    }
    const data = useIdeDiffViewedStore.getState().data;
    expect(data.order.length).toBeLessThanOrEqual(60);
    expect(data.scopes["scope:0"]).toBeUndefined();
    expect(data.scopes["scope:74"]).toBeDefined();
  });
});
