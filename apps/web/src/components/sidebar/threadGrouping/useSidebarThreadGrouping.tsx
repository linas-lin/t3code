import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ContextMenuItem,
  ContextMenuSource,
  EnvironmentId,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { DraftId } from "../../../composerDraftStore";
import { useStableCallback } from "../../../hooks/useStableCallback";
import { m } from "../../../i18n/messages";
import { readLocalApi } from "../../../localApi";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { useUiStateStore } from "../../../uiStateStore";
import type { SidebarSection } from "../../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { useDraftThreadGroupStore } from "./draftThreadGroupStore";
import { SidebarThreadGroupHeader, SidebarUngroupedDropZone } from "./SidebarThreadGroupHeader";
import { ThreadGroupNameDialog } from "./ThreadGroupNameDialog";
import {
  extractSuggestedGroupFromThread,
  groupProjectActiveThreads,
  parseThreadGroupDropId,
  readThreadGroupName,
  readThreadTags,
  threadGroupExpansionKey,
  threadUngroupedDropId,
  type SidebarThreadGroupBucket,
} from "./threadGrouping.logic";

type ThreadGroupDialogState =
  | {
      readonly mode: "create";
      readonly threads: readonly EnvironmentThreadShell[];
      readonly existingGroups: readonly string[];
      readonly initialValue?: string;
    }
  | {
      readonly mode: "rename";
      readonly projectKey: string;
      readonly groupName: string;
      readonly threads: readonly EnvironmentThreadShell[];
      readonly existingGroups: readonly string[];
    };

