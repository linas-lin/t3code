import type * as Path from "effect/Path";

const DEFAULT_PROJECT_SLUG = "general";
export const GLOBAL_MEMORY_SCOPE = "global";

export interface PersonalPaths {
  readonly personalDir: string;
  readonly guardrailsPath: string;
  readonly profilePath: string;
  readonly workingPath: string;
  readonly lessonsDir: string;
  readonly statePath: string;
}

/**
 * Converts an arbitrary project identifier or title into a safe filename prefix.
 * Only `[a-z0-9-_]` characters are permitted; path separators and traversal tokens
 * are stripped and empty results fall back to `"general"`.
 */
export function toProjectSlug(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64)
    .replace(/^[-_]+|[-_]+$/g, "");

  if (normalized.length === 0 || !/[a-z0-9]/.test(normalized)) {
    return DEFAULT_PROJECT_SLUG;
  }

  return normalized;
}

/**
 * Normalizes a memory scope string. Empty/nullish scopes and `"global"` map to `"global"`;
 * all other values are normalized via `toProjectSlug`.
 */
export function normalizeMemoryScope(scope?: string | null): string {
  if (scope === null || scope === undefined) {
    return GLOBAL_MEMORY_SCOPE;
  }
  const trimmed = scope.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === GLOBAL_MEMORY_SCOPE) {
    return GLOBAL_MEMORY_SCOPE;
  }
  return toProjectSlug(trimmed);
}

/** Derives all Personal Agent storage paths from `ServerConfig.baseDir`. */
export function derivePersonalPaths(baseDir: string, path: Pick<Path.Path, "join">): PersonalPaths {
  const personalDir = path.join(baseDir, "personal");
  return {
    personalDir,
    guardrailsPath: path.join(personalDir, "guardrails.md"),
    profilePath: path.join(personalDir, "profile.md"),
    workingPath: path.join(personalDir, "working.md"),
    lessonsDir: path.join(personalDir, "lessons"),
    statePath: path.join(personalDir, "state.json"),
  };
}

/** Resolves the markdown file path for a given lesson scope under `lessonsDir`. */
export function lessonFilePath(
  paths: Pick<PersonalPaths, "lessonsDir">,
  scope: string,
  path: Pick<Path.Path, "join">,
): string {
  const normalizedScope = normalizeMemoryScope(scope);
  return path.join(paths.lessonsDir, `${normalizedScope}.md`);
}
