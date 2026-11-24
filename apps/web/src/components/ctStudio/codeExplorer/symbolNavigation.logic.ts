import { isTestChangedFile } from "@t3tools/shared/changedFileKind";

import type { ExplorerFileTarget, ExplorerRepoScope, SymbolLocation } from "./types";

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

export interface ExtractedCursorSymbol {
  readonly symbol: string;
  readonly qualifier?: string | undefined;
}

/**
 * Extracts the identifier at `column` (1-based) and optional left qualifier
 * (e.g. `cartService.enqueueMarkFulfillableEvent` -> `{ symbol: "enqueueMarkFulfillableEvent", qualifier: "cartService" }`).
 */
export function extractSymbolAtPosition(
  lineText: string,
  column: number,
): ExtractedCursorSymbol | null {
  if (!lineText || column < 1) return null;
  let cursor = Math.min(column - 1, lineText.length - 1);
  if (!IDENTIFIER_CHAR.test(lineText[cursor] ?? "")) {
    if (cursor > 0 && IDENTIFIER_CHAR.test(lineText[cursor - 1] ?? "")) {
      cursor -= 1;
    } else {
      return null;
    }
  }

  let start = cursor;
  while (start > 0 && IDENTIFIER_CHAR.test(lineText[start - 1] ?? "")) {
    start -= 1;
  }
  let end = cursor;
  while (end + 1 < lineText.length && IDENTIFIER_CHAR.test(lineText[end + 1] ?? "")) {
    end += 1;
  }

  const symbol = lineText.slice(start, end + 1);
  if (!symbol || /^\d+$/.test(symbol)) return null;

  // Check for `qualifier.symbol` or `qualifier::symbol`
  let qualifier: string | undefined;
  let before = start - 1;
  while (before >= 0 && /\s/.test(lineText[before] ?? "")) before -= 1;
  if (before >= 0 && (lineText[before] === "." || lineText[before] === ":")) {
    let qEnd = before - 1;
    if (lineText[before] === ":" && qEnd >= 0 && lineText[qEnd] === ":") {
      qEnd -= 1;
    }
    while (qEnd >= 0 && /\s/.test(lineText[qEnd] ?? "")) qEnd -= 1;
    if (qEnd >= 0 && IDENTIFIER_CHAR.test(lineText[qEnd] ?? "")) {
      let qStart = qEnd;
      while (qStart > 0 && IDENTIFIER_CHAR.test(lineText[qStart - 1] ?? "")) {
        qStart -= 1;
      }
      qualifier = lineText.slice(qStart, qEnd + 1);
    }
  }

  return qualifier ? { symbol, qualifier } : { symbol };
}

export function extractImportHints(fileText: string): ReadonlyArray<string> {
  const hints = new Set<string>();
  const lines = fileText.split("\n", 240);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Java / Kotlin: `import com.blueapron.service.AutoShipCartService;`
    const javaImport = /^import\s+(?:static\s+)?([\w.]+)\s*;?$/.exec(line);
    if (javaImport?.[1]) {
      hints.add(javaImport[1].replaceAll(".", "/").toLowerCase());
      continue;
    }
    // TS / JS: `import ... from "./foo/bar"` or `import ... from "~/lib/foo"`
    const tsImport = /from\s+["']([^"']+)["']/.exec(line);
    if (tsImport?.[1]) {
      const cleaned = tsImport[1].replace(/^[.~@/]+/, "").toLowerCase();
      if (cleaned) hints.add(cleaned);
      continue;
    }
    // Proto: `import "blueapron/autoship/event.proto";`
    const protoImport = /^import\s+(?:public\s+)?"([^"]+)"/.exec(line);
    if (protoImport?.[1]) {
      hints.add(protoImport[1].toLowerCase());
    }
  }
  return Array.from(hints);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a concise ripgrep-compatible regex (<= 256 chars) targeting symbol declarations
 * across Java/Kotlin, TypeScript/JavaScript, Protobuf, Go, Python, and Rust.
 */
