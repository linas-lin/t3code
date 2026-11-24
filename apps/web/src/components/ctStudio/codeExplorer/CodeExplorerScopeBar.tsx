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
  Code2Icon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  Loader2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "~/localApi";
import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";

import { getEnvironmentBrowsePlatform } from "../../CommandPalette.logic";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { basenameOfPath, buildRepoScopeId, normalizeRepoCwd } from "./repoScope.logic";
import type { ExplorerRepoScope } from "./types";

const MAX_BROWSE_SUGGESTIONS = 40;

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
  const [addingCustom, setAddingCustom] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const [customName, setCustomName] = useState("");
  const [isPickingNative, setIsPickingNative] = useState(false);

  const selectedSet = new Set(selectedScopeIds);
  const canPickNativeFolder = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const browsePlatform = getEnvironmentBrowsePlatform(platformOs ?? undefined);
  const browsePath = getFilesystemBrowsePath(
    customPath,
    browsePlatform,
    addingCustom && defaultEnvironmentId !== null,
  );

  const browseQuery = useEnvironmentQuery(
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

  const openAddRepoPanel = () => {
    if (addingCustom) {
      setAddingCustom(false);
      return;
    }
    if (!customPath.trim() && defaultBrowseCwd) {
      const initialDir =
        getBrowseParentPath(defaultBrowseCwd) ?? ensureBrowseDirectoryPath(defaultBrowseCwd);
      setCustomPath(initialDir);
    }
    setAddingCustom(true);
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

  return (
    <div className="shrink-0 border-b border-border bg-background px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <div className="mr-1 flex shrink-0 items-center gap-1.5 text-xs font-semibold text-foreground">
            <Code2Icon className="size-4 text-primary" />
            <span>
              <T>Code Explorer</T>
            </span>
          </div>

          <span className="text-2xs text-muted-foreground">
            <T>Scopes:</T>
          </span>

          {scopes.map((scope) => {
            const selected = selectedSet.has(scope.id);
            return (
              <Tooltip key={scope.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={(event) => {
                        if (event.altKey) {
                          onSelectOnlyScope(scope.id);
                        } else {
                          onToggleScope(scope.id);
                        }
                      }}
                      className={[
                        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors",
                        selected
                          ? "border-primary/60 bg-primary/15 font-medium text-foreground"
                          : "border-border/80 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground",
                      ].join(" ")}
                    />
                  }
                >
                  {selected ? (
                    <CheckIcon className="size-3 shrink-0 text-primary" />
                  ) : scope.isCtStudioRoot ? (
                    <AlertTriangleIcon className="size-3 shrink-0 text-warning" />
                  ) : null}
                  <span className="max-w-44 truncate">{scope.name}</span>
                  {scope.origin === "custom" ? (
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={gt("Remove {name}", { name: scope.name })}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveCustomRepo(scope.cwd);
                      }}
                      className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <XIcon className="size-2.5" />
                    </span>
                  ) : null}
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  <div className="space-y-0.5 text-xs">
                    <div className="font-mono text-2xs">{scope.cwd}</div>
                    {scope.isCtStudioRoot ? (
                      <div className="text-2xs text-warning">
                        <T>
                          Warning: ct-studio root contains worktrees/ which may return duplicate
                          matches.
                        </T>
                      </div>
                    ) : (
                      <div className="text-2xs text-muted-foreground">
                        <T>Click to toggle, Option+Click to search only this repo</T>
                      </div>
                    )}
                  </div>
                </TooltipPopup>
              </Tooltip>
            );
          })}

          {isDiscovering ? (
            <span className="text-2xs text-muted-foreground">
              <T>Discovering repos...</T>
            </span>
          ) : null}

          {defaultEnvironmentId ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="xs"
                    variant={addingCustom ? "secondary" : "ghost-muted"}
                    onClick={openAddRepoPanel}
                  />
                }
              >
                <FolderPlusIcon className="size-3.5" />
                <span>
                  <T>Add repo</T>
                </span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {gt("Browse or add any local repository folder to your search scopes")}
              </TooltipPopup>
            </Tooltip>
          ) : null}

          {scopes.length > 1 ? (
            <div className="flex items-center gap-1 pl-1">
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                onClick={onSelectAllBusinessScopes}
              >
                <T>All repos</T>
              </Button>
              {selectedScopeIds.length > 0 ? (
                <Button type="button" size="xs" variant="ghost-muted" onClick={onClearScopes}>
                  <T>Clear</T>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-label={gt("Close Code Explorer")}
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
          <span>
            <T>Close</T>
          </span>
        </Button>
      </div>

      {addingCustom ? (
        <div
          data-code-explorer-allow-tab
          data-code-explorer-escape-handled="true"
          className="mt-2 space-y-2 rounded-md border border-border/70 bg-muted/20 p-2"
        >
          <div className="flex flex-wrap items-center gap-2">
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
              className="h-7 min-w-64 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
            />
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
              className="h-7 w-44 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
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

          {/* Local directory browser (works in both Web and Desktop) */}
          {browsePath.isBrowsing ? (
            <div className="max-h-48 overflow-y-auto rounded-md border border-border/70 bg-background">
              <div className="flex items-center justify-between border-b border-border/60 bg-muted/25 px-2 py-1 text-3xs text-muted-foreground">
                <span className="truncate font-mono">
                  {browseQuery.data?.parentPath ?? browsePath.directoryPath}
                </span>
                {browseQuery.isPending ? <Loader2Icon className="size-3 animate-spin" /> : null}
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
                      onClick={() => setCustomPath(ensureBrowseDirectoryPath(entry.fullPath))}
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
    </div>
  );
}
