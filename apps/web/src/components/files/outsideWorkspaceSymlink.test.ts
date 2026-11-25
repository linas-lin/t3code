import { ProjectReadFileError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { resolveOutsideWorkspaceSymlinkPath } from "./outsideWorkspaceSymlink";

const decodeReadError = Schema.decodeSync(ProjectReadFileError);

describe("resolveOutsideWorkspaceSymlinkPath", () => {
  it("returns the resolved absolute target for a workspace-relative symlink escape", () => {
    const error = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Escaped workspace root.",
      failure: "resolved_path_outside_root",
      resolvedPath: "/Users/example/projects/t3code/apps/web/src/Sidebar.tsx",
    });
    expect(resolveOutsideWorkspaceSymlinkPath("hosts/t3code/apps/web/src/Sidebar.tsx", error)).toBe(
      "/Users/example/projects/t3code/apps/web/src/Sidebar.tsx",
    );
  });

  it("supports Windows drive targets", () => {
    const error = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Escaped workspace root.",
      failure: "resolved_path_outside_root",
      resolvedPath: "C:\\projects\\t3code\\Sidebar.tsx",
    });
    expect(resolveOutsideWorkspaceSymlinkPath("hosts/t3code/Sidebar.tsx", error)).toBe(
      "C:\\projects\\t3code\\Sidebar.tsx",
    );
  });

  it("ignores host paths, other failures, missing targets, and network paths", () => {
    const escapeError = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Escaped workspace root.",
      failure: "resolved_path_outside_root",
      resolvedPath: "/Users/example/projects/t3code/Sidebar.tsx",
    });
    expect(resolveOutsideWorkspaceSymlinkPath(null, escapeError)).toBeNull();
    expect(
      resolveOutsideWorkspaceSymlinkPath("/Users/example/projects/t3code/Sidebar.tsx", escapeError),
    ).toBeNull();
    expect(
      resolveOutsideWorkspaceSymlinkPath("~/projects/t3code/Sidebar.tsx", escapeError),
    ).toBeNull();

    const outsideRootError = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Outside root.",
      failure: "workspace_path_outside_root",
      resolvedPath: "/Users/example/projects/t3code/Sidebar.tsx",
    });
    expect(
      resolveOutsideWorkspaceSymlinkPath("hosts/t3code/Sidebar.tsx", outsideRootError),
    ).toBeNull();

    const missingTarget = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Escaped workspace root.",
      failure: "resolved_path_outside_root",
    });
    expect(
      resolveOutsideWorkspaceSymlinkPath("hosts/t3code/Sidebar.tsx", missingTarget),
    ).toBeNull();

    const relativeTarget = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Escaped workspace root.",
      failure: "resolved_path_outside_root",
      resolvedPath: "../t3code/Sidebar.tsx",
    });
    expect(
      resolveOutsideWorkspaceSymlinkPath("hosts/t3code/Sidebar.tsx", relativeTarget),
    ).toBeNull();

    const networkTarget = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Escaped workspace root.",
      failure: "resolved_path_outside_root",
      resolvedPath: "\\\\fileserver\\share\\Sidebar.tsx",
    });
    expect(
      resolveOutsideWorkspaceSymlinkPath("hosts/t3code/Sidebar.tsx", networkTarget),
    ).toBeNull();
  });
});
