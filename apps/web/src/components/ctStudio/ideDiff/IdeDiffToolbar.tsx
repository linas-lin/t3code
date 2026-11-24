import { T, useGT } from "gt-react";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleIcon,
  Columns2Icon,
  CopyIcon,
  ExternalLinkIcon,
  FoldVerticalIcon,
  LayoutPanelLeftIcon,
  Maximize2Icon,
  MessageSquareIcon,
  Minimize2Icon,
  PanelLeftIcon,
  PilcrowIcon,
  Rows3Icon,
  SearchIcon,
  TextWrapIcon,
  UnfoldVerticalIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type {
  IdeDiffChangeNavigationState,
  IdeDiffFileEntry,
  IdeDiffFileStatus,
  IdeDiffViewMode,
} from "./types";

export interface IdeDiffToolbarProps {
  readonly entry: IdeDiffFileEntry | null;
  readonly fileIndex: number;
  readonly fileCount: number;
  readonly viewed: boolean;
  readonly onToggleViewed: () => void;
  readonly onMarkViewedAndNext?: () => void;
  readonly changeNav: IdeDiffChangeNavigationState;
  readonly onPrevChange: () => void;
  readonly onNextChange: () => void;
  readonly onPrevFile: () => void;
  readonly onNextFile: () => void;
  readonly treeOpen: boolean;
  readonly onToggleTree: () => void;
  readonly viewMode: IdeDiffViewMode;
  readonly onViewModeChange: (mode: IdeDiffViewMode) => void;
  readonly collapseUnchanged: boolean;
  readonly onCollapseUnchangedChange: (collapse: boolean) => void;
  readonly ignoreWhitespace: boolean;
  readonly onIgnoreWhitespaceChange: (ignore: boolean) => void;
  readonly wordWrap: boolean;
  readonly onWordWrapChange: (wrap: boolean) => void;
  readonly onFocusFind: () => void;
  readonly onOpenExternal?: (() => void) | undefined;
  readonly fullscreen: boolean;
  readonly onToggleFullscreen: () => void;
  readonly onSwitchToClassic?: (() => void) | undefined;
  readonly pendingCommentCount?: number | undefined;
  readonly onFocusComposer?: (() => void) | undefined;
  readonly isNarrow: boolean;
}

const STATUS_BADGE: Record<
  IdeDiffFileStatus,
  { readonly letter: string; readonly className: string }
> = {
  modified: { letter: "M", className: "bg-info/15 text-info" },
  added: { letter: "A", className: "bg-diff-addition/25 text-diff-addition-foreground" },
  deleted: { letter: "D", className: "bg-diff-deletion/25 text-diff-deletion-foreground" },
  renamed: { letter: "R", className: "bg-guest/15 text-guest" },
  copied: { letter: "C", className: "bg-primary/15 text-primary" },
};

