import { useStableCallback } from "~/hooks/useStableCallback";
import { projectContentSearch } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import {
  buildDefinitionSearchRegex,
  extractImportHints,
  findLocalDefinitionsInFile,
  isLikelyCommentLine,
  isLikelyDeclarationLine,
  orderReferenceScopes,
  rankAndDedupeLocations,
  scoreDefinitionCandidate,
} from "./symbolNavigation.logic";
import type { ExplorerRepoScope, SymbolLocation, SymbolNavigationProvider } from "./types";

const DEFINITION_PER_REPO_LIMIT = 40;
const REFERENCE_PER_REPO_LIMIT = 100;

/**
 * Route 1 symbol navigator: heuristic multi-repo Go to Definition & Find Usages
 * powered by T3 Code's ripgrep searchContents RPC + import-aware ranking.
 */
export function useHeuristicSymbolNavigator(): SymbolNavigationProvider {
  const runSearchContents = useAtomQueryRunner(projectContentSearch, {
    label: "code-explorer:symbol-navigation",
    reportFailure: false,
  });

  const findDefinitions = useStableCallback(
    async (
      input: Parameters<SymbolNavigationProvider["findDefinitions"]>[0],
    ): Promise<ReadonlyArray<SymbolLocation>> => {
      const { symbol, qualifier, currentFile, currentFileText, language, scopes } = input;
      if (!symbol.trim()) return [];

      const importHints = extractImportHints(currentFileText);
      const localHits = findLocalDefinitionsInFile({
        symbol,
        currentFile,
        currentFileText,
      });

      // Ensure the current file's own repository is always included when searching for definitions.
      const effectiveScopes: ExplorerRepoScope[] = scopes.some((s) => s.id === currentFile.repoId)
        ? [...scopes]
        : [
            {
              id: currentFile.repoId,
              name: currentFile.repoName,
              cwd: currentFile.cwd,
              environmentId: currentFile.environmentId,
              origin: "project",
            },
            ...scopes,
          ];
      const orderedScopes = orderReferenceScopes(effectiveScopes, currentFile.repoId);

      const definitionRegex = buildDefinitionSearchRegex(symbol, language);

      const regexBatches = await Promise.all(
        orderedScopes.map(async (scope) => {
          const result = await runSearchContents({
            environmentId: scope.environmentId,
            input: {
              cwd: scope.cwd,
              query: definitionRegex.slice(0, 256),
              limit: DEFINITION_PER_REPO_LIMIT,
              caseSensitive: true,
              wholeWord: false,
              useRegex: true,
            },
          });
          if (result._tag !== "Success") return [];
          const locations: SymbolLocation[] = [];
          for (const match of result.value.matches) {
            if (isLikelyCommentLine(match.lineContent)) continue;
            if (
              scope.id === currentFile.repoId &&
              match.path === currentFile.relativePath &&
              match.lineNumber === currentFile.lineNumber
            ) {
              continue;
            }
            const score = scoreDefinitionCandidate({
              candidate: {
                repoId: scope.id,
                relativePath: match.path,
                lineNumber: match.lineNumber,
                lineContent: match.lineContent,
              },
              symbol,
              qualifier,
              currentFile,
              importHints,
            });
            if (score <= 0) continue;
            const symCol = match.lineContent.indexOf(symbol);
            locations.push({
              id: `def:${scope.id}:${match.path}:${match.lineNumber}`,
              repoId: scope.id,
              repoName: scope.name,
              cwd: scope.cwd,
              environmentId: scope.environmentId,
              relativePath: match.path,
              lineNumber: match.lineNumber,
              column: symCol >= 0 ? symCol + 1 : 1,
              previewLine: match.lineContent.trim(),
              kind: "definition",
              score,
            });
          }
          return locations;
        }),
      );

      let collected: SymbolLocation[] = [...localHits, ...regexBatches.flat()];

      // Fallback for multiline signatures (e.g. Java methods whose parameters wrap across lines):
      // run whole-word search and keep lines that look like declarations.
      if (collected.length === 0) {
        const fallbackBatches = await Promise.all(
          orderedScopes.map(async (scope) => {
            const result = await runSearchContents({
              environmentId: scope.environmentId,
              input: {
                cwd: scope.cwd,
                query: symbol.slice(0, 256),
                limit: DEFINITION_PER_REPO_LIMIT,
                caseSensitive: true,
                wholeWord: true,
                useRegex: false,
              },
            });
            if (result._tag !== "Success") return [];
            const locations: SymbolLocation[] = [];
            for (const match of result.value.matches) {
              if (!isLikelyDeclarationLine(match.lineContent, symbol)) continue;
              const score = scoreDefinitionCandidate({
                candidate: {
                  repoId: scope.id,
                  relativePath: match.path,
                  lineNumber: match.lineNumber,
                  lineContent: match.lineContent,
                },
                symbol,
                qualifier,
                currentFile,
                importHints,
              });
              const symCol = match.lineContent.indexOf(symbol);
              locations.push({
                id: `def-fb:${scope.id}:${match.path}:${match.lineNumber}`,
                repoId: scope.id,
                repoName: scope.name,
                cwd: scope.cwd,
                environmentId: scope.environmentId,
                relativePath: match.path,
                lineNumber: match.lineNumber,
                column: symCol >= 0 ? symCol + 1 : 1,
                previewLine: match.lineContent.trim(),
                kind: "definition",
                score,
              });
            }
            return locations;
          }),
        );
        collected = fallbackBatches.flat();
      }

      return rankAndDedupeLocations(collected);
    },
  );

  const findReferences = useStableCallback(
    async (
      input: Parameters<SymbolNavigationProvider["findReferences"]>[0],
    ): Promise<ReadonlyArray<SymbolLocation>> => {
      const { symbol, currentFile, scopes } = input;
      if (!symbol.trim()) return [];

      const effectiveScopes: ExplorerRepoScope[] = scopes.some((s) => s.id === currentFile.repoId)
        ? [...scopes]
        : [
            {
              id: currentFile.repoId,
              name: currentFile.repoName,
              cwd: currentFile.cwd,
              environmentId: currentFile.environmentId,
              origin: "project",
            },
            ...scopes,
          ];
      const orderedScopes = orderReferenceScopes(effectiveScopes, currentFile.repoId);

      const batches = await Promise.all(
        orderedScopes.map(async (scope) => {
          const result = await runSearchContents({
            environmentId: scope.environmentId,
            input: {
              cwd: scope.cwd,
              query: symbol.slice(0, 256),
              limit: REFERENCE_PER_REPO_LIMIT,
              caseSensitive: true,
              wholeWord: true,
              useRegex: false,
            },
          });
          if (result._tag !== "Success") return [];
          const locations: SymbolLocation[] = [];
          for (const match of result.value.matches) {
            if (isLikelyCommentLine(match.lineContent)) continue;
            const isDecl = isLikelyDeclarationLine(match.lineContent, symbol);
            const col =
              (match.matchRanges[0]?.start ?? Math.max(0, match.lineContent.indexOf(symbol))) + 1;
            locations.push({
              id: `ref:${scope.id}:${match.path}:${match.lineNumber}`,
              repoId: scope.id,
              repoName: scope.name,
              cwd: scope.cwd,
              environmentId: scope.environmentId,
              relativePath: match.path,
              lineNumber: match.lineNumber,
              column: col,
              previewLine: match.lineContent.trim(),
              kind: isDecl ? "definition" : "reference",
              score: (scope.id === currentFile.repoId ? 50 : 10) + (isDecl ? 20 : 0),
            });
          }
          return locations;
        }),
      );

      return rankAndDedupeLocations(batches.flat());
    },
  );

  return { findDefinitions, findReferences };
}
