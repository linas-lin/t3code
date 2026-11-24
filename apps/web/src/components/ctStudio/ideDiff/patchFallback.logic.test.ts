import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  checkTextContentSafety,
  inferMonacoLanguage,
  MAX_IDE_DIFF_BYTES,
  MAX_IDE_DIFF_LINE_LENGTH,
  reconstructPatchSides,
} from "./patchFallback.logic";

describe("patchFallback.logic", () => {
  it("maps common filenames and extensions to Monaco languages", () => {
    expect(inferMonacoLanguage("apps/web/src/DiffPanel.tsx")).toBe("typescript");
    expect(inferMonacoLanguage("scripts/build.mjs")).toBe("javascript");
    expect(inferMonacoLanguage("infra/Dockerfile.prod")).toBe("dockerfile");
    expect(inferMonacoLanguage("Makefile")).toBe("shell");
    expect(inferMonacoLanguage("config/schema.yaml")).toBe("yaml");
    expect(inferMonacoLanguage("unknown.xyz")).toBe("plaintext");
  });

  it("detects binary, oversized, and minified long-line payloads", () => {
    expect(checkTextContentSafety("hello", "world")).toEqual({ ok: true });
    expect(checkTextContentSafety("abc\0def", "world")).toMatchObject({
      ok: false,
      reason: "binary",
    });
    expect(checkTextContentSafety("x".repeat(MAX_IDE_DIFF_LINE_LENGTH + 1), "")).toMatchObject({
      ok: false,
      reason: "long-line",
    });
    expect(checkTextContentSafety("a\n".repeat(MAX_IDE_DIFF_BYTES / 2 + 10), "")).toMatchObject({
      ok: false,
      reason: "too-large",
    });
  });

  it("reconstructs aligned old and new buffers from multi-hunk FileDiffMetadata", () => {
    const fileDiff = {
      name: "src/demo.ts",
      type: "change",
      deletionLines: ["const a = 1;\n", "const b = 2;\n", "const x = 9;\n"],
      additionLines: ["const a = 1;\n", "const b = 3;\n", "const c = 4;\n", "const x = 10;\n"],
      hunks: [
        {
          deletionStart: 1,
          deletionCount: 2,
          additionStart: 1,
          additionCount: 3,
          deletionLineIndex: 0,
          additionLineIndex: 0,
          hunkContent: [
            { type: "context", lines: 1 },
            { type: "change", deletions: 1, additions: 2 },
          ],
        },
        {
          deletionStart: 20,
          deletionCount: 1,
          additionStart: 21,
          additionCount: 1,
          deletionLineIndex: 2,
          additionLineIndex: 3,
          hunkContent: [{ type: "change", deletions: 1, additions: 1 }],
        },
      ],
    } as unknown as FileDiffMetadata;

    const result = reconstructPatchSides(fileDiff);
    expect(result.isEmpty).toBe(false);
    expect(result.oldText).toContain("const b = 2;");
    expect(result.newText).toContain("const b = 3;\nconst c = 4;");
    expect(result.oldText).toContain("@@ -20,1 +21,1 @@");
    expect(result.newText).toContain("@@ -20,1 +21,1 @@");
  });
});
