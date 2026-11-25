import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  AlertTriangleIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  Code2Icon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  LayersIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";

import { getEnvironmentBrowsePlatform } from "../../CommandPalette.logic";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useDesktopOverlayHeaderChrome } from "../useDesktopOverlayHeaderChrome";
import {
  basenameOfPath,
  buildRepoScopeId,
  filterAndSortRepoScopes,
  normalizeRepoCwd,
  partitionSelectedScopeChips,
} from "./repoScope.logic";
import type { ExplorerRepoScope } from "./types";

const MAX_BROWSE_SUGGESTIONS = 40;
const MAX_VISIBLE_SELECTED_CHIPS = 3;

export interface CodeExplorerScopeBarProps {
  readonly scopes: ReadonlyArray<ExplorerRepoScope>;
  readonly selectedScopeIds: ReadonlyArray<string>;
  readonly defaultEnvironmentId: EnvironmentId | null;
  readonly defaultBrowseCwd?: string | null | undefined;
  readonly platformOs?: string | null | undefined;
  readonly isDiscovering: boolean;
  readonly onToggleScope: (scopeId: string) => void;
  readonly onSelectOnlyScope: (scopeId: string) => void;
  readonly onSelectAllBusinessScopes: () => void;
  readonly onClearScopes: () => void;
  readonly onAddCustomRepo: (input: {
    readonly name: string;
    readonly cwd: string;
    readonly environmentId: EnvironmentId;
  }) => void;
  readonly onRemoveCustomRepo: (cwd: string) => void;
  readonly onClose: () => void;
}

