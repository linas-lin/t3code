import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useProjects } from "~/state/entities";
import { projectContentSearch, projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { isCtStudioWorkspace } from "../ctStudioConfig";
import {
  basenameOfPath,
  buildAvailableRepoScopes,
  findFileNameMatchRanges,
  isTestFilePath,
  joinRepoSubpath,
  matchesPathFilter,
} from "./repoScope.logic";
import type {
  ExplorerContentHit,
  ExplorerFileEntryHit,
  ExplorerFileMatchGroup,
  ExplorerRepoMatchGroup,
  ExplorerRepoScope,
} from "./types";
import { useCodeExplorerStore } from "./codeExplorerStore";

const CONTENT_SEARCH_PER_REPO_LIMIT = 150;
const FILE_SEARCH_PER_REPO_LIMIT = 80;
const SEARCH_DEBOUNCE_MS = 180;

export interface DiscoveredCtRepo {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly cwd: string;
}

/**
 * Discovers linked repositories inside `<ct-studio>/repos/` using existing `projects.listEntries`
 * and combines them with registered projects and user-added custom repositories.
 */
export function useAvailableRepoScopes(enabled: boolean): {
  readonly scopes: ReadonlyArray<ExplorerRepoScope>;
  readonly isDiscovering: boolean;
} {
  const projects = useProjects();
  const customRepos = useCodeExplorerStore((state) => state.customRepos);
  const runListEntries = useAtomQueryRunner(projectEnvironment.listEntries, {
    label: "code-explorer:discover-ct-repos",
    reportFailure: false,
  });

  const [ctStudioRepos, setCtStudioRepos] = useState<ReadonlyArray<DiscoveredCtRepo>>([]);
  const [discoveringCount, setDiscoveringCount] = useState(0);
  const discoveredRootsRef = useRef<Set<string>>(new Set());

  const ctStudioProjects = projects.filter((project) =>
    isCtStudioWorkspace({ title: project.title, workspaceRoot: project.workspaceRoot }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches ct-studio/repos directory entries once per ct-studio project root
  useEffect(() => {
    if (!enabled || ctStudioProjects.length === 0) return;

    const pendingRoots = ctStudioProjects.filter(
      (project) =>
        !discoveredRootsRef.current.has(`${project.environmentId}::${project.workspaceRoot}`),
    );
    if (pendingRoots.length === 0) return;

    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) setDiscoveringCount((count) => count + 1);
    });

    void Promise.all(
      pendingRoots.map(async (project) => {
        const key = `${project.environmentId}::${project.workspaceRoot}`;
        const result = await runListEntries(
          {
            environmentId: project.environmentId,
            input: { cwd: project.workspaceRoot, directoryPath: "repos" },
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return [];
        discoveredRootsRef.current.add(key);
        if (result._tag !== "Success") return [];
        const repos: DiscoveredCtRepo[] = [];
        for (const entry of result.value.entries) {
          if (entry.kind !== "directory") continue;
          const name = basenameOfPath(entry.path);
          if (!name || name.startsWith(".")) continue;
          repos.push({
            environmentId: project.environmentId,
            name,
            cwd: joinRepoSubpath(project.workspaceRoot, entry.path),
          });
        }
        return repos;
      }),
    )
      .then((batches) => {
        if (controller.signal.aborted) return;
        const added = batches.flat();
        if (added.length > 0) {
          setCtStudioRepos((current) => {
            const merged = new Map(
              current.map((item) => [`${item.environmentId}::${item.cwd}`, item]),
            );
            for (const item of added) {
              merged.set(`${item.environmentId}::${item.cwd}`, item);
            }
            return Array.from(merged.values());
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDiscoveringCount((count) => Math.max(0, count - 1));
        }
      });

    return () => {
      controller.abort();
    };
  }, [ctStudioProjects, enabled, runListEntries]);

  const scopes = buildAvailableRepoScopes({
    projects: projects.map((project) => ({
      environmentId: project.environmentId,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    })),
    ctStudioRepos,
    customRepos,
  });

  return { scopes, isDiscovering: discoveringCount > 0 };
}

export function useMultiRepoContentSearch(input: {
  readonly enabled: boolean;
  readonly scopes: ReadonlyArray<ExplorerRepoScope>;
  readonly query: string;
  readonly pathFilter: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
  readonly triggerNonce: number;
}) {
  const runSearchContents = useAtomQueryRunner(projectContentSearch, {
    label: "code-explorer:search-contents",
    reportFailure: false,
  });

  const [state, setState] = useState<{
    readonly requestKey: string;
    readonly groups: ReadonlyArray<ExplorerRepoMatchGroup>;
    readonly totalHits: number;
    readonly error: string | null;
  }>({
    requestKey: "",
    groups: [],
    totalHits: 0,
    error: null,
  });

  const scopesKey = input.scopes.map((scope) => scope.id).join("|");
  const trimmedQuery = input.query.trim();
  const canSearch = input.enabled && input.scopes.length > 0 && trimmedQuery.length > 0;
  const activeRequestKey = canSearch
    ? `${scopesKey}::${input.query}::${input.caseSensitive ? 1 : 0}::${input.wholeWord ? 1 : 0}::${input.useRegex ? 1 : 0}::${input.triggerNonce}`
    : "";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs debounced multi-repository content search with cancellation
  useEffect(() => {
    if (!canSearch || !activeRequestKey) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void Promise.all(
        input.scopes.map(async (scope): Promise<ExplorerRepoMatchGroup | null> => {
          const result = await runSearchContents(
            {
              environmentId: scope.environmentId,
              input: {
                cwd: scope.cwd,
                query: input.query.slice(0, 256),
                limit: CONTENT_SEARCH_PER_REPO_LIMIT,
                caseSensitive: input.caseSensitive,
                wholeWord: input.wholeWord,
                useRegex: input.useRegex,
              },
            },
            { signal: controller.signal },
          );
          if (controller.signal.aborted || result._tag !== "Success") return null;

          const byFile = new Map<string, ExplorerContentHit[]>();
          for (const match of result.value.matches) {
            const list = byFile.get(match.path) ?? [];
            list.push({
              repoId: scope.id,
              repoName: scope.name,
              cwd: scope.cwd,
              environmentId: scope.environmentId,
              relativePath: match.path,
              lineNumber: match.lineNumber,
              lineContent: match.lineContent,
              matchRanges: match.matchRanges,
            });
            byFile.set(match.path, list);
          }

          const files: ExplorerFileMatchGroup[] = Array.from(byFile.entries()).map(
            ([relativePath, hits]) => ({
              key: `${scope.id}::${relativePath}`,
              repoId: scope.id,
              repoName: scope.name,
              cwd: scope.cwd,
              environmentId: scope.environmentId,
              relativePath,
              hits,
            }),
          );
          const totalHits = files.reduce((sum, file) => sum + file.hits.length, 0);
          if (totalHits === 0) return null;
          return {
            repoId: scope.id,
            repoName: scope.name,
            files,
            totalHits,
            truncated: result.value.truncated,
          };
        }),
      )
        .then((rawGroups) => {
          if (controller.signal.aborted) return;
          const groups = rawGroups.filter(
            (group): group is ExplorerRepoMatchGroup => group !== null,
          );
          const totalHits = groups.reduce((sum, group) => sum + group.totalHits, 0);
          setState({ requestKey: activeRequestKey, groups, totalHits, error: null });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState({
            requestKey: activeRequestKey,
            groups: [],
            totalHits: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    activeRequestKey,
    canSearch,
    input.caseSensitive,
    input.query,
    input.scopes,
    input.useRegex,
    input.wholeWord,
    runSearchContents,
  ]);

  const rawGroups = canSearch && state.requestKey === activeRequestKey ? state.groups : [];
  const filteredGroups: ExplorerRepoMatchGroup[] = [];
  let filteredTotalHits = 0;
  for (const group of rawGroups) {
    const files = group.files.filter((file) =>
      matchesPathFilter(file.relativePath, input.pathFilter),
    );
    if (files.length === 0) continue;
    const repoHits = files.reduce((sum, file) => sum + file.hits.length, 0);
    filteredTotalHits += repoHits;
    filteredGroups.push({
      ...group,
      files,
      totalHits: repoHits,
    });
  }

  return {
    groups: filteredGroups,
    totalHits: filteredTotalHits,
    isPending: canSearch && state.requestKey !== activeRequestKey,
    error: canSearch && state.requestKey === activeRequestKey ? state.error : null,
  };
}

export function useMultiRepoFileSearch(input: {
  readonly enabled: boolean;
  readonly scopes: ReadonlyArray<ExplorerRepoScope>;
  readonly query: string;
  readonly pathFilter: string;
}) {
  const runSearchEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    label: "code-explorer:search-entries",
    reportFailure: false,
  });

  const [state, setState] = useState<{
    readonly requestKey: string;
    readonly files: ReadonlyArray<ExplorerFileEntryHit>;
  }>({ requestKey: "", files: [] });

  const scopesKey = input.scopes.map((scope) => scope.id).join("|");
  const trimmed = input.query.trim();
  const canSearch = input.enabled && input.scopes.length > 0;
  const activeRequestKey = canSearch ? `${scopesKey}::${trimmed}` : "";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs debounced multi-repository filename search with cancellation
  useEffect(() => {
    if (!canSearch || !activeRequestKey) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void Promise.all(
        input.scopes.map(async (scope) => {
          const result = await runSearchEntries(
            {
              environmentId: scope.environmentId,
              input: {
                cwd: scope.cwd,
                query: trimmed.slice(0, 256),
                limit: FILE_SEARCH_PER_REPO_LIMIT,
                kind: "file",
              },
            },
            { signal: controller.signal },
          );
          if (controller.signal.aborted || result._tag !== "Success") return [];
          return result.value.entries
            .filter((entry) => entry.kind === "file")
            .map((entry): ExplorerFileEntryHit => ({
              key: `${scope.id}::${entry.path}`,
              repoId: scope.id,
              repoName: scope.name,
              cwd: scope.cwd,
              environmentId: scope.environmentId,
              relativePath: entry.path,
              fileName: basenameOfPath(entry.path),
            }));
        }),
      ).then((batches) => {
        if (controller.signal.aborted) return;
        const combined = batches.flat();
        const lowerQuery = trimmed.toLowerCase();
        const scoreFileMatch = (file: ExplorerFileEntryHit): number => {
          if (!lowerQuery) return 0;
          const lowerName = file.fileName.toLowerCase();
          let score = 0;
          if (lowerName === lowerQuery) score += 200;
          else if (lowerName.startsWith(lowerQuery)) score += 160;
          else if (lowerName.includes(lowerQuery)) score += 130;
          else {
            const ranges = findFileNameMatchRanges(file.fileName, lowerQuery);
            if (ranges.length > 0) {
              const span = ranges[ranges.length - 1]!.end - ranges[0]!.start;
              // Prefer tighter fuzzy spans & fewer gaps inside the filename.
              score += Math.max(
                40,
                110 - (ranges.length - 1) * 10 - Math.min(40, span - lowerQuery.length),
              );
            }
          }
          if (!isTestFilePath(file.relativePath)) score += 8;
          return score;
        };
        combined.sort((left, right) => {
          if (lowerQuery) {
            const diff = scoreFileMatch(right) - scoreFileMatch(left);
            if (diff !== 0) return diff;
          }
          return left.relativePath.localeCompare(right.relativePath);
        });
        setState({ requestKey: activeRequestKey, files: combined });
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeRequestKey, canSearch, input.scopes, runSearchEntries, trimmed]);

  const rawFiles = canSearch && state.requestKey === activeRequestKey ? state.files : [];
  const filteredFiles = rawFiles.filter((file) =>
    matchesPathFilter(file.relativePath, input.pathFilter),
  );

  return {
    files: filteredFiles,
    isPending: canSearch && state.requestKey !== activeRequestKey,
  };
}

export function useRepoTreeSearch(input: {
  readonly enabled: boolean;
  readonly scope: ExplorerRepoScope | null;
  readonly query: string;
}) {
  const runSearchEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    label: "code-explorer:tree-search",
    reportFailure: false,
  });

  const [state, setState] = useState<{
    readonly requestKey: string;
    readonly entries: ReadonlyArray<ProjectEntry>;
  }>({ requestKey: "", entries: [] });

  const trimmed = input.query.trim();
  const canSearch = input.enabled && Boolean(input.scope) && trimmed.length > 0;
  const activeRequestKey = canSearch && input.scope ? `${input.scope.id}::${trimmed}` : "";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs debounced tree entry search across files and directories
  useEffect(() => {
    if (!canSearch || !input.scope || !activeRequestKey) return;

    const controller = new AbortController();
    const scope = input.scope;
    const timer = window.setTimeout(() => {
      void runSearchEntries(
        {
          environmentId: scope.environmentId,
          input: {
            cwd: scope.cwd,
            query: trimmed.slice(0, 256),
            limit: 120,
          },
        },
        { signal: controller.signal },
      ).then((result) => {
        if (controller.signal.aborted) return;
        const entries = result._tag === "Success" ? result.value.entries : [];
        setState({ requestKey: activeRequestKey, entries });
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeRequestKey, canSearch, input.scope, runSearchEntries, trimmed]);

  return {
    entries: canSearch && state.requestKey === activeRequestKey ? state.entries : [],
    isPending: canSearch && state.requestKey !== activeRequestKey,
  };
}

export function useDirectoryLoader() {
  const runListEntries = useAtomQueryRunner(projectEnvironment.listEntries, {
    label: "code-explorer:tree-list",
    reportFailure: false,
  });

  const loadDirectory = useStableCallback(
    async (
      scope: ExplorerRepoScope,
      directoryPath: string,
    ): Promise<ReadonlyArray<ProjectEntry>> => {
      const result = await runListEntries({
        environmentId: scope.environmentId,
        input: {
          cwd: scope.cwd,
          directoryPath,
        },
      });
      if (result._tag !== "Success") return [];
      return result.value.entries.toSorted((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
      });
    },
  );

  return { loadDirectory };
}
