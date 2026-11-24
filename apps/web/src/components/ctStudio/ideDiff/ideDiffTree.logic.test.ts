import { describe, expect, it } from "vite-plus/test";

import {
  buildCompactIdeDiffTree,
  filterIdeDiffEntries,
  findNextUnviewedEntry,
  flattenTreeFileEntries,
} from "./ideDiffTree.logic";
import type { IdeDiffFileEntry } from "./types";

function entry(path: string, overrides: Partial<IdeDiffFileEntry> = {}): IdeDiffFileEntry {
  return {
    fileKey: `${path}:0`,
    path,
    status: "modified",
    additions: 4,
    deletions: 1,
    isTest: path.includes(".test."),
    ...overrides,
  };
}

describe("ideDiffTree.logic", () => {
  it("compacts single-child middle directories like IntelliJ IDEA", () => {
    const entries = [
      entry("src/components/ctStudio/ideDiff/IdeDiffWorkspace.tsx"),
      entry("src/components/ctStudio/ideDiff/types.ts"),
      entry("README.md"),
    ];

    const tree = buildCompactIdeDiffTree(entries);
    expect(tree).toHaveLength(2);
    expect(tree[0]).toMatchObject({
      kind: "folder",
      name: "src/components/ctStudio/ideDiff",
      fullPath: "src/components/ctStudio/ideDiff",
      fileCount: 2,
    });
    expect(tree[1]).toMatchObject({
      kind: "file",
      name: "README.md",
    });

    expect(flattenTreeFileEntries(tree).map((item) => item.path)).toEqual([
      "src/components/ctStudio/ideDiff/IdeDiffWorkspace.tsx",
      "src/components/ctStudio/ideDiff/types.ts",
      "README.md",
    ]);
  });

  it("stops compacting where a directory branches into multiple children", () => {
    const entries = [entry("apps/web/src/a.ts"), entry("apps/server/src/b.ts")];

    const tree = buildCompactIdeDiffTree(entries);
    expect(tree).toHaveLength(1);
    const rootFolder = tree[0];
    expect(rootFolder?.kind).toBe("folder");
    if (rootFolder?.kind === "folder") {
      expect(rootFolder.name).toBe("apps");
      expect(rootFolder.children.map((node) => node.name)).toEqual(["server/src", "web/src"]);
    }
  });

  it("filters by query, hideViewed, and hideTests while keeping selected file when no query", () => {
    const a = entry("src/a.ts");
    const b = entry("src/b.test.ts");
    const c = entry("src/c.ts");
    const viewed = new Set([a.fileKey]);

    const filtered = filterIdeDiffEntries([a, b, c], {
      query: "",
      hideViewed: true,
      hideTests: true,
      isViewed: (item) => viewed.has(item.fileKey),
      keepFileKey: a.fileKey,
    });
    expect(filtered.map((item) => item.path)).toEqual(["src/a.ts", "src/c.ts"]);

    const queried = filterIdeDiffEntries([a, b, c], {
      query: "src c.ts",
      hideViewed: false,
      hideTests: false,
      isViewed: () => false,
    });
    expect(queried.map((item) => item.path)).toEqual(["src/c.ts"]);
  });

  it("wraps around to find the next unviewed file", () => {
    const a = entry("src/a.ts");
    const b = entry("src/b.ts");
    const c = entry("src/c.ts");
    const viewed = new Set([b.fileKey, c.fileKey]);

    expect(findNextUnviewedEntry([a, b, c], c.fileKey, (item) => viewed.has(item.fileKey))).toEqual(
      a,
    );
    expect(
      findNextUnviewedEntry([a, b, c], a.fileKey, (item) =>
        new Set([a.fileKey, b.fileKey, c.fileKey]).has(item.fileKey),
      ),
    ).toBeNull();
  });
});