export function buildDefinitionSearchRegex(symbol: string, language: string): string {
  const escaped = escapeRegex(symbol);
  const isTypeLike = /^[A-Z]/.test(symbol);

  if (language === "java" || language === "kotlin") {
    if (isTypeLike) {
      return `\\b(class|interface|enum|record|@interface|object|typealias)\\s+${escaped}\\b`;
    }
    return `\\b(void|fun|boolean|int|long|double|float|byte|short|char|String|[A-Z]\\w*(<[^>]+>)?(\\[\\])?)\\s+${escaped}\\s*\\(`;
  }

  if (language === "typescript" || language === "javascript") {
    if (isTypeLike) {
      return `\\b(class|interface|type|enum|function|const)\\s+${escaped}\\b`;
    }
    return `(\\b(function|const|let|var)\\s+${escaped}\\b|^\\s*(export\\s+)?(public|private|protected|static|async|readonly\\s+)*${escaped}\\s*[(<])`;
  }

  if (language === "protobuf") {
    return `\\b(message|enum|service|rpc)\\s+${escaped}\\b`;
  }

  return `\\b(class|interface|enum|record|struct|trait|type|function|func|def|fn|message|service|rpc|const)\\s+${escaped}\\b`;
}

export function isLikelyCommentLine(lineContent: string): boolean {
  const trimmed = lineContent.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("--")
  );
}

export function isLikelyDeclarationLine(lineContent: string, symbol: string): boolean {
  if (isLikelyCommentLine(lineContent)) return false;
  const trimmed = lineContent.trim();
  const escaped = escapeRegex(symbol);

  // Explicit keyword declarations across languages
  if (
    new RegExp(
      `\\b(?:class|interface|enum|record|@interface|struct|trait|type|typealias|function|func|def|fn|message|service|rpc|const|let|var|object|fun)\\s+${escaped}\\b`,
    ).test(trimmed)
  ) {
    return true;
  }

  // Method / constructor declaration (Java/Kotlin/TS/C#): exclude obvious call sites like `obj.sym(` or `return sym(`
  const methodCallSite = new RegExp(
    `(?:\\.|->|::|\\breturn\\b|\\bnew\\b|\\bthrow\\b|=)\\s*${escaped}\\s*\\(`,
  );
  if (methodCallSite.test(trimmed)) return false;

  const methodDecl = new RegExp(
    `^(?:(?:public|private|protected|static|final|abstract|synchronized|default|native|override|suspend|async|readonly|export)\\s+)*(?:<[^>]+>\\s+)?(?:[\\w.$<>\\[\\], ?]+\\s+)?${escaped}\\s*\\(`,
  );
  if (methodDecl.test(trimmed) && !trimmed.endsWith(";")) {
    return true;
  }

  // Java interface abstract method ending with `;` (has modifiers or return type, not a call site)
  const interfaceMethodDecl = new RegExp(
    `^(?:(?:public|default|abstract|static)\\s+)*[\\w.$<>\\[\\]]+\\s+${escaped}\\s*\\([^)]*\\)\\s*;`,
  );
  return interfaceMethodDecl.test(trimmed);
}

/**
 * Fast local scan inside the currently open file for definitions of `symbol`
 * (skips the cursor's own line).
 */
export function findLocalDefinitionsInFile(input: {
  readonly symbol: string;
  readonly currentFile: ExplorerFileTarget;
  readonly currentFileText: string;
}): ReadonlyArray<SymbolLocation> {
  const lines = input.currentFileText.split("\n");
  const results: SymbolLocation[] = [];
  const wordRegex = new RegExp(`\\b${escapeRegex(input.symbol)}\\b`);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    if (lineNumber === input.currentFile.lineNumber) continue;
    const line = lines[index] ?? "";
    if (!wordRegex.test(line)) continue;
    if (!isLikelyDeclarationLine(line, input.symbol)) continue;
    const col = line.indexOf(input.symbol) + 1;
    results.push({
      id: `local:${input.currentFile.repoId}:${input.currentFile.relativePath}:${lineNumber}`,
      repoId: input.currentFile.repoId,
      repoName: input.currentFile.repoName,
      cwd: input.currentFile.cwd,
      environmentId: input.currentFile.environmentId,
      relativePath: input.currentFile.relativePath,
      lineNumber,
      column: Math.max(1, col),
      previewLine: line.trim(),
      kind: "definition",
      score: 140,
    });
  }
  return results;
}

function directoryOfPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

function sharedPathPrefixSegments(a: string, b: string): number {
  const left = a.split("/").filter(Boolean);
  const right = b.split("/").filter(Boolean);
  let count = 0;
  const max = Math.min(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    if (left[index] !== right[index]) break;
    count += 1;
  }
  return count;
}

export function scoreDefinitionCandidate(input: {
  readonly candidate: {
    readonly repoId: string;
    readonly relativePath: string;
    readonly lineNumber: number;
    readonly lineContent: string;
  };
  readonly symbol: string;
  readonly qualifier?: string | undefined;
  readonly currentFile: ExplorerFileTarget;
  readonly importHints: ReadonlyArray<string>;
}): number {
  const { candidate, symbol, qualifier, currentFile, importHints } = input;
  let score = 0;

  if (isLikelyCommentLine(candidate.lineContent)) {
    return -100;
  }

  const normalizedPath = candidate.relativePath.replaceAll("\\", "/").toLowerCase();
  const pathWithoutExt = normalizedPath.replace(/\.[^/.]+$/, "");
  const fileNameBase = pathWithoutExt.slice(pathWithoutExt.lastIndexOf("/") + 1);

  if (isLikelyDeclarationLine(candidate.lineContent, symbol)) {
    score += 55;
  }

  // Exact filename match for class/type definitions (e.g. AutoShipCartService.java)
  if (fileNameBase === symbol.toLowerCase()) {
    score += 45;
  }

  // Qualifier match against filename (e.g. `cartService.enqueue...` -> `AutoShipCartService.java`)
  if (qualifier && fileNameBase.includes(qualifier.toLowerCase())) {
    score += 35;
  }

  // Import hint match (highest confidence signal across files)
  if (
    importHints.some(
      (hint) =>
        pathWithoutExt.endsWith(hint) ||
        normalizedPath.endsWith(hint) ||
        (hint.includes("/") && pathWithoutExt.includes(hint)),
    )
  ) {
    score += 100;
  }

  if (
    candidate.repoId === currentFile.repoId &&
    candidate.relativePath === currentFile.relativePath
  ) {
    score += 80;
  } else if (candidate.repoId === currentFile.repoId) {
    score += 25;
    const shared = sharedPathPrefixSegments(
      directoryOfPath(candidate.relativePath),
      directoryOfPath(currentFile.relativePath),
    );
    score += Math.min(20, shared * 4);
  } else if (normalizedPath.endsWith(".proto")) {
    score += 20;
  }

  if (isTestChangedFile(candidate.relativePath)) {
    score -= 40;
  }

  return score;
}

export function rankAndDedupeLocations(
  locations: ReadonlyArray<SymbolLocation>,
): ReadonlyArray<SymbolLocation> {
  const bestByKey = new Map<string, SymbolLocation>();
  for (const location of locations) {
    const key = `${location.repoId}::${location.relativePath}::${location.lineNumber}`;
    const existing = bestByKey.get(key);
    if (!existing || location.score > existing.score) {
      bestByKey.set(key, location);
    }
  }
  return Array.from(bestByKey.values()).toSorted((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const pathCmp = left.relativePath.localeCompare(right.relativePath);
    if (pathCmp !== 0) return pathCmp;
    return left.lineNumber - right.lineNumber;
  });
}

/**
 * Decides whether Go to Definition should jump immediately without forcing the user to pick from a list.
 */
export function shouldAutoJumpDefinition(ranked: ReadonlyArray<SymbolLocation>): boolean {
  if (ranked.length === 0) return false;
  if (ranked.length === 1) return true;
  const first = ranked[0]!;
  const second = ranked[1]!;
  return first.score >= 120 && first.score - second.score >= 50;
}

export function orderReferenceScopes(
  scopes: ReadonlyArray<ExplorerRepoScope>,
  currentRepoId: string,
): ReadonlyArray<ExplorerRepoScope> {
  return scopes.toSorted((left, right) => {
    if (left.id === currentRepoId && right.id !== currentRepoId) return -1;
    if (right.id === currentRepoId && left.id !== currentRepoId) return 1;
    return left.name.localeCompare(right.name);
  });
}
