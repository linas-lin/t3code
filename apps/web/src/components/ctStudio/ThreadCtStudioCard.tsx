import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CornerDownLeftIcon,
  InboxIcon,
  LayoutGridIcon,
  ListTodoIcon,
  Maximize2Icon,
  PinIcon,
} from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useChatCanvas } from "../chat/ChatCanvasContext";
import {
  resolveThreadCtStudioLink,
  type CtStudioThreadLinkInfo,
  type CtStudioWatchedInboxItem,
  type CtStudioWatchedTaskItem,
} from "./ctStudioBridge";
import { useCtStudioStore } from "./ctStudioStore";

const STAGE_LABELS: Record<string, string> = {
  handoff: "Handoff",
  analysis: "简单分析",
  design: "Design",
  tasks: "任务拆分",
  coding: "开发",
  test: "测试",
  ship: "交付",
  grill: "Grill",
};

function stageDisplayLabel(stage: string | undefined): string | null {
  if (!stage) return null;
  return STAGE_LABELS[stage] ?? stage;
}

function statusDotClass(status: "working" | "blocked" | "done" | "idle" | undefined): string {
  if (status === "blocked") return "bg-warning";
  if (status === "working") return "bg-primary";
  return "bg-muted-foreground/40";
}

function useCtStudioNavigation() {
  const navigate = useNavigate();
  const openCtStudioModal = useCtStudioStore((state) => state.openModal);

  const openCtStudio = (target?: {
    ticket?: string | undefined;
    stage?: string | undefined;
    itemId?: string | undefined;
  }) => {
    void navigate({
      to: "/ct-studio",
      search: {
        ...(target?.ticket ? { ticket: target.ticket } : {}),
        ...(target?.stage ? { stage: target.stage } : {}),
        ...(target?.itemId ? { itemId: target.itemId } : {}),
      },
    });
  };

  const openThread = (threadId: string, environmentId: string) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
      ),
    });
  };

  return { openCtStudio, openCtStudioModal, openThread };
}

