import type { FileDiffMetadata } from "@pierre/diffs";

export const MAX_IDE_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_IDE_DIFF_LINE_LENGTH = 20_000;

const FILENAME_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "shell",
  jenkinsfile: "java",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".env": "ini",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".editorconfig": "ini",
};

const EXTENSION_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  py: "python",
  pyi: "python",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  go: "go",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  sql: "sql",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  swift: "swift",
  rb: "ruby",
  php: "php",
  graphql: "graphql",
  gql: "graphql",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  dockerfile: "dockerfile",
  tf: "hcl",
  hcl: "hcl",
  proto: "protobuf",
};

export function inferMonacoLanguage(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const baseName = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  if (!baseName) return "plaintext";

  const exactMatch = FILENAME_LANGUAGE_MAP[baseName];
  if (exactMatch) return exactMatch;

  if (baseName.startsWith("dockerfile.")) return "dockerfile";
  if (baseName.startsWith(".env.")) return "ini";

  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < baseName.length - 1) {
    const ext = baseName.slice(dotIndex + 1);
    return EXTENSION_LANGUAGE_MAP[ext] ?? "plaintext";
  }
  return "plaintext";
}

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length * 2;
}

function hasExceedingLine(text: string, maxLength: number): boolean {
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) {
      if (index - lineStart > maxLength) return true;
      lineStart = index + 1;
    }
  }
  return text.length - lineStart > maxLength;
}

export function checkTextContentSafety(
  oldText: string,
  newText: string,
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "too-large" | "long-line" | "binary";
      readonly byteSize: number;
    } {
  const byteSize = utf8ByteLength(oldText) + utf8ByteLength(newText);
  if (oldText.includes("\0") || newText.includes("\0")) {
    return { ok: false, reason: "binary", byteSize };
  }
  if (byteSize > MAX_IDE_DIFF_BYTES) {
    return { ok: false, reason: "too-large", byteSize };
  }
  if (
    hasExceedingLine(oldText, MAX_IDE_DIFF_LINE_LENGTH) ||
    hasExceedingLine(newText, MAX_IDE_DIFF_LINE_LENGTH)
  ) {
    return { ok: false, reason: "long-line", byteSize };
  }
  return { ok: true };
}

function stripTrailingNewline(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

/**
 * Reconstructs aligned old/new text buffers from a partial FileDiffMetadata
 * (used for Turn checkpoints, Tool call diffs, or when full file contents are unavailable).
 */
export function reconstructPatchSides(fileDiff: FileDiffMetadata): {
  readonly oldText: string;
  readonly newText: string;
  readonly isEmpty: boolean;
} {
  if (fileDiff.hunks.length === 0) {
    return { oldText: "", newText: "", isEmpty: true };
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (let hunkIndex = 0; hunkIndex < fileDiff.hunks.length; hunkIndex += 1) {
    const hunk = fileDiff.hunks[hunkIndex]!;
    if (hunkIndex > 0) {
      const separator = `// ─── @@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@ ───`;
      oldLines.push(separator);
      newLines.push(separator);
    }

    let deletionIndex = hunk.deletionLineIndex;
    let additionIndex = hunk.additionLineIndex;

    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let offset = 0; offset < segment.lines; offset += 1) {
          const content = stripTrailingNewline(
            fileDiff.additionLines[additionIndex] ?? fileDiff.deletionLines[deletionIndex] ?? "",
          );
          oldLines.push(content);
          newLines.push(content);
          deletionIndex += 1;
          additionIndex += 1;
        }
        continue;
      }

      for (let offset = 0; offset < segment.deletions; offset += 1) {
        oldLines.push(stripTrailingNewline(fileDiff.deletionLines[deletionIndex] ?? ""));
        deletionIndex += 1;
      }

      for (let offset = 0; offset < segment.additions; offset += 1) {
        newLines.push(stripTrailingNewline(fileDiff.additionLines[additionIndex] ?? ""));
        additionIndex += 1;
      }
    }
  }

  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
    isEmpty: oldLines.length === 0 && newLines.length === 0,
  };
}
