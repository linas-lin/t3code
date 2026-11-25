import type { EnvironmentId, ProjectReadFileError } from "@t3tools/contracts";
import { isAbsolutePath, isHostPath, isNetworkPath } from "@t3tools/shared/path";

import type { MessageResolver } from "~/i18n/messages";

import { useProjectFileQuery } from "./projectFilesQueryState";

/**
 * Workspace-relative symlinks pointing outside the workspace root are rejected
 * by the server's relative-path check, while the server allows read-only reads
 * of the resolved host path directly (still blocking server internals and
 * network paths).
 */
export function resolveOutsideWorkspaceSymlinkPath(
  requestedPath: string | null,
  readError: ProjectReadFileError | null,
): string | null {
  if (
    requestedPath === null ||
    isHostPath(requestedPath) ||
    readError?.failure !== "resolved_path_outside_root"
  ) {
    return null;
  }
  const resolvedPath = readError.resolvedPath;
  if (
    !resolvedPath ||
    !isAbsolutePath(resolvedPath) ||
    isNetworkPath(resolvedPath) ||
    resolvedPath === requestedPath
  ) {
    return null;
  }
  return resolvedPath;
}

export function useProjectFileWithSymlinkFallback(
  environmentId: EnvironmentId,
  cwd: string,
  requestedPath: string | null,
  enabled: boolean,
  resolve: MessageResolver,
) {
  const requestedFile = useProjectFileQuery(environmentId, cwd, requestedPath, enabled, resolve);
  const fallbackPath = enabled
    ? resolveOutsideWorkspaceSymlinkPath(requestedPath, requestedFile.readError)
    : null;
  const fallbackFile = useProjectFileQuery(
    environmentId,
    cwd,
    fallbackPath,
    enabled && fallbackPath !== null,
    resolve,
  );
  return {
    relativePath: fallbackPath ?? requestedPath,
    file: fallbackPath !== null ? fallbackFile : requestedFile,
  };
}
