import type { EnvironmentId } from "@t3tools/contracts";

export type ExplorerSearchMode = "code" | "files" | "tree";

export type ExplorerRepoOrigin = "project" | "ct-repos" | "custom";

export interface ExplorerRepoScope {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly origin: ExplorerRepoOrigin;
  /** True for the ct-studio root folder so users are warned before searching across its worktrees. */
  readonly isCtStudioRoot?: boolean | undefined;
}

export interface ExplorerFileTarget {
  readonly repoId: string;
  readonly repoName: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string;
  readonly lineNumber?: number | undefined;
  readonly column?: number | undefined;
  readonly revealToken?: number | undefined;
}

export interface ExplorerNavHistoryEntry {
  readonly repoId: string;
  readonly repoName: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly column: number;
}

export interface ExplorerContentHit {
  readonly repoId: string;
  readonly repoName: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineContent: string;
  readonly matchRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

export interface ExplorerFileMatchGroup {
  readonly key: string;
  readonly repoId: string;
  readonly repoName: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string;
  readonly hits: ReadonlyArray<ExplorerContentHit>;
}

export interface ExplorerRepoMatchGroup {
  readonly repoId: string;
  readonly repoName: string;
  readonly files: ReadonlyArray<ExplorerFileMatchGroup>;
  readonly totalHits: number;
  readonly truncated: boolean;
}

export interface ExplorerFileEntryHit {
  readonly key: string;
  readonly repoId: string;
  readonly repoName: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string;
  readonly fileName: string;
}

export interface SymbolLocation {
  readonly id: string;
  readonly repoId: string;
  readonly repoName: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly column: number;
  readonly previewLine: string;
  readonly kind: "definition" | "reference";
  readonly score: number;
}

/**
 * Extensible symbol navigation contract:
 * - Route 1 (current): HeuristicSymbolNavigator backed by ripgrep searchContents + import-aware ranking
 * - Future: LspSymbolNavigator backed by jdtls / typescript-language-server
 */
export interface SymbolNavigationProvider {
  findDefinitions(input: {
    readonly symbol: string;
    readonly qualifier?: string | undefined;
    readonly currentFile: ExplorerFileTarget;
    readonly currentFileText: string;
    readonly language: string;
    readonly scopes: ReadonlyArray<ExplorerRepoScope>;
  }): Promise<ReadonlyArray<SymbolLocation>>;

  findReferences(input: {
    readonly symbol: string;
    readonly currentFile: ExplorerFileTarget;
    readonly scopes: ReadonlyArray<ExplorerRepoScope>;
  }): Promise<ReadonlyArray<SymbolLocation>>;
}

export interface ExplorerDrawerState {
  readonly kind: "definitions" | "references";
  readonly symbol: string;
  readonly loading: boolean;
  readonly locations: ReadonlyArray<SymbolLocation>;
  readonly error?: string | undefined;
}
