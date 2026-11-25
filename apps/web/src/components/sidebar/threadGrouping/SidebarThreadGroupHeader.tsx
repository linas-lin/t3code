import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ContextMenuSource } from "@t3tools/contracts";
import { useDroppable } from "@dnd-kit/core";
import { ChevronDownIcon, FolderIcon, FolderOpenIcon, SquarePenIcon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../../contextMenuSource";
import { useUiStateStore } from "../../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../../Sidebar.logic";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

const GROUP_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const GROUP_DOT_LABEL = {
  attention: msg(", needs you", { $context: "thread group status, read after its name" }),
  failed: msg(", failed", { $context: "thread group status, read after its name" }),
  unread: msg(", done", { $context: "thread group status, read after its name" }),
  working: msg(", working", { $context: "thread group status, read after its name" }),
} as const;

export const SidebarThreadGroupHeader = memo(function SidebarThreadGroupHeader(props: {
  readonly projectKey: string;
  readonly groupName: string;
  readonly rowId: string;
  readonly dropId: string;
  readonly nested?: boolean;
  readonly collapsed: boolean;
  readonly totalCount: number;
  readonly hiddenThreads: readonly EnvironmentThreadShell[];
  readonly isDropTarget?: boolean;
  readonly onToggle: () => void;
  readonly onNewThread: () => void;
  readonly onContextMenu: (position: { x: number; y: number }, source: ContextMenuSource) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { setNodeRef, isOver } = useDroppable({ id: props.dropId });
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = props.collapsed
    ? resolveSidebarFolderDot(
        props.hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  const highlighted = isOver || props.isDropTarget === true;

  return (
    <li
      ref={setNodeRef}
      data-testid="sidebar-thread-group"
      data-thread-group-name={props.groupName}
      data-thread-group-project={props.projectKey}
      className={cn(
        "group/thread-group relative list-none",
        props.nested ? "mt-0.5 pl-3" : "mt-1.5 first:mt-0",
      )}
    >
      <button
        type="button"
        data-sidebar-row={props.rowId}
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu({ x: event.clientX, y: event.clientY }, contextMenuSourceOf(event));
        }}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          highlighted && "bg-sidebar-row-hover ring-1 ring-inset ring-primary/60",
        )}
      >
        {props.collapsed ? (
          <FolderIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        ) : (
          <FolderOpenIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-foreground/85">
          {props.groupName}
        </span>
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", GROUP_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{m(GROUP_DOT_LABEL[dot])}</span>
          </span>
        ) : null}
        {props.collapsed && props.totalCount > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/thread-group:invisible group-has-[[data-sidebar-action-for]:focus]/thread-group:invisible pointer-coarse:invisible">
            {props.totalCount}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            props.collapsed && "-rotate-90",
          )}
        />
      </button>
      <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/thread-group:opacity-100 pointer-coarse:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                data-sidebar-action-for={props.rowId}
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("New thread in {group}", { group: props.groupName })}
                onClick={props.onNewThread}
              />
            }
          >
            <SquarePenIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>
            <T>
              New thread in <Var>{props.groupName}</Var>
            </T>
          </TooltipPopup>
        </Tooltip>
      </span>
    </li>
  );
});

export const SidebarUngroupedDropZone = memo(function SidebarUngroupedDropZone(props: {
  readonly dropId: string;
  readonly visible: boolean;
  readonly nested?: boolean;
}) {
  const gt = useGT();
  const { setNodeRef, isOver } = useDroppable({ id: props.dropId });
  if (!props.visible) return null;
  return (
    <li
      ref={setNodeRef}
      data-testid="sidebar-ungrouped-drop-zone"
      className={cn("mt-1 list-none", props.nested ? "pl-3" : undefined)}
    >
      <div
        className={cn(
          "flex h-7 items-center rounded-(--control-radius) border border-dashed px-(--sidebar-row-content-inset) text-xs transition-colors",
          isOver
            ? "border-primary bg-primary/10 text-sidebar-foreground"
            : "border-sidebar-border/70 text-sidebar-muted-foreground",
        )}
      >
        {gt("Drop here to remove from group")}
      </div>
    </li>
  );
});
