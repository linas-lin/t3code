import { T, useGT } from "gt-react";
import { CompassIcon, Link2Icon, Loader2Icon, XIcon } from "lucide-react";

import { Button } from "../../ui/button";
import type { ExplorerDrawerState, SymbolLocation } from "./types";

export interface CodeExplorerResultsDrawerProps {
  readonly drawer: ExplorerDrawerState | null;
  readonly onSelectLocation: (location: SymbolLocation) => void;
  readonly onClose: () => void;
}

export function CodeExplorerResultsDrawer({
  drawer,
  onSelectLocation,
  onClose,
}: CodeExplorerResultsDrawerProps) {
  const gt = useGT();
  if (!drawer) return null;

  return (
    <div
      data-code-explorer-drawer
      className="flex h-56 shrink-0 flex-col border-t border-border bg-background"
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/60 bg-muted/25 px-3">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
          {drawer.kind === "definitions" ? (
            <CompassIcon className="size-3.5 shrink-0 text-primary" />
          ) : (
            <Link2Icon className="size-3.5 shrink-0 text-info" />
          )}
          <span className="truncate">
            {drawer.kind === "definitions"
              ? gt("Definitions of {symbol}", { symbol: drawer.symbol })
              : gt("Usages of {symbol}", { symbol: drawer.symbol })}
          </span>
          {!drawer.loading ? (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs tabular-nums text-muted-foreground">
              {drawer.locations.length}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label={gt("Close references panel")}
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {drawer.loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            <span>
              {drawer.kind === "definitions" ? (
                <T>Searching definitions across selected repositories...</T>
              ) : (
                <T>Searching usages across selected repositories...</T>
              )}
            </span>
          </div>
        ) : drawer.error ? (
          <div className="flex h-full items-center justify-center px-4 text-xs text-error">
            {drawer.error}
          </div>
        ) : drawer.locations.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-xs text-muted-foreground">
            {drawer.kind === "definitions" ? (
              <T>No declarations found in the selected repositories.</T>
            ) : (
              <T>No usages found in the selected repositories.</T>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {drawer.locations.map((loc) => (
              <button
                key={loc.id}
                type="button"
                onClick={() => onSelectLocation(loc)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
              >
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                  {loc.repoName}
                </span>
                <span className="max-w-72 shrink-0 truncate font-mono text-2xs text-foreground">
                  {loc.relativePath}:{loc.lineNumber}
                </span>
                {loc.kind === "definition" ? (
                  <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 font-mono text-3xs text-primary">
                    <T>decl</T>
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
                  {loc.previewLine}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