export function IdeDiffToolbar({
  entry,
  fileIndex,
  fileCount,
  viewed,
  onToggleViewed,
  onMarkViewedAndNext,
  changeNav,
  onPrevChange,
  onNextChange,
  onPrevFile,
  onNextFile,
  treeOpen,
  onToggleTree,
  viewMode,
  onViewModeChange,
  collapseUnchanged,
  onCollapseUnchangedChange,
  ignoreWhitespace,
  onIgnoreWhitespaceChange,
  wordWrap,
  onWordWrapChange,
  onFocusFind,
  onOpenExternal,
  fullscreen,
  onToggleFullscreen,
  onSwitchToClassic,
  pendingCommentCount = 0,
  onFocusComposer,
  isNarrow,
}: IdeDiffToolbarProps) {
  const gt = useGT();
  const [copied, setCopied] = useState(false);

  const copyPath = () => {
    if (!entry || typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(entry.path).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const badge = entry ? STATUS_BADGE[entry.status] : null;
  const changeLabel =
    changeNav.totalCount > 0
      ? `${Math.max(0, changeNav.currentIndex) + 1}/${changeNav.totalCount}`
      : "0/0";
  const fileLabel = fileCount > 0 ? `${Math.max(0, fileIndex) + 1}/${fileCount}` : "0/0";

  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-muted/20 px-2">
      {/* Left: file tree toggle + active file path + viewed toggle */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant={treeOpen ? "secondary" : "ghost-muted"}
                aria-label={treeOpen ? gt("Hide file tree") : gt("Show file tree")}
                onClick={onToggleTree}
              />
            }
          >
            <PanelLeftIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {treeOpen ? gt("Hide file tree") : gt("Show file tree")}
          </TooltipPopup>
        </Tooltip>

        {entry && badge ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={`inline-flex size-4 shrink-0 items-center justify-center rounded font-mono text-3xs font-semibold ${badge.className}`}
            >
              {badge.letter}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={<span className="min-w-0 truncate font-mono text-xs text-foreground" />}
              >
                {entry.previousPath ? `${entry.previousPath} → ${entry.path}` : entry.path}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {entry.previousPath ? `${entry.previousPath} → ${entry.path}` : entry.path}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("Copy file path")}
                    onClick={copyPath}
                  />
                }
              >
                {copied ? (
                  <CheckIcon className="size-3 text-success" />
                ) : (
                  <CopyIcon className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {copied ? gt("Copied") : gt("Copy file path")}
              </TooltipPopup>
            </Tooltip>
          </div>
        ) : (
          <span className="truncate text-xs text-muted-foreground">
            <T>No file selected</T>
          </span>
        )}
      </div>

      {/* Right: pending comments + IDEA change/file nav + viewed + view toggles + fullscreen */}
      <div className="flex shrink-0 items-center gap-1">
        {pendingCommentCount > 0 && onFocusComposer && !fullscreen ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  aria-label={gt("Focus chat composer to send {count} review comments", {
                    count: pendingCommentCount,
                  })}
                  onClick={onFocusComposer}
                />
              }
            >
              <MessageSquareIcon className="size-3.5 text-primary" />
              <span className="font-mono text-2xs tabular-nums">{pendingCommentCount}</span>
              <span className="hidden md:inline">
                <T>Send</T>
              </span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {gt(
                "{count} review comments queued in chat composer. Click to focus composer and send to agent.",
                { count: pendingCommentCount },
              )}
            </TooltipPopup>
          </Tooltip>
        ) : null}

        {entry ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant={viewed ? "secondary" : "ghost-muted"}
                  aria-pressed={viewed}
                  onClick={(event) => {
                    if (event.shiftKey && onMarkViewedAndNext) {
                      onMarkViewedAndNext();
                    } else {
                      onToggleViewed();
                    }
                  }}
                />
              }
            >
              {viewed ? (
                <CheckCircle2Icon className="size-3.5 text-success" />
              ) : (
                <CircleIcon className="size-3.5" />
              )}
              <span className="hidden sm:inline">
                <T>Viewed</T>
              </span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {gt("Toggle viewed (V). Shift+V marks viewed and jumps to next unviewed file.")}
            </TooltipPopup>
          </Tooltip>
        ) : null}

        <div className="mx-0.5 h-3.5 w-px bg-border/70" />

        {/* Next / Prev Change (F7 / Shift+F7) */}
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={fileCount === 0}
                  aria-label={gt("Previous change")}
                  onClick={onPrevChange}
                />
              }
            >
              <ArrowUpIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{gt("Previous change (Shift+F7 / Alt+↑)")}</TooltipPopup>
          </Tooltip>
          <span className="min-w-8 text-center font-mono text-3xs tabular-nums text-muted-foreground">
            {changeLabel}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={fileCount === 0}
                  aria-label={gt("Next change")}
                  onClick={onNextChange}
                />
              }
            >
              <ArrowDownIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{gt("Next change (F7 / Alt+↓)")}</TooltipPopup>
          </Tooltip>
        </div>

        {/* Next / Prev File (Alt+Left / Alt+Right) */}
        {!isNarrow ? (
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={fileCount <= 1}
                    aria-label={gt("Previous file")}
                    onClick={onPrevFile}
                  />
                }
              >
                <ArrowLeftIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">{gt("Previous file (Alt+←)")}</TooltipPopup>
            </Tooltip>
            <span className="min-w-8 text-center font-mono text-3xs tabular-nums text-muted-foreground">
              {fileLabel}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={fileCount <= 1}
                    aria-label={gt("Next file")}
                    onClick={onNextFile}
                  />
                }
              >
                <ArrowRightIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">{gt("Next file (Alt+→)")}</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}

        <div className="mx-0.5 h-3.5 w-px bg-border/70" />

        {/* Split / Unified */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={
                  viewMode === "split"
                    ? gt("Switch to unified diff")
                    : gt("Switch to side-by-side diff")
                }
                onClick={() => onViewModeChange(viewMode === "split" ? "unified" : "split")}
              />
            }
          >
            {viewMode === "split" ? (
              <Columns2Icon className="size-3.5" />
            ) : (
              <Rows3Icon className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {viewMode === "split"
              ? gt("Side-by-side (click for Unified)")
              : gt("Unified (click for Side-by-side)")}
          </TooltipPopup>
        </Tooltip>

        {/* Collapse unchanged regions */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant={collapseUnchanged ? "secondary" : "ghost-muted"}
                aria-label={
                  collapseUnchanged ? gt("Expand full file") : gt("Collapse unchanged lines")
                }
                onClick={() => onCollapseUnchangedChange(!collapseUnchanged)}
              />
            }
          >
            {collapseUnchanged ? (
              <FoldVerticalIcon className="size-3.5" />
            ) : (
              <UnfoldVerticalIcon className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {collapseUnchanged
              ? gt("Unchanged lines collapsed (click to show full file)")
              : gt("Showing full file (click to collapse unchanged lines)")}
          </TooltipPopup>
        </Tooltip>

        {/* Find inside file */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Find in file")}
                onClick={onFocusFind}
              />
            }
          >
            <SearchIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{gt("Find in file (⌘F / Ctrl+F)")}</TooltipPopup>
        </Tooltip>

        {/* Whitespace & Wrap (shown when not ultra-narrow) */}
        {!isNarrow ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant={ignoreWhitespace ? "secondary" : "ghost-muted"}
                    aria-label={
                      ignoreWhitespace
                        ? gt("Show whitespace changes")
                        : gt("Hide whitespace changes")
                    }
                    onClick={() => onIgnoreWhitespaceChange(!ignoreWhitespace)}
                  />
                }
              >
                <PilcrowIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {ignoreWhitespace ? gt("Show whitespace changes") : gt("Ignore whitespace changes")}
              </TooltipPopup>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant={wordWrap ? "secondary" : "ghost-muted"}
                    aria-label={wordWrap ? gt("Disable word wrap") : gt("Enable word wrap")}
                    onClick={() => onWordWrapChange(!wordWrap)}
                  />
                }
              >
                <TextWrapIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {wordWrap ? gt("Disable line wrapping") : gt("Enable line wrapping")}
              </TooltipPopup>
            </Tooltip>
          </>
        ) : null}

        {onOpenExternal && entry ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={gt("Open in external editor")}
                  onClick={onOpenExternal}
                />
              }
            >
              <ExternalLinkIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{gt("Open in external editor")}</TooltipPopup>
          </Tooltip>
        ) : null}

        {/* Fullscreen Overlay */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant={fullscreen ? "secondary" : "ghost-muted"}
                aria-label={fullscreen ? gt("Exit fullscreen review") : gt("Fullscreen review")}
                onClick={onToggleFullscreen}
              />
            }
          >
            {fullscreen ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {fullscreen ? gt("Exit fullscreen review (Esc)") : gt("Expand fullscreen IDE review")}
          </TooltipPopup>
        </Tooltip>

        {onSwitchToClassic ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={gt("Switch to classic diff view")}
                  onClick={onSwitchToClassic}
                />
              }
            >
              <LayoutPanelLeftIcon className="size-3.5 text-primary" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {gt("IDE Diff active (click to switch to Classic view)")}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
