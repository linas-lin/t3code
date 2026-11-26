import { DndContext } from "@dnd-kit/core";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId, ThreadId, type ScopedProjectRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../../test/render";
import { DraftId } from "../../../composerDraftStore";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { useUiStateStore } from "../../../uiStateStore";
import { TooltipProvider } from "../../ui/tooltip";
import { useDraftThreadGroupStore } from "./draftThreadGroupStore";
import { threadGroupExpansionKey } from "./threadGrouping.logic";
import { useSidebarThreadGrouping } from "./useSidebarThreadGrouping";

const ENV_ID = EnvironmentId.make("env-1");
const PROJECT_ID = ProjectId.make("proj-1");
const PROJECT_KEY = "env-1:proj-1";

function makeProjectGroup(): SidebarProjectSnapshot {
  return {
    environmentId: ENV_ID,
    id: PROJECT_ID,
    projectKey: PROJECT_KEY,
    displayName: "Project One",
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    memberProjects: [],
    memberProjectRefs: [scopeProjectRef(ENV_ID, PROJECT_ID)],
    remoteEnvironmentLabels: [],
    pinned: false,
    archived: false,
  } as unknown as SidebarProjectSnapshot;
}

function makeGroupedThread(id: string, groupName: string): EnvironmentThreadShell {
  return {
    environmentId: ENV_ID,
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: `Thread ${id}`,
    tags: [`group:${groupName}`],
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-11-26T08:00:00.000Z",
    updatedAt: "2026-11-26T08:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    settledAt: null,
    unsettledAt: null,
    settledOverride: null,
    snoozedAt: null,
    snoozedUntil: null,
    lastVisitedAt: "2026-11-26T08:00:00.000Z",
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    hasActionableProposedPlan: false,
    blockedOnThreadWait: false,
    providerInstanceId: null,
  } as unknown as EnvironmentThreadShell;
}

function ThreadGroupingProbe(props: {
  readonly projectGroup: SidebarProjectSnapshot;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly routeRowThreadKey: string | null;
  readonly handleNewThread: (projectRef: ScopedProjectRef) => Promise<{ draftId: DraftId } | null>;
}) {
  const grouping = useSidebarThreadGrouping({
    projectGroups: [props.projectGroup],
    searchableThreads: props.threads,
    routeRowThreadKey: props.routeRowThreadKey,
    serverConfigs: new Map(),
    isMobile: false,
    setOpenMobile: vi.fn(),
    handleNewThread: props.handleNewThread,
    setThreadGroup: vi.fn(async () => ({}) as unknown as AtomCommandResult<unknown, unknown>),
    checkThreadOperations: () => true,
    settleThreads: vi.fn(),
  });

  return (
    <TooltipProvider>
      <DndContext>
        <ul>
          {grouping.renderProjectGroupedThreads({
            projectGroup: props.projectGroup,
            threads: props.threads,
            nested: false,
            dragInfo: {
              activeThread: null,
              activeSection: undefined,
              isPointerOutsideList: false,
              targetGroupDropId: null,
            },
            renderThreadRow: (thread) => (
              <li
                key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                data-testid={`grouped-thread-${thread.id}`}
              >
                {thread.title}
              </li>
            ),
          })}
        </ul>
      </DndContext>
    </TooltipProvider>
  );
}

it("keeps a collapsed thread group collapsed when starting a new thread and after navigating into the created thread", async () => {
  const initialUiState = useUiStateStore.getState();
  const initialDraftGroupState = useDraftThreadGroupStore.getState();
  using _restoreStores = {
    [Symbol.dispose]: () => {
      useUiStateStore.setState(initialUiState, true);
      useDraftThreadGroupStore.setState(initialDraftGroupState, true);
    },
  };

  const expansionKey = threadGroupExpansionKey(PROJECT_KEY, "BLUE-123");
  useUiStateStore.setState({
    ...initialUiState,
    threadGroupExpandedByKey: { [expansionKey]: false },
  });
  useDraftThreadGroupStore.setState({ groupNameByDraftId: {} });

  const projectGroup = makeProjectGroup();
  const existingThread = makeGroupedThread("t-1", "BLUE-123");
  const draftId = DraftId.make("draft-blue-123");
  const handleNewThread = vi.fn(async () => ({ draftId }));

  await using screen = await render(
    <ThreadGroupingProbe
      projectGroup={projectGroup}
      threads={[existingThread]}
      routeRowThreadKey={null}
      handleNewThread={handleNewThread}
    />,
    { router: false },
  );

  const groupRow = screen.container.querySelector<HTMLButtonElement>(
    `[data-sidebar-row="group:top:${PROJECT_KEY}::BLUE-123"]`,
  )!;
  expect(groupRow).not.toBeNull();
  expect(groupRow.getAttribute("aria-expanded")).toBe("false");
  expect(screen.container.querySelector('[data-testid="grouped-thread-t-1"]')).toBeNull();

  // Clicking the group's "+" action opens a draft tagged for the group without expanding it.
  const newThreadButton = screen.getByRole("button", { name: "New thread in BLUE-123" });
  await act(async () => {
    (newThreadButton.element() as HTMLButtonElement).click();
  });

  expect(handleNewThread).toHaveBeenCalledTimes(1);
  expect(useDraftThreadGroupStore.getState().getDraftGroupName(draftId)).toBe("BLUE-123");
  expect(useUiStateStore.getState().threadGroupExpandedByKey[expansionKey]).toBe(false);
  expect(groupRow.getAttribute("aria-expanded")).toBe("false");
  expect(screen.container.querySelector('[data-testid="grouped-thread-t-1"]')).toBeNull();

  // After sending creates the grouped thread and route navigation lands on it, keep the group collapsed.
  const createdThread = makeGroupedThread("t-2", "BLUE-123");
  const createdThreadKey = scopedThreadKey(scopeThreadRef(ENV_ID, createdThread.id));
  await screen.rerender(
    <ThreadGroupingProbe
      projectGroup={projectGroup}
      threads={[createdThread, existingThread]}
      routeRowThreadKey={createdThreadKey}
      handleNewThread={handleNewThread}
    />,
  );

  expect(useUiStateStore.getState().threadGroupExpandedByKey[expansionKey]).toBe(false);
  expect(groupRow.getAttribute("aria-expanded")).toBe("false");
  expect(screen.container.querySelector('[data-testid="grouped-thread-t-1"]')).toBeNull();
  expect(screen.container.querySelector('[data-testid="grouped-thread-t-2"]')).toBeNull();
});