export function CodeExplorerScopeBar({
  scopes,
  selectedScopeIds,
  defaultEnvironmentId,
  defaultBrowseCwd,
  platformOs,
  isDiscovering,
  onToggleScope,
  onSelectOnlyScope,
  onSelectAllBusinessScopes,
  onClearScopes,
  onAddCustomRepo,
  onRemoveCustomRepo,
  onClose,
}: CodeExplorerScopeBarProps) {
  const gt = useGT();
  const { headerClassName: desktopHeaderClassName, headerStyle: desktopHeaderStyle } =
    useDesktopOverlayHeaderChrome();

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [scopeQuery, setScopeQuery] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const [customName, setCustomName] = useState("");
  const [isPickingNative, setIsPickingNative] = useState(false);

  const selectedSet = new Set(selectedScopeIds);
  const { selectedScopes, visibleChips, overflowCount } = partitionSelectedScopeChips(
    scopes,
    selectedScopeIds,
    MAX_VISIBLE_SELECTED_CHIPS,
  );
  const filteredScopes = filterAndSortRepoScopes(scopes, selectedScopeIds, scopeQuery);

  const canPickNativeFolder = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const browsePlatform = getEnvironmentBrowsePlatform(platformOs ?? undefined);
  const browsePath = getFilesystemBrowsePath(
    customPath,
    browsePlatform,
    popoverOpen && addingCustom && defaultEnvironmentId !== null,
  );

  const browseQuery = useEnvironmentQuery(
    popoverOpen &&
      addingCustom &&
      defaultEnvironmentId !== null &&
      browsePath.isBrowsing &&
      browsePath.directoryPath.length > 0
      ? filesystemEnvironment.browse({
          environmentId: defaultEnvironmentId,
          input: {
            partialPath: browsePath.directoryPath,
            ...(defaultBrowseCwd ? { cwd: defaultBrowseCwd } : {}),
          },
        })
      : null,
  );

  const { visibleEntries } = filterFilesystemBrowseEntries(
    browseQuery.data?.entries ?? [],
    browsePath.filterQuery,
  );
  const parentBrowsePath = browsePath.canBrowseUp ? browsePath.parentPath : null;

  const handlePopoverOpenChange = (nextOpen: boolean) => {
    setPopoverOpen(nextOpen);
    if (!nextOpen) {
      setScopeQuery("");
      setAddingCustom(false);
    }
  };

  const primeAddRepoPath = () => {
    if (!customPath.trim() && defaultBrowseCwd) {
      const initialDir =
        getBrowseParentPath(defaultBrowseCwd) ?? ensureBrowseDirectoryPath(defaultBrowseCwd);
      setCustomPath(initialDir);
    }
  };

  const openAddRepoPanel = () => {
    primeAddRepoPath();
    setPopoverOpen(true);
    setAddingCustom(true);
  };

  const toggleAddRepoInsidePopover = () => {
    if (addingCustom) {
      setAddingCustom(false);
      return;
    }
    primeAddRepoPath();
    setAddingCustom(true);
  };

  const addRepoByPath = (rawPath: string, explicitName?: string) => {
    const normalized = normalizeRepoCwd(rawPath);
    if (!normalized || !defaultEnvironmentId) return;
    const name = explicitName?.trim() || basenameOfPath(normalized);
    onAddCustomRepo({ name, cwd: normalized, environmentId: defaultEnvironmentId });
    const scopeId = buildRepoScopeId(defaultEnvironmentId, normalized);
    if (!selectedSet.has(scopeId)) {
      onToggleScope(scopeId);
    }
    setCustomPath("");
    setCustomName("");
    setAddingCustom(false);
  };

  const handlePickNativeFolder = async () => {
    const localApi = readLocalApi();
    if (!localApi || isPickingNative) return;
    setIsPickingNative(true);
    try {
      const initialPath =
        normalizeRepoCwd(customPath) ||
        (defaultBrowseCwd
          ? (getBrowseParentPath(defaultBrowseCwd) ?? defaultBrowseCwd)
          : undefined);
      const picked = await localApi.dialogs.pickFolder(initialPath ? { initialPath } : undefined);
      if (picked) {
        addRepoByPath(picked, customName);
      }
    } finally {
      setIsPickingNative(false);
    }
  };

  const originLabel = (origin: ExplorerRepoScope["origin"]) => {
    switch (origin) {
      case "custom":
        return gt("Custom");
      case "ct-repos":
        return "repos/";
      case "project":
        return gt("Project");
    }
  };

  return (
    <div
      style={desktopHeaderStyle}
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3",
        desktopHeaderClassName,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <div className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-foreground">
          <Code2Icon className="size-4 text-primary" />
          <span>
            <T>Code Explorer</T>
          </span>
        </div>

        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border/80" />

        <Popover open={popoverOpen} onOpenChange={handlePopoverOpenChange}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={gt("Manage search repository scopes")}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors",
                  popoverOpen
                    ? "border-primary/70 bg-primary/15 text-foreground"
                    : "border-border bg-muted/35 text-foreground hover:bg-muted/70",
                )}
              />
            }
          >
            <LayersIcon className="size-3.5 text-primary" />
            <span>
              <T>Scopes</T>
            </span>
            <span className="rounded bg-background/80 px-1 py-0.5 font-mono text-3xs tabular-nums text-muted-foreground">
              {selectedScopes.length}/{scopes.length}
            </span>
            <ChevronDownIcon className="size-3 text-muted-foreground" />
          </PopoverTrigger>

          <PopoverPopup
            align="start"
            side="bottom"
            sideOffset={6}
            padding="none"
            data-code-explorer-allow-tab
            data-code-explorer-escape-handled="true"
            className="w-[min(32rem,calc(100vw-2rem))]"
          >
            <div className="flex flex-col">
              {/* Search & bulk actions */}
              <div className="space-y-2 border-b border-border/70 p-2.5">
                <div className="relative flex items-center">
                  <SearchIcon className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    autoFocus={!addingCustom}
                    value={scopeQuery}
                    onChange={(event) => setScopeQuery(event.target.value)}
                    placeholder={gt("Filter repositories by name or path...")}
                    aria-label={gt("Filter repositories")}
                    className="h-8 w-full rounded-md border border-border bg-background pr-7 pl-8 text-xs text-foreground outline-none focus:border-primary"
                  />
                  {scopeQuery ? (
                    <button
                      type="button"
                      aria-label={gt("Clear repository filter")}
                      onClick={() => setScopeQuery("")}
                      className="absolute right-1.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <XIcon className="size-3" />
                    </button>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-2xs">
                  <span className="text-muted-foreground">
                    {gt("{selected} selected · {total} repos", {
                      selected: selectedScopes.length,
                      total: scopes.length,
                    })}
                  </span>

                  <div className="flex items-center gap-1">
                    {scopes.length > 0 ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost-muted"
                        onClick={onSelectAllBusinessScopes}
                      >
                        <T>All repos</T>
                      </Button>
                    ) : null}
                    {selectedScopes.length > 0 ? (
                      <Button type="button" size="xs" variant="ghost-muted" onClick={onClearScopes}>
                        <T>Clear</T>
                      </Button>
                    ) : null}
                    {defaultEnvironmentId ? (
                      <Button
                        type="button"
                        size="xs"
                        variant={addingCustom ? "secondary" : "ghost-muted"}
                        onClick={toggleAddRepoInsidePopover}
                      >
                        <FolderPlusIcon className="size-3.5" />
                        <span>
                          <T>Add repo</T>
                        </span>
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Inline Add Repo form + directory browser */}
              {addingCustom && defaultEnvironmentId ? (
                <div className="space-y-2 border-b border-border/70 bg-muted/20 p-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {canPickNativeFolder ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        disabled={isPickingNative}
                        onClick={() => {
                          void handlePickNativeFolder();
                        }}
                      >
                        <FolderOpenIcon className="size-3.5" />
                        <span>
                          <T>Browse...</T>
                        </span>
                      </Button>
                    ) : null}
                    <input
                      type="text"
                      autoFocus
                      value={customPath}
                      onChange={(event) => setCustomPath(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addRepoByPath(customPath, customName);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setAddingCustom(false);
                        }
                      }}
                      placeholder={gt("/absolute/path/to/repo")}
                      aria-label={gt("Repository absolute path")}
                      className="h-7 min-w-48 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                    />
                  </div>

                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={customName}
                      onChange={(event) => setCustomName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addRepoByPath(customPath, customName);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setAddingCustom(false);
                        }
                      }}
                      placeholder={gt("Display name (optional)")}
                      aria-label={gt("Repository display name")}
                      className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
                    />
                    <Button
                      type="button"
                      size="xs"
                      variant="default"
                      disabled={!customPath.trim()}
                      onClick={() => addRepoByPath(customPath, customName)}
                    >
                      <T>Add</T>
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => setAddingCustom(false)}
                    >
                      <T>Cancel</T>
                    </Button>
                  </div>

                  {browsePath.isBrowsing ? (
                    <div className="max-h-44 overflow-y-auto rounded-md border border-border/70 bg-background">
                      <div className="flex items-center justify-between border-b border-border/60 bg-muted/25 px-2 py-1 text-3xs text-muted-foreground">
                        <span className="truncate font-mono">
                          {browseQuery.data?.parentPath ?? browsePath.directoryPath}
                        </span>
                        {browseQuery.isPending ? (
                          <Loader2Icon className="size-3 animate-spin" />
                        ) : null}
                      </div>

                      {parentBrowsePath ? (
                        <button
                          type="button"
                          onClick={() => setCustomPath(parentBrowsePath)}
                          className="flex w-full items-center gap-2 border-b border-border/40 px-2.5 py-1 text-left font-mono text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        >
                          <ArrowUpIcon className="size-3.5 shrink-0" />
                          <span>..</span>
                        </button>
                      ) : null}

                      {visibleEntries.length === 0 && !browseQuery.isPending ? (
                        <div className="px-2.5 py-2 text-xs text-muted-foreground">
                          <T>No matching subfolders in this directory.</T>
                        </div>
                      ) : (
                        visibleEntries.slice(0, MAX_BROWSE_SUGGESTIONS).map((entry) => (
                          <div
                            key={entry.fullPath}
                            className="flex items-center justify-between gap-2 border-b border-border/30 px-2 py-1 last:border-b-0 hover:bg-muted/40"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setCustomPath(ensureBrowseDirectoryPath(entry.fullPath))
                              }
                              className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-foreground"
                            >
                              <FolderIcon className="size-3.5 shrink-0 text-warning" />
                              <span className="truncate font-mono">{entry.name}</span>
                            </button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost-muted"
                              onClick={() => addRepoByPath(entry.fullPath)}
                            >
                              <PlusIcon className="size-3" />
                              <span>
                                <T>Select</T>
                              </span>
                            </Button>
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Scrollable repository list */}
              <div className="max-h-80 overflow-y-auto p-1.5">
                {filteredScopes.length === 0 ? (
                  <div className="px-2.5 py-6 text-center text-xs text-muted-foreground">
                    {scopeQuery.trim() ? (
                      <T>No repositories match your filter.</T>
                    ) : (
                      <T>No repositories available yet. Click Add repo to pick a folder.</T>
                    )}
                  </div>
                ) : (
                  filteredScopes.map((scope) => {
                    const selected = selectedSet.has(scope.id);
                    return (
                      <div
                        key={scope.id}
                        className={cn(
                          "group flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors",
                          selected ? "bg-primary/10 hover:bg-primary/15" : "hover:bg-muted/55",
                        )}
                      >
                        <button
                          type="button"
                          onClick={(event) => {
                            if (event.altKey) {
                              onSelectOnlyScope(scope.id);
                            } else {
                              onToggleScope(scope.id);
                            }
                          }}
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                              selected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-background",
                            )}
                          >
                            {selected ? <CheckIcon className="size-3" /> : null}
                          </span>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              {scope.isCtStudioRoot ? (
                                <AlertTriangleIcon className="size-3 shrink-0 text-warning" />
                              ) : null}
                              <span
                                className={cn(
                                  "truncate text-xs",
                                  selected ? "font-medium text-foreground" : "text-foreground/90",
                                )}
                              >
                                {scope.name}
                              </span>
                              <span className="shrink-0 rounded bg-muted px-1 py-px text-3xs text-muted-foreground">
                                {originLabel(scope.origin)}
                              </span>
                            </div>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <div className="truncate font-mono text-3xs text-muted-foreground" />
                                }
                              >
                                {scope.cwd}
                              </TooltipTrigger>
                              <TooltipPopup side="bottom">
                                <span className="font-mono text-2xs">{scope.cwd}</span>
                              </TooltipPopup>
                            </Tooltip>
                            {scope.isCtStudioRoot ? (
                              <div className="mt-0.5 text-3xs text-warning">
                                <T>
                                  Contains worktrees/ which may return duplicate search matches.
                                </T>
                              </div>
                            ) : null}
                          </div>
                        </button>

                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => onSelectOnlyScope(scope.id)}
                            className="rounded px-1.5 py-0.5 text-3xs font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                          >
                            <T>Only</T>
                          </button>
                          {scope.origin === "custom" ? (
                            <button
                              type="button"
                              aria-label={gt("Remove {name}", { name: scope.name })}
                              onClick={() => onRemoveCustomRepo(scope.cwd)}
                              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              <XIcon className="size-3" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}

                {isDiscovering ? (
                  <div className="flex items-center gap-1.5 px-2.5 py-2 text-2xs text-muted-foreground">
                    <Loader2Icon className="size-3 animate-spin" />
                    <span>
                      <T>Discovering repos...</T>
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </PopoverPopup>
        </Popover>

        {/* Bounded single-row preview of currently selected scopes */}
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {visibleChips.length === 0 ? (
            <button
              type="button"
              onClick={() => setPopoverOpen(true)}
              className="truncate rounded-md border border-dashed border-border/80 px-2 py-0.5 text-xs text-muted-foreground hover:border-border hover:text-foreground"
            >
              {isDiscovering ? <T>Discovering repos...</T> : <T>Select repos to search</T>}
            </button>
          ) : (
            visibleChips.map((scope) => (
              <Tooltip key={scope.id}>
                <TooltipTrigger
                  render={
                    <div className="inline-flex min-w-0 max-w-44 shrink-0 items-center rounded-md border border-primary/55 bg-primary/15 text-xs font-medium text-foreground" />
                  }
                >
                  <button
                    type="button"
                    onClick={(event) => {
                      if (event.altKey) {
                        onSelectOnlyScope(scope.id);
                      } else {
                        setPopoverOpen(true);
                      }
                    }}
                    className="flex min-w-0 items-center gap-1 py-0.5 pr-1 pl-2 text-left"
                  >
                    {scope.isCtStudioRoot ? (
                      <AlertTriangleIcon className="size-3 shrink-0 text-warning" />
                    ) : (
                      <CheckIcon className="size-3 shrink-0 text-primary" />
                    )}
                    <span className="truncate">{scope.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={gt("Deselect {name}", { name: scope.name })}
                    onClick={() => onToggleScope(scope.id)}
                    className="mr-0.5 rounded p-0.5 text-muted-foreground hover:bg-primary/20 hover:text-foreground"
                  >
                    <XIcon className="size-2.5" />
                  </button>
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  <div className="space-y-0.5 text-xs">
                    <div className="font-mono text-2xs">{scope.cwd}</div>
                    <div className="text-2xs text-muted-foreground">
                      <T>Click to manage scopes, Option+Click for only this repo, × to remove</T>
                    </div>
                  </div>
                </TooltipPopup>
              </Tooltip>
            ))
          )}

          {overflowCount > 0 ? (
            <button
              type="button"
              onClick={() => setPopoverOpen(true)}
              className="inline-flex h-6 shrink-0 items-center rounded-md border border-border/80 bg-muted/40 px-1.5 font-mono text-2xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              +{overflowCount}
            </button>
          ) : null}
        </div>

        {defaultEnvironmentId ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant={popoverOpen && addingCustom ? "secondary" : "ghost-muted"}
                  className="shrink-0"
                  onClick={openAddRepoPanel}
                />
              }
            >
              <FolderPlusIcon className="size-3.5" />
              <span className="hidden sm:inline">
                <T>Add repo</T>
              </span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {gt("Browse or add any local repository folder to your search scopes")}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>

      <Button
        type="button"
        size="xs"
        variant="ghost-muted"
        aria-label={gt("Close Code Explorer")}
        className="shrink-0"
        onClick={onClose}
      >
        <XIcon className="size-3.5" />
        <span>
          <T>Close</T>
        </span>
      </Button>
    </div>
  );
}