function LinkDestinationButton({
  link,
  inherited,
  compact = false,
  onOpen,
}: {
  link: CtStudioThreadLinkInfo;
  inherited: boolean;
  compact?: boolean;
  onOpen: () => void;
}) {
  const gt = useGT();
  const isInbox = link.kind === "inbox";
  const stageText = !isInbox ? stageDisplayLabel(link.stage) : null;
  const primaryLabel = isInbox ? link.source : link.ticketKey;
  const detailText = isInbox ? link.title : (link.summary ?? link.status ?? "");

  if (compact) {
    return (
      <div
        data-ct-studio-popover-row
        className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <LayoutGridIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono text-xs font-medium text-foreground">
            {primaryLabel}
          </span>
          {stageText ? (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
              {stageText}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <span>{isInbox ? gt("Inbox") : gt("Task")}</span>
          <ArrowUpRightIcon className="size-3" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div
      data-ct-studio-current-source
      className="mx-2.5 mb-2 flex items-start justify-between gap-2 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 font-mono text-3xs font-semibold text-foreground">
            {isInbox ? (
              <InboxIcon className="size-2.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <ListTodoIcon className="size-2.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span>{primaryLabel}</span>
          </span>
          {stageText ? (
            <span className="rounded bg-accent/80 px-1.5 py-0.5 text-3xs font-medium text-foreground">
              {stageText}
            </span>
          ) : null}
          {!isInbox && link.task ? (
            <span className="font-mono text-3xs text-muted-foreground">{link.task}</span>
          ) : null}
          {inherited ? (
            <span className="text-3xs text-muted-foreground">{gt("Coordinator")}</span>
          ) : null}
        </div>
        {detailText ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">{detailText}</p>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onOpen}
              aria-label={
                isInbox ? gt("Open Inbox item in CT Studio") : gt("Open Task in CT Studio")
              }
              className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-md border border-border/70 bg-background/80 px-1.5 py-1 text-3xs font-medium text-foreground transition-colors hover:bg-accent"
            >
              <span>{isInbox ? gt("Inbox") : gt("Task")}</span>
              <ArrowUpRightIcon className="size-3" aria-hidden />
            </button>
          }
        />
        <TooltipPopup side="left">
          {isInbox ? gt("Open in CT Studio Inbox") : gt("Open in CT Studio Task")}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function TaskRow({
  task,
  isCurrent,
  currentThreadId,
  fallbackEnvironmentId,
  onOpenTask,
  onOpenThread,
}: {
  task: CtStudioWatchedTaskItem;
  isCurrent: boolean;
  currentThreadId: string;
  fallbackEnvironmentId: string;
  onOpenTask: () => void;
  onOpenThread: (threadId: string, environmentId: string) => void;
}) {
  const gt = useGT();
  const canJumpThread = Boolean(task.threadId && task.threadId !== currentThreadId);
  const stageText = stageDisplayLabel(task.stage);

  return (
    <div
      data-ct-studio-task={task.key}
      className={cn(
        "group flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/50",
        isCurrent && "bg-accent/40",
      )}
    >
      <button
        type="button"
        onClick={onOpenTask}
        className="flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left"
      >
        <div className="flex w-full items-center gap-1.5">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(task.threadStatus))}
            aria-hidden
          />
          <span className="shrink-0 font-mono text-3xs font-semibold text-foreground">
            {task.key}
          </span>
          {stageText ? (
            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-3xs text-muted-foreground">
              {stageText}
            </span>
          ) : null}
          {isCurrent ? (
            <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-3xs font-medium text-primary">
              {gt("Current")}
            </span>
          ) : null}
          {task.status ? (
            <span className="ml-auto truncate text-3xs text-muted-foreground">{task.status}</span>
          ) : null}
        </div>
        <span className="mt-0.5 w-full truncate text-xs text-muted-foreground">{task.summary}</span>
      </button>
      {canJumpThread && task.threadId ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={gt("Switch to thread for {key}", { key: task.key })}
                onClick={() =>
                  onOpenThread(task.threadId!, task.environmentId ?? fallbackEnvironmentId)
                }
                className={cn(
                  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  task.threadStatus === "blocked" && "border-warning/40 bg-warning/15 text-warning",
                )}
              >
                <CornerDownLeftIcon className="size-3" aria-hidden />
              </button>
            }
          />
          <TooltipPopup side="left">{gt("Switch to active thread")}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

function InboxRow({
  item,
  isCurrent,
  currentThreadId,
  fallbackEnvironmentId,
  onOpenInbox,
  onOpenThread,
}: {
  item: CtStudioWatchedInboxItem;
  isCurrent: boolean;
  currentThreadId: string;
  fallbackEnvironmentId: string;
  onOpenInbox: () => void;
  onOpenThread: (threadId: string, environmentId: string) => void;
}) {
  const gt = useGT();
  const canJumpThread = Boolean(item.threadId && item.threadId !== currentThreadId);

  return (
    <div
      data-ct-studio-inbox={item.id}
      className={cn(
        "group flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/50",
        isCurrent && "bg-accent/40",
      )}
    >
      <button
        type="button"
        onClick={onOpenInbox}
        className="flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left"
      >
        <div className="flex w-full items-center gap-1.5">
          {item.pinned ? (
            <PinIcon className="size-2.5 shrink-0 text-warning" aria-hidden />
          ) : (
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                item.threadStatus
                  ? statusDotClass(item.threadStatus)
                  : item.attention === "action"
                    ? "bg-warning"
                    : "bg-muted-foreground/40",
              )}
              aria-hidden
            />
          )}
          <span className="truncate text-3xs font-medium text-muted-foreground">
            {item.sourceLabel ?? item.source}
          </span>
          {isCurrent ? (
            <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-3xs font-medium text-primary">
              {gt("Current")}
            </span>
          ) : null}
        </div>
        <span className="mt-0.5 w-full truncate text-xs text-foreground">{item.title}</span>
      </button>
      {canJumpThread && item.threadId ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={gt("Switch to thread for {title}", { title: item.title })}
                onClick={() =>
                  onOpenThread(item.threadId!, item.environmentId ?? fallbackEnvironmentId)
                }
                className={cn(
                  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  item.threadStatus === "blocked" && "border-warning/40 bg-warning/15 text-warning",
                )}
              >
                <CornerDownLeftIcon className="size-3" aria-hidden />
              </button>
            }
          />
          <TooltipPopup side="left">{gt("Switch to active thread")}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

export const ThreadCtStudioCard = memo(function ThreadCtStudioCard({
  threadRef,
}: {
  threadRef: ScopedThreadRef;
}) {
  const gt = useGT();
  const canvas = useChatCanvas();
  const compactBySpace = (canvas?.detailsCardPlacement?.height ?? 480) < 420;
  const legacyEnabled = useCtStudioStore((state) => state.legacyEnabled);
  const connected = useCtStudioStore((state) => state.connected);
  const badgeCount = useCtStudioStore((state) => state.badgeCount);
  const workspaceContext = useCtStudioStore((state) => state.workspaceContext);
  const thread = useThreadShell(threadRef);
  const { openCtStudio, openCtStudioModal, openThread } = useCtStudioNavigation();
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
  const [selectedTab, setSelectedTab] = useState<"tasks" | "inbox" | null>(null);

  if (!legacyEnabled || !connected) return null;

  const resolved = resolveThreadCtStudioLink(
    {
      id: threadRef.threadId,
      title: thread?.title,
      branch: thread?.branch,
      rootThreadId: thread?.lineage?.rootThreadId,
    },
    workspaceContext,
  );
  const { watchedTasks, watchedInbox } = workspaceContext;
  const hasAnyContent = Boolean(resolved || watchedTasks.length > 0 || watchedInbox.length > 0);
  const collapsed = manualCollapsed ?? (compactBySpace || !hasAnyContent);
  const activeTab: "tasks" | "inbox" =
    selectedTab ??
    (resolved?.link.kind === "inbox" && watchedInbox.length > 0
      ? "inbox"
      : watchedTasks.length > 0 || watchedInbox.length === 0
        ? "tasks"
        : "inbox");

  const openResolved = () => {
    if (!resolved) return;
    if (resolved.link.kind === "inbox") {
      openCtStudioModal({ itemId: resolved.link.itemId });
    } else {
      openCtStudioModal({ ticket: resolved.link.ticketKey, stage: resolved.link.stage });
    }
  };

  const openExpandedModal = () => {
    if (resolved) {
      openResolved();
      return;
    }
    openCtStudioModal({ view: activeTab === "inbox" ? "timeline" : "jira" });
  };

  return (
    <div
      data-thread-ct-studio-card
      data-collapsed={collapsed ? "true" : undefined}
      className={cn(
        "dropdown-glass isolate contain-paint flex min-h-0 flex-col overflow-hidden rounded-2xl",
        collapsed ? "shrink-0" : "min-h-36 max-h-96",
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setManualCollapsed(!collapsed)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        >
          <LayoutGridIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate text-xs font-medium text-foreground">{gt("CT Studio")}</span>
          {badgeCount > 0 ? (
            <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-md border border-warning/30 bg-warning/15 px-1 text-3xs font-medium tabular-nums text-warning">
              {badgeCount > 99 ? "99+" : badgeCount}
            </span>
          ) : null}
          {collapsed && resolved ? (
            <span className="truncate font-mono text-3xs text-muted-foreground">
              {resolved.link.kind === "inbox" ? resolved.link.source : resolved.link.ticketKey}
            </span>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={gt("Expand CT Studio in modal")}
                  onClick={openExpandedModal}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Maximize2Icon className="size-3.5" aria-hidden />
                </button>
              }
            />
            <TooltipPopup side="left">{gt("Quick view CT Studio")}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={gt("Open CT Studio")}
                  onClick={() => openCtStudio()}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ArrowUpRightIcon className="size-3.5" aria-hidden />
                </button>
              }
            />
            <TooltipPopup side="left">{gt("Open CT Studio")}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={
                    collapsed ? gt("Expand CT Studio panel") : gt("Collapse CT Studio panel")
                  }
                  aria-expanded={!collapsed}
                  onClick={() => setManualCollapsed(!collapsed)}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {collapsed ? (
                    <ChevronDownIcon className="size-3.5" aria-hidden />
                  ) : (
                    <ChevronUpIcon className="size-3.5" aria-hidden />
                  )}
                </button>
              }
            />
            <TooltipPopup side="left">{collapsed ? gt("Expand") : gt("Collapse")}</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {!collapsed ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {resolved ? (
            <LinkDestinationButton
              link={resolved.link}
              inherited={resolved.inherited}
              onOpen={openResolved}
            />
          ) : null}

          <div
            role="tablist"
            aria-label={gt("CT Studio workspace lists")}
            className="mx-2.5 mb-1.5 grid shrink-0 grid-cols-2 gap-1 rounded-lg bg-muted/50 p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "tasks"}
              onClick={() => setSelectedTab("tasks")}
              className={cn(
                "flex cursor-pointer items-center justify-center gap-1 rounded-md px-2 py-1 text-3xs font-medium transition-colors",
                activeTab === "tasks"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{gt("Tasks")}</span>
              <span className="tabular-nums opacity-70">{watchedTasks.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "inbox"}
              onClick={() => setSelectedTab("inbox")}
              className={cn(
                "flex cursor-pointer items-center justify-center gap-1 rounded-md px-2 py-1 text-3xs font-medium transition-colors",
                activeTab === "inbox"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{gt("Inbox")}</span>
              <span className="tabular-nums opacity-70">{watchedInbox.length}</span>
            </button>
          </div>

          <ScrollArea scrollFade className="min-h-0 flex-1">
            <div className="flex flex-col gap-0.5 px-1.5 pb-2">
              {activeTab === "tasks" ? (
                watchedTasks.length > 0 ? (
                  watchedTasks.map((task) => (
                    <TaskRow
                      key={task.key}
                      task={task}
                      isCurrent={
                        resolved?.link.kind === "ticket" && resolved.link.ticketKey === task.key
                      }
                      currentThreadId={threadRef.threadId}
                      fallbackEnvironmentId={threadRef.environmentId}
                      onOpenTask={() => openCtStudioModal({ ticket: task.key, stage: task.stage })}
                      onOpenThread={openThread}
                    />
                  ))
                ) : (
                  <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                    {gt("No watched tasks")}
                  </p>
                )
              ) : watchedInbox.length > 0 ? (
                watchedInbox.map((item) => (
                  <InboxRow
                    key={item.id}
                    item={item}
                    isCurrent={resolved?.link.kind === "inbox" && resolved.link.itemId === item.id}
                    currentThreadId={threadRef.threadId}
                    fallbackEnvironmentId={threadRef.environmentId}
                    onOpenInbox={() => openCtStudioModal({ itemId: item.id })}
                    onOpenThread={openThread}
                  />
                ))
              ) : (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {gt("No pending inbox items")}
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
});

export const ThreadCtStudioPopoverRow = memo(function ThreadCtStudioPopoverRow({
  threadRef,
}: {
  threadRef: ScopedThreadRef;
}) {
  const legacyEnabled = useCtStudioStore((state) => state.legacyEnabled);
  const connected = useCtStudioStore((state) => state.connected);
  const workspaceContext = useCtStudioStore((state) => state.workspaceContext);
  const thread = useThreadShell(threadRef);
  const { openCtStudioModal } = useCtStudioNavigation();

  if (!legacyEnabled || !connected) return null;

  const resolved = resolveThreadCtStudioLink(
    {
      id: threadRef.threadId,
      title: thread?.title,
      branch: thread?.branch,
      rootThreadId: thread?.lineage?.rootThreadId,
    },
    workspaceContext,
  );
  if (!resolved) return null;

  return (
    <LinkDestinationButton
      link={resolved.link}
      inherited={resolved.inherited}
      compact
      onOpen={() => {
        if (resolved.link.kind === "inbox") {
          openCtStudioModal({ itemId: resolved.link.itemId });
        } else {
          openCtStudioModal({ ticket: resolved.link.ticketKey, stage: resolved.link.stage });
        }
      }}
    />
  );
});