function threadKeyOf(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export function useSidebarThreadGrouping(input: {
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly searchableThreads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly routeRowThreadKey: string | null;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, unknown>;
  readonly isMobile: boolean;
  readonly setOpenMobile: (open: boolean) => void;
  readonly handleNewThread: (projectRef: ScopedProjectRef) => Promise<{ draftId: DraftId } | null>;
  readonly setThreadGroup: (
    target: ScopedThreadRef,
    groupName: string | null,
    currentTags?: ReadonlyArray<string>,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly checkThreadOperations: (threads: readonly EnvironmentThreadShell[]) => boolean;
  readonly settleThreads: (threadKeys: readonly string[]) => void;
}) {
  const gt = useGT();
  const threadGroupExpandedByKey = useUiStateStore((store) => store.threadGroupExpandedByKey);
  const setThreadGroupExpanded = useUiStateStore((store) => store.setThreadGroupExpanded);
  const toggleThreadGroupExpanded = useUiStateStore((store) => store.toggleThreadGroupExpanded);
  const [threadGroupDialog, setThreadGroupDialog] = useState<ThreadGroupDialogState | null>(null);

  const resolveProjectGroupForThread = (
    thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
  ): SidebarProjectSnapshot | null =>
    input.projectGroups.find((project) =>
      project.memberProjectRefs.some(
        (projectRef) =>
          projectRef.environmentId === thread.environmentId &&
          projectRef.projectId === thread.projectId,
      ),
    ) ?? null;

  // Auto-expand a collapsed group when route navigation lands on a thread inside it.
  // Tracks the previous route key so manually collapsing the active group stays collapsed.
  const previousRouteThreadKeyRef = useRef<string | null>(input.routeRowThreadKey);
  const autoExpandTarget = (() => {
    if (input.routeRowThreadKey === null) return null;
    const thread = input.activeThreads.find(
      (candidate) => threadKeyOf(candidate) === input.routeRowThreadKey,
    );
    if (!thread) return null;
    const groupName = readThreadGroupName(thread);
    if (groupName === null) return null;
    const projectGroup = resolveProjectGroupForThread(thread);
    if (!projectGroup) return null;
    const expansionKey = threadGroupExpansionKey(projectGroup.projectKey, groupName);
    return threadGroupExpandedByKey[expansionKey] === false ? expansionKey : null;
  })();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands a collapsed group in the external UI store when navigation lands inside it
  useEffect(() => {
    if (previousRouteThreadKeyRef.current === input.routeRowThreadKey) return;
    previousRouteThreadKeyRef.current = input.routeRowThreadKey;
    if (autoExpandTarget !== null) {
      useUiStateStore.getState().setThreadGroupExpanded(autoExpandTarget, true);
    }
  }, [autoExpandTarget, input.routeRowThreadKey]);

  const collectProjectGroupNames = (projectGroup: SidebarProjectSnapshot): string[] => {
    const memberKeys = new Set(
      projectGroup.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
    );
    const seen = new Set<string>();
    const names: string[] = [];
    for (const thread of input.searchableThreads) {
      if (!memberKeys.has(`${thread.environmentId}:${thread.projectId}`)) continue;
      const groupName = readThreadGroupName(thread);
      if (groupName === null || seen.has(groupName)) continue;
      seen.add(groupName);
      names.push(groupName);
    }
    return names;
  };

  const applyThreadGroup = (
    threads: readonly EnvironmentThreadShell[],
    groupName: string | null,
    expandProjectKey?: string,
  ) => {
    if (threads.length === 0) return;
    if (!input.checkThreadOperations(threads)) return;
    if (groupName !== null && expandProjectKey) {
      setThreadGroupExpanded(threadGroupExpansionKey(expandProjectKey, groupName), true);
    }
    void (async () => {
      let firstError: unknown = null;
      for (const thread of threads) {
        const result = await input.setThreadGroup(
          scopeThreadRef(thread.environmentId, thread.id),
          groupName,
          readThreadTags(thread),
        );
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result) && firstError === null) {
          firstError = squashAtomCommandFailure(result);
        }
      }
      if (firstError !== null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Failed to update thread group"),
            description: thrownErrorMessage(firstError, m) ?? gt("An error occurred."),
          }),
        );
      }
    })();
  };

  const startThreadInThreadGroup = useStableCallback(
    (projectGroup: SidebarProjectSnapshot, groupName: string) => {
      if (input.isMobile) input.setOpenMobile(false);
      setThreadGroupExpanded(threadGroupExpansionKey(projectGroup.projectKey, groupName), true);
      void input
        .handleNewThread(scopeProjectRef(projectGroup.environmentId, projectGroup.id))
        .then((opened) => {
          if (opened) {
            useDraftThreadGroupStore.getState().setDraftGroupName(opened.draftId, groupName);
          }
        });
    },
  );

  const handleThreadGroupContextMenu = useStableCallback(
    (
      projectGroup: SidebarProjectSnapshot,
      bucket: SidebarThreadGroupBucket<EnvironmentThreadShell>,
      position: { x: number; y: number },
      source: ContextMenuSource,
    ) => {
      const api = readLocalApi();
      if (!api) return;
      void (async () => {
        const canSettleAny = bucket.allThreads.some(
          (thread) =>
            input.serverConfigs.has(thread.environmentId) && thread.settledOverride !== "settled",
        );
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              { id: "new-thread", label: gt("New thread"), icon: "message-square-plus" },
              { id: "rename-group", label: gt("Rename group"), icon: "pencil" },
              ...(canSettleAny
                ? [
                    {
                      id: "settle-group",
                      label: gt("Settle all in group"),
                      icon: "circle-check",
                      separatorBefore: true,
                    },
                  ]
                : []),
            ],
            position,
            source,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        switch (clicked.value) {
          case "new-thread":
            startThreadInThreadGroup(projectGroup, bucket.groupName);
            return;
          case "rename-group":
            setThreadGroupDialog({
              mode: "rename",
              projectKey: projectGroup.projectKey,
              groupName: bucket.groupName,
              threads: bucket.allThreads,
              existingGroups: collectProjectGroupNames(projectGroup),
            });
            return;
          case "settle-group":
            if (!input.checkThreadOperations(bucket.allThreads)) return;
            input.settleThreads(bucket.allThreads.map(threadKeyOf));
            return;
        }
      })();
    },
  );

  const buildSingleThreadMenuState = (
    thread: EnvironmentThreadShell,
    projectGroup: SidebarProjectSnapshot | null,
  ) =>
    projectGroup
      ? {
          currentGroup: readThreadGroupName(thread),
          availableGroups: collectProjectGroupNames(projectGroup),
          suggestedGroup: extractSuggestedGroupFromThread(thread),
        }
      : null;

  const buildBulkThreadMenuItem = (options: {
    readonly selectedThreads: readonly EnvironmentThreadShell[];
    readonly count: number;
    readonly canOperate: boolean;
  }): {
    readonly item: ContextMenuItem<string>;
    readonly projectGroup: SidebarProjectSnapshot | null;
    readonly availableGroups: readonly string[];
  } => {
    const selectedProjectGroups = [
      ...new Map(
        options.selectedThreads
          .map((thread) => resolveProjectGroupForThread(thread))
          .filter((group): group is SidebarProjectSnapshot => group !== null)
          .map((group) => [group.projectKey, group] as const),
      ).values(),
    ];
    const projectGroup =
      selectedProjectGroups.length === 1 ? (selectedProjectGroups[0] ?? null) : null;
    const availableGroups = projectGroup ? collectProjectGroupNames(projectGroup) : [];
    const hasGroupedThread = options.selectedThreads.some(
      (thread) => readThreadGroupName(thread) !== null,
    );
    return {
      projectGroup,
      availableGroups,
      item: {
        id: "group",
        label: gt("Move to group ({count})", { count: options.count }),
        icon: "folder",
        disabled: !options.canOperate,
        children: [
          ...availableGroups.map((groupName) => ({
            id: `group:set:${groupName}`,
            label: groupName,
            disabled: !options.canOperate,
          })),
          {
            id: "group:new",
            label: gt("New group…"),
            icon: "folder-plus",
            separatorBefore: availableGroups.length > 0,
            disabled: !options.canOperate,
          },
          ...(hasGroupedThread
            ? [
                {
                  id: "group:clear",
                  label: gt("Remove from group"),
                  icon: "folder-minus",
                  separatorBefore: true,
                  disabled: !options.canOperate,
                },
              ]
            : []),
        ],
      },
    };
  };

  const handleMenuAction = (options: {
    readonly action: string;
    readonly threads: readonly EnvironmentThreadShell[];
    readonly projectGroup: SidebarProjectSnapshot | null;
    readonly availableGroups?: readonly string[];
  }): boolean => {
    if (options.action.startsWith("group:set:")) {
      const nextGroup = options.action.slice("group:set:".length);
      applyThreadGroup(options.threads, nextGroup, options.projectGroup?.projectKey);
      return true;
    }
    if (options.action === "group:clear") {
      applyThreadGroup(options.threads, null);
      return true;
    }
    if (options.action === "group:new") {
      const firstThread = options.threads.length === 1 ? options.threads[0] : undefined;
      const suggested = firstThread ? extractSuggestedGroupFromThread(firstThread) : null;
      setThreadGroupDialog({
        mode: "create",
        threads: options.threads,
        existingGroups:
          options.availableGroups ??
          (options.projectGroup ? collectProjectGroupNames(options.projectGroup) : []),
        ...(suggested ? { initialValue: suggested } : {}),
      });
      return true;
    }
    return false;
  };

  const isValidGroupDrop = (options: {
    readonly targetId: string;
    readonly activeThread: EnvironmentThreadShell | null;
    readonly activeSection: SidebarSection | undefined;
  }): boolean | null => {
    const groupDrop = parseThreadGroupDropId(options.targetId);
    if (groupDrop === null) return null;
    if (options.activeSection !== "active" || options.activeThread === null) return false;
    const sourceProjectKey = resolveProjectGroupForThread(options.activeThread)?.projectKey ?? null;
    if (sourceProjectKey === null || groupDrop.projectKey !== sourceProjectKey) return false;
    const currentGroup = readThreadGroupName(options.activeThread);
    return groupDrop.kind === "group"
      ? currentGroup !== groupDrop.groupName
      : currentGroup !== null;
  };

  const handleGroupDropEnd = (options: {
    readonly activeThread: EnvironmentThreadShell | undefined;
    readonly overId: string | null;
  }): boolean => {
    const overGroupTarget = options.overId ? parseThreadGroupDropId(options.overId) : null;
    if (overGroupTarget === null) return false;
    if (options.activeThread === undefined) return true;
    const sourceProjectKey = resolveProjectGroupForThread(options.activeThread)?.projectKey ?? null;
    if (sourceProjectKey === null || sourceProjectKey !== overGroupTarget.projectKey) return true;
    const nextGroupName = overGroupTarget.kind === "group" ? overGroupTarget.groupName : null;
    if (readThreadGroupName(options.activeThread) !== nextGroupName) {
      applyThreadGroup(
        [options.activeThread],
        nextGroupName,
        nextGroupName === null ? undefined : sourceProjectKey,
      );
    }
    return true;
  };

  const renderProjectGroupedThreads = (options: {
    readonly projectGroup: SidebarProjectSnapshot;
    readonly threads: readonly EnvironmentThreadShell[];
    readonly nested: boolean;
    readonly ungroupedParentRow?: string;
    readonly dragInfo: {
      readonly activeThread: EnvironmentThreadShell | null;
      readonly activeSection: SidebarSection | undefined;
      readonly isPointerOutsideList: boolean;
      readonly targetGroupDropId: string | null;
    };
    readonly renderThreadRow: (
      thread: EnvironmentThreadShell,
      section: SidebarSection,
      parentRow?: string,
    ) => ReactNode;
  }): ReactNode[] | null => {
    const grouped = groupProjectActiveThreads({
      projectKey: options.projectGroup.projectKey,
      nested: options.nested,
      threads: options.threads,
      expandedByKey: threadGroupExpandedByKey,
      routeThreadKey: input.routeRowThreadKey,
      getThreadKey: threadKeyOf,
    });
    if (grouped.groups.length === 0) return null;

    const draggedProjectKey = options.dragInfo.activeThread
      ? (resolveProjectGroupForThread(options.dragInfo.activeThread)?.projectKey ?? null)
      : null;
    const draggedGroupName = options.dragInfo.activeThread
      ? readThreadGroupName(options.dragInfo.activeThread)
      : null;
    const showUngroupedDropZone =
      options.dragInfo.activeThread !== null &&
      !options.dragInfo.isPointerOutsideList &&
      options.dragInfo.activeSection === "active" &&
      draggedProjectKey === options.projectGroup.projectKey &&
      draggedGroupName !== null;

    const nodes: ReactNode[] = [];
    for (const bucket of grouped.groups) {
      nodes.push(
        <SidebarThreadGroupHeader
          key={`thread-group:${bucket.expansionKey}`}
          projectKey={options.projectGroup.projectKey}
          groupName={bucket.groupName}
          rowId={bucket.rowId}
          dropId={bucket.dropId}
          nested={options.nested}
          collapsed={bucket.collapsed}
          containsActiveThread={bucket.hasActiveRouteThread}
          totalCount={bucket.allThreads.length}
          hiddenThreads={bucket.hiddenThreads}
          isDropTarget={options.dragInfo.targetGroupDropId === bucket.dropId}
          onToggle={() => toggleThreadGroupExpanded(bucket.expansionKey)}
          onNewThread={() => startThreadInThreadGroup(options.projectGroup, bucket.groupName)}
          onContextMenu={(position, source) =>
            handleThreadGroupContextMenu(options.projectGroup, bucket, position, source)
          }
        />,
      );
      for (const thread of bucket.threads) {
        nodes.push(options.renderThreadRow(thread, "active", bucket.rowId));
      }
    }
    nodes.push(
      <SidebarUngroupedDropZone
        key={`ungrouped-drop:${options.projectGroup.projectKey}`}
        dropId={threadUngroupedDropId(options.projectGroup.projectKey)}
        nested={options.nested}
        visible={showUngroupedDropZone}
      />,
    );
    for (const thread of grouped.ungrouped) {
      nodes.push(options.renderThreadRow(thread, "active", options.ungroupedParentRow));
    }
    return nodes;
  };

  const expansionLayoutKey = Object.entries(threadGroupExpandedByKey)
    .filter(([, expanded]) => expanded === false)
    .map(([key]) => key)
    .sort()
    .join(",");

  const dialogElement = (
    <ThreadGroupNameDialog
      open={threadGroupDialog !== null}
      mode={threadGroupDialog?.mode ?? "create"}
      initialValue={
        threadGroupDialog?.mode === "rename"
          ? threadGroupDialog.groupName
          : (threadGroupDialog?.initialValue ?? "")
      }
      existingGroups={threadGroupDialog?.existingGroups ?? []}
      onOpenChange={(open) => {
        if (!open) setThreadGroupDialog(null);
      }}
      onSubmit={(nextGroupName) => {
        if (!threadGroupDialog) return;
        if (threadGroupDialog.mode === "rename") {
          const oldKey = threadGroupExpansionKey(
            threadGroupDialog.projectKey,
            threadGroupDialog.groupName,
          );
          const wasCollapsed = threadGroupExpandedByKey[oldKey] === false;
          applyThreadGroup(threadGroupDialog.threads, nextGroupName);
          if (!wasCollapsed) {
            setThreadGroupExpanded(
              threadGroupExpansionKey(threadGroupDialog.projectKey, nextGroupName),
              true,
            );
          }
        } else {
          const firstThread = threadGroupDialog.threads[0];
          const projectKey = firstThread
            ? resolveProjectGroupForThread(firstThread)?.projectKey
            : undefined;
          applyThreadGroup(threadGroupDialog.threads, nextGroupName, projectKey);
        }
      }}
    />
  );

  return {
    expansionLayoutKey,
    buildSingleThreadMenuState,
    buildBulkThreadMenuItem,
    handleMenuAction,
    isValidGroupDrop,
    handleGroupDropEnd,
    renderProjectGroupedThreads,
    dialogElement,
  };
}
