import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ancestorDirectoryPaths,
  buildAvailableRepoScopes,
  buildFilteredTreeRows,
  filterAndSortRepoScopes,
  findFileNameMatchRanges,
  flattenVisibleTreeRows,
  formatCompactParentPath,
  isTestFilePath,
  matchesPathFilter,
  partitionSelectedScopeChips,
  pickInitialSelectedScopeIds,
} from "./repoScope.logic";

const ENV = "env-1" as EnvironmentId;

describe("repoScope.logic", () => {
  it("deduplicates registered projects and ct-studio/repos symlinks while putting ct-studio root last", () => {
    const scopes = buildAvailableRepoScopes({
      projects: [
        { environmentId: ENV, title: "ct-studio", workspaceRoot: "/work/ct-studio" },
        {
          environmentId: ENV,
          title: "blueapron-project",
          workspaceRoot: "/work/blueapron-project",
        },
      ],
      ctStudioRepos: [
        {
          environmentId: ENV,
          name: "blueapron-project",
          cwd: "/work/ct-studio/repos/blueapron-project",
        },
        { environmentId: ENV, name: "protos", cwd: "/work/ct-studio/repos/protos" },
      ],
      customRepos: [{ environmentId: ENV, name: "extra", cwd: "/work/extra/" }],
    });

    expect(
      scopes.map((s) => ({ name: s.name, origin: s.origin, ct: Boolean(s.isCtStudioRoot) })),
    ).toEqual([
      { name: "blueapron-project", origin: "project", ct: false },
      { name: "extra", origin: "custom", ct: false },
      { name: "protos", origin: "ct-repos", ct: false },
      { name: "ct-studio", origin: "project", ct: true },
    ]);
  });

  it("matches comma/space separated include and exclude path filters", () => {
    expect(matchesPathFilter("src/order/CartService.java", "*.java, !*Test.java")).toBe(true);
    expect(matchesPathFilter("src/order/CartServiceTest.java", "*.java, !*Test.java")).toBe(false);
    expect(matchesPathFilter("src/order/CartService.ts", "*.java")).toBe(false);
    expect(matchesPathFilter("src/order/CartService.java", "order/")).toBe(true);
    expect(matchesPathFilter("src/billing/Invoice.java", "order/")).toBe(false);
  });

  it("selects active business project initially and avoids auto-selecting ct-studio root", () => {
    const scopes = buildAvailableRepoScopes({
      projects: [
        { environmentId: ENV, title: "ct-studio", workspaceRoot: "/work/ct-studio" },
        {
          environmentId: ENV,
          title: "blueapron-project",
          workspaceRoot: "/work/blueapron-project",
        },
      ],
      ctStudioRepos: [{ environmentId: ENV, name: "protos", cwd: "/work/ct-studio/repos/protos" }],
      customRepos: [],
    });

    expect(
      pickInitialSelectedScopeIds({
        available: scopes,
        activeCwd: "/work/blueapron-project",
        activeEnvironmentId: ENV,
      }),
    ).toEqual([`${ENV}::/work/blueapron-project`]);

    expect(
      pickInitialSelectedScopeIds({
        available: scopes,
        activeCwd: "/work/ct-studio",
        activeEnvironmentId: ENV,
      }),
    ).toEqual([]);
  });

  it("compacts deep Java/monorepo parent paths while keeping module and trailing packages", () => {
    expect(
      formatCompactParentPath(
        "backend/ba-auto-ship-service/src/main/java/com/blueapron/autoship/order/service/AutoShipGenerateOrderService.java",
      ),
    ).toBe("ba-auto-ship-service / … / order/service");
    expect(formatCompactParentPath("apps/web/src/App.tsx")).toBe("apps/web/src");
    expect(formatCompactParentPath("README.md")).toBe("");
  });

  it("detects test files and highlights direct or fuzzy filename matches", () => {
    expect(isTestFilePath("backend/ba-auto-ship-service/src/test/java/OrderServiceTest.java")).toBe(
      true,
    );
    expect(isTestFilePath("backend/ba-auto-ship-service/src/main/java/OrderService.java")).toBe(
      false,
    );
    expect(findFileNameMatchRanges("AutoShipGenerateOrderService.java", "GenerateOrder")).toEqual([
      { start: 8, end: 21 },
    ]);
    expect(findFileNameMatchRanges("GenerateOrderService.java", "gos")).toEqual([
      { start: 0, end: 1 },
      { start: 8, end: 9 },
      { start: 13, end: 14 },
    ]);
  });

  it("flattens visible tree rows in screen order with parent links and loading states", () => {
    const scopeId = `${ENV}::/work/ba`;
    const rows = flattenVisibleTreeRows({
      scopeId,
      dirEntries: {
        [`${scopeId}::`]: [
          { path: "backend", kind: "directory" },
          { path: "empty", kind: "directory" },
          { path: "pending", kind: "directory" },
          { path: "README.md", kind: "file" },
        ],
        [`${scopeId}::backend`]: [{ path: "backend/OrderService.java", kind: "file" }],
        [`${scopeId}::empty`]: [],
      },
      expandedDirs: new Set([`${scopeId}::backend`, `${scopeId}::empty`, `${scopeId}::pending`]),
    });

    expect(
      rows.map((row) => ({
        path: row.path,
        parentPath: row.parentPath,
        depth: row.depth,
        loadingChildren: row.loadingChildren,
        emptyChildren: row.emptyChildren,
      })),
    ).toEqual([
      {
        path: "backend",
        parentPath: "",
        depth: 0,
        loadingChildren: false,
        emptyChildren: false,
      },
      {
        path: "backend/OrderService.java",
        parentPath: "backend",
        depth: 1,
        loadingChildren: false,
        emptyChildren: false,
      },
      {
        path: "empty",
        parentPath: "",
        depth: 0,
        loadingChildren: false,
        emptyChildren: true,
      },
      {
        path: "pending",
        parentPath: "",
        depth: 0,
        loadingChildren: true,
        emptyChildren: false,
      },
      {
        path: "README.md",
        parentPath: "",
        depth: 0,
        loadingChildren: false,
        emptyChildren: false,
      },
    ]);
  });

  it("builds a compacted filtered tree and computes ancestor directory paths", () => {
    const scopeId = `${ENV}::/work/ba`;
    expect(ancestorDirectoryPaths("backend/ba-auto-ship/src/main/java/OrderService.java")).toEqual([
      "backend",
      "backend/ba-auto-ship",
      "backend/ba-auto-ship/src",
      "backend/ba-auto-ship/src/main",
      "backend/ba-auto-ship/src/main/java",
    ]);

    const rows = buildFilteredTreeRows({
      scopeId,
      entries: [
        { path: "backend/ba-auto-ship/src/OrderService.java", kind: "file" },
        { path: "backend/ba-auto-ship/src/OrderTask.java", kind: "file" },
      ],
      collapsedKeys: new Set(),
      query: "Order",
    });

    expect(
      rows.map((r) => ({
        name: r.name,
        path: r.path,
        parentPath: r.parentPath,
        depth: r.depth,
        isMatch: r.isMatch,
      })),
    ).toEqual([
      {
        name: "backend/ba-auto-ship/src",
        path: "backend/ba-auto-ship/src",
        parentPath: "",
        depth: 0,
        isMatch: false,
      },
      {
        name: "OrderService.java",
        path: "backend/ba-auto-ship/src/OrderService.java",
        parentPath: "backend/ba-auto-ship/src",
        depth: 1,
        isMatch: true,
      },
      {
        name: "OrderTask.java",
        path: "backend/ba-auto-ship/src/OrderTask.java",
        parentPath: "backend/ba-auto-ship/src",
        depth: 1,
        isMatch: true,
      },
    ]);
  });

  it("filters scopes by name or path, orders selected first, and bounds visible header chips", () => {
    const scopes = buildAvailableRepoScopes({
      projects: [
        { environmentId: ENV, title: "ct-studio", workspaceRoot: "/work/ct-studio" },
        { environmentId: ENV, title: "alpha-service", workspaceRoot: "/work/alpha-service" },
        { environmentId: ENV, title: "beta-service", workspaceRoot: "/work/beta-service" },
        { environmentId: ENV, title: "gamma-web", workspaceRoot: "/work/repos/gamma-web" },
        { environmentId: ENV, title: "delta-api", workspaceRoot: "/work/repos/delta-api" },
      ],
      ctStudioRepos: [],
      customRepos: [],
    });

    const selected = [
      `${ENV}::/work/repos/gamma-web`,
      `${ENV}::/work/repos/delta-api`,
      `${ENV}::/work/beta-service`,
      `${ENV}::/work/alpha-service`,
    ];

    const ordered = filterAndSortRepoScopes(scopes, [`${ENV}::/work/repos/gamma-web`], "");
    expect(ordered.map((s) => s.name)).toEqual([
      "gamma-web",
      "alpha-service",
      "beta-service",
      "delta-api",
      "ct-studio",
    ]);

    const pathFiltered = filterAndSortRepoScopes(scopes, selected, "/work/repos/");
    expect(pathFiltered.map((s) => s.name)).toEqual(["delta-api", "gamma-web"]);

    const chips = partitionSelectedScopeChips(scopes, selected, 2);
    expect(chips.selectedScopes.map((s) => s.name)).toEqual([
      "alpha-service",
      "beta-service",
      "delta-api",
      "gamma-web",
    ]);
    expect(chips.visibleChips.map((s) => s.name)).toEqual(["alpha-service", "beta-service"]);
    expect(chips.overflowCount).toBe(2);
  });
});
