import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_MANIFEST_FILENAME = "ct-plugin.json";
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const PLUGIN_PERMISSIONS = [
  "threads",
  "workspace",
  "backend",
  "network",
  "mcp",
  "host-callback",
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

const PLUGIN_SLOTS = [
  "mainView",
  "threadPanel",
  "threadBanner",
  "settingsSection",
  "commands",
] as const;
export type PluginSlot = (typeof PLUGIN_SLOTS)[number];

const PLUGIN_BACKEND_ACTIVATIONS = ["startup", "lazy"] as const;
export type PluginBackendActivation = (typeof PLUGIN_BACKEND_ACTIVATIONS)[number];

export type PluginBackendStatus = "none" | "stopped" | "starting" | "running" | "error";

export interface CtPluginUiConfig {
  readonly entry: string;
  readonly css?: string | undefined;
}

export interface CtPluginBackendConfig {
  readonly activation: PluginBackendActivation;
  readonly command: ReadonlyArray<string>;
  readonly healthcheck: string;
  readonly cwd?: string | undefined;
}

export interface CtPluginBuildConfig {
  readonly command?: ReadonlyArray<string> | undefined;
}

export interface CtPluginSidebarConfig {
  readonly label: string;
  readonly icon?: string | undefined;
  readonly shortcut?: string | undefined;
}

export interface CtPluginContributes {
  readonly sidebar?: CtPluginSidebarConfig | undefined;
  readonly slots?: ReadonlyArray<PluginSlot> | undefined;
}

export interface CtPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly apiVersion: 1;
  readonly ui?: CtPluginUiConfig | undefined;
  readonly backend?: CtPluginBackendConfig | undefined;
  readonly build?: CtPluginBuildConfig | undefined;
  readonly permissions?: ReadonlyArray<PluginPermission> | undefined;
  readonly contributes?: CtPluginContributes | undefined;
}

export type PluginSource =
  | {
      readonly kind: "git";
      readonly url: string;
      readonly ref?: string | undefined;
      readonly commit?: string | undefined;
    }
  | {
      readonly kind: "local";
      readonly path: string;
    };

export interface PluginRegistryRecord {
  readonly id: string;
  readonly source: PluginSource;
  readonly rootDir: string;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly reloadNonce: number;
}

export interface PluginRegistryFile {
  readonly version: 1;
  readonly plugins: ReadonlyArray<PluginRegistryRecord>;
}

export interface PluginBackendStateView {
  readonly configured: boolean;
  readonly activation: PluginBackendActivation | null;
  readonly status: PluginBackendStatus;
  readonly error: string | null;
  readonly startedAt: string | null;
}

export interface PluginRecordView {
  readonly id: string;
  readonly source: PluginSource;
  readonly rootDir: string;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly reloadNonce: number;
  readonly manifest: CtPluginManifest | null;
  readonly manifestError: string | null;
  readonly uiReady: boolean;
  readonly backend: PluginBackendStateView;
}

export type PluginInstallRequest =
  | {
      readonly source: "git";
      readonly url: string;
      readonly ref?: string | undefined;
      readonly runBuild?: boolean | undefined;
    }
  | {
      readonly source: "local";
      readonly path: string;
      readonly runBuild?: boolean | undefined;
    };

export interface PluginEnableRequest {
  readonly enabled: boolean;
}

export interface PluginUpdateRequest {
  readonly runBuild?: boolean | undefined;
}

export interface PluginUninstallRequest {
  readonly removeData?: boolean | undefined;
}

export interface PluginUpdateResult {
  readonly plugin: PluginRecordView;
  readonly updated: boolean;
  readonly commit?: string | undefined;
}

export interface PluginAssetPayload {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly filePath: string;
}

export interface PluginBackendEndpoint {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

export const PluginErrorCode = Schema.Literals([
  "invalid_request",
  "invalid_manifest",
  "not_found",
  "conflict",
  "forbidden",
  "git_error",
  "build_error",
  "backend_error",
  "internal_error",
]);
export type PluginErrorCode = typeof PluginErrorCode.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  code: PluginErrorCode,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export function pluginErrorHttpStatus(error: PluginError): number {
  if (error.status !== undefined) {
    return error.status;
  }
  switch (error.code) {
    case "invalid_request":
    case "invalid_manifest":
      return 400;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "backend_error":
      return 502;
    case "git_error":
    case "build_error":
    case "internal_error":
      return 500;
  }
}

const PLUGIN_PERMISSION_SET = new Set<string>(PLUGIN_PERMISSIONS);
const PLUGIN_SLOT_SET = new Set<string>(PLUGIN_SLOTS);
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidPluginId(id: string): boolean {
  return PLUGIN_ID_PATTERN.test(id);
}

export type RelativePathValidationResult =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly error: string };

export function validatePluginRelativePath(
  rawPath: unknown,
  fieldName: string,
  options?: { readonly allowRootDot?: boolean | undefined },
): RelativePathValidationResult {
  if (typeof rawPath !== "string") {
    return { ok: false, error: `${fieldName} must be a string.` };
  }
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: `${fieldName} must not be empty.` };
  }
  if (trimmed.includes("\0")) {
    return { ok: false, error: `${fieldName} contains an invalid null byte.` };
  }
  if (trimmed.includes("\\")) {
    return { ok: false, error: `${fieldName} must use forward slashes ('/').` };
  }
  if (trimmed.startsWith("/") || WINDOWS_DRIVE_PREFIX.test(trimmed)) {
    return { ok: false, error: `${fieldName} must be a relative path within the plugin root.` };
  }

  const rawSegments = trimmed.split("/");
  const normalizedSegments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return { ok: false, error: `${fieldName} must not traverse outside the plugin root ('..').` };
    }
    normalizedSegments.push(segment);
  }

  if (normalizedSegments.length === 0) {
    if (options?.allowRootDot === true) {
      return { ok: true, normalized: "." };
    }
    return { ok: false, error: `${fieldName} must point to a file within the plugin root.` };
  }

  return { ok: true, normalized: normalizedSegments.join("/") };
}

export function isPathWithinRoot(rootDir: string, candidatePath: string, sep = "/"): boolean {
  const normalizedRoot =
    rootDir.length > 1 && rootDir.endsWith(sep) ? rootDir.slice(0, -sep.length) : rootDir;
  if (candidatePath === normalizedRoot) {
    return true;
  }
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return candidatePath.startsWith(prefix);
}

export const resolveSafePluginSubpath = Effect.fn("plugins.resolveSafePluginSubpath")(function* (
  rootDir: string,
  relativePath: string,
  fieldName: string,
  fs: FileSystem.FileSystem,
  pathApi: Path.Path,
  options?: {
    readonly allowRootDot?: boolean | undefined;
    readonly requireExisting?: boolean | undefined;
  },
) {
  const validated = validatePluginRelativePath(relativePath, fieldName, {
    allowRootDot: options?.allowRootDot,
  });
  if (!validated.ok) {
    return yield* new PluginError({
      code: "forbidden",
      message: validated.error,
      status: 400,
    });
  }

  const realRoot = yield* fs.realPath(rootDir).pipe(
    Effect.mapError(
      () =>
        new PluginError({
          code: "not_found",
          message: `Plugin root directory does not exist: ${rootDir}`,
          status: 404,
        }),
    ),
  );

  const candidate =
    validated.normalized === "." ? realRoot : pathApi.resolve(realRoot, validated.normalized);

  if (!isPathWithinRoot(realRoot, candidate, pathApi.sep)) {
    return yield* new PluginError({
      code: "forbidden",
      message: `${fieldName} escapes the plugin root directory.`,
      status: 403,
    });
  }

  const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    if (options?.requireExisting) {
      return yield* new PluginError({
        code: "not_found",
        message: `${fieldName} not found: ${validated.normalized}`,
        status: 404,
      });
    }
    return { realRoot, resolvedPath: candidate, normalized: validated.normalized };
  }

  const realCandidate = yield* fs.realPath(candidate).pipe(
    Effect.mapError(
      () =>
        new PluginError({
          code: "not_found",
          message: `${fieldName} could not be resolved: ${validated.normalized}`,
          status: 404,
        }),
    ),
  );

  if (!isPathWithinRoot(realRoot, realCandidate, pathApi.sep)) {
    return yield* new PluginError({
      code: "forbidden",
      message: `${fieldName} resolves via symlink outside the plugin root directory.`,
      status: 403,
    });
  }

  return { realRoot, resolvedPath: realCandidate, normalized: validated.normalized };
});

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: CtPluginManifest }
  | { readonly ok: false; readonly error: string };

function validateCommandArray(
  raw: unknown,
  fieldName: string,
):
  | { readonly ok: true; readonly command: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: `${fieldName} must be a non-empty array of strings.` };
  }
  const command: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== "string") {
      return { ok: false, error: `${fieldName}[${i}] must be a string.` };
    }
    if (i === 0 && item.trim().length === 0) {
      return { ok: false, error: `${fieldName}[0] must be a non-empty executable name.` };
    }
    if (item.includes("\0")) {
      return { ok: false, error: `${fieldName}[${i}] contains an invalid null byte.` };
    }
    command.push(item);
  }
  return { ok: true, command };
}

export function parsePluginManifest(raw: unknown): ManifestParseResult {
  if (!isRecord(raw)) {
    return { ok: false, error: "Manifest must be a JSON object." };
  }

  if (typeof raw.apiVersion !== "number" || !Number.isInteger(raw.apiVersion)) {
    return {
      ok: false,
      error: `Invalid or missing apiVersion (expected ${PLUGIN_API_VERSION}).`,
    };
  }
  if (raw.apiVersion !== PLUGIN_API_VERSION) {
    return {
      ok: false,
      error: `Unsupported plugin apiVersion ${raw.apiVersion}; this host only supports apiVersion ${PLUGIN_API_VERSION}.`,
    };
  }

  if (typeof raw.id !== "string" || !isValidPluginId(raw.id)) {
    return {
      ok: false,
      error: `Invalid plugin id "${String(raw.id ?? "")}": must match ${PLUGIN_ID_PATTERN.source}.`,
    };
  }

  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    return { ok: false, error: "Manifest field 'name' must be a non-empty string." };
  }

  if (typeof raw.version !== "string" || raw.version.trim().length === 0) {
    return { ok: false, error: "Manifest field 'version' must be a non-empty string." };
  }

  let description: string | undefined;
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") {
      return { ok: false, error: "Manifest field 'description' must be a string." };
    }
    description = raw.description;
  }

  let ui: CtPluginUiConfig | undefined;
  if (raw.ui !== undefined) {
    if (!isRecord(raw.ui)) {
      return { ok: false, error: "Manifest field 'ui' must be an object." };
    }
    const entryCheck = validatePluginRelativePath(raw.ui.entry, "ui.entry");
    if (!entryCheck.ok) {
      return { ok: false, error: entryCheck.error };
    }
    let css: string | undefined;
    if (raw.ui.css !== undefined) {
      const cssCheck = validatePluginRelativePath(raw.ui.css, "ui.css");
      if (!cssCheck.ok) {
        return { ok: false, error: cssCheck.error };
      }
      css = cssCheck.normalized;
    }
    ui = {
      entry: entryCheck.normalized,
      ...(css !== undefined ? { css } : {}),
    };
  }

  let backend: CtPluginBackendConfig | undefined;
  if (raw.backend !== undefined) {
    if (!isRecord(raw.backend)) {
      return { ok: false, error: "Manifest field 'backend' must be an object." };
    }
    let activation: PluginBackendActivation = "lazy";
    if (raw.backend.activation !== undefined) {
      if (raw.backend.activation !== "startup" && raw.backend.activation !== "lazy") {
        return {
          ok: false,
          error: `Invalid backend.activation "${String(raw.backend.activation)}": expected "startup" or "lazy".`,
        };
      }
      activation = raw.backend.activation;
    }
    const commandCheck = validateCommandArray(raw.backend.command, "backend.command");
    if (!commandCheck.ok) {
      return { ok: false, error: commandCheck.error };
    }
    let healthcheck = "/api/health";
    if (raw.backend.healthcheck !== undefined) {
      if (
        typeof raw.backend.healthcheck !== "string" ||
        !raw.backend.healthcheck.startsWith("/") ||
        raw.backend.healthcheck.startsWith("//") ||
        /[\r\n\0]/.test(raw.backend.healthcheck)
      ) {
        return {
          ok: false,
          error: "Manifest field 'backend.healthcheck' must be a relative path starting with '/'.",
        };
      }
      healthcheck = raw.backend.healthcheck;
    }
    let cwd: string | undefined;
    if (raw.backend.cwd !== undefined) {
      const cwdCheck = validatePluginRelativePath(raw.backend.cwd, "backend.cwd", {
        allowRootDot: true,
      });
      if (!cwdCheck.ok) {
        return { ok: false, error: cwdCheck.error };
      }
      cwd = cwdCheck.normalized;
    }
    backend = {
      activation,
      command: commandCheck.command,
      healthcheck,
      ...(cwd !== undefined ? { cwd } : {}),
    };
  }

  let build: CtPluginBuildConfig | undefined;
  if (raw.build !== undefined) {
    if (!isRecord(raw.build)) {
      return { ok: false, error: "Manifest field 'build' must be an object." };
    }
    if (raw.build.command !== undefined) {
      const buildCommandCheck = validateCommandArray(raw.build.command, "build.command");
      if (!buildCommandCheck.ok) {
        return { ok: false, error: buildCommandCheck.error };
      }
      build = { command: buildCommandCheck.command };
    } else {
      build = {};
    }
  }

  let permissions: ReadonlyArray<PluginPermission> | undefined;
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) {
      return { ok: false, error: "Manifest field 'permissions' must be an array." };
    }
    const deduped = new Set<PluginPermission>();
    for (const item of raw.permissions) {
      if (typeof item !== "string" || !PLUGIN_PERMISSION_SET.has(item)) {
        return {
          ok: false,
          error: `Unsupported plugin permission "${String(item)}".`,
        };
      }
      deduped.add(item as PluginPermission);
    }
    permissions = [...deduped];
  }

  let contributes: CtPluginContributes | undefined;
  if (raw.contributes !== undefined) {
    if (!isRecord(raw.contributes)) {
      return { ok: false, error: "Manifest field 'contributes' must be an object." };
    }
    let sidebar: CtPluginSidebarConfig | undefined;
    if (raw.contributes.sidebar !== undefined) {
      if (!isRecord(raw.contributes.sidebar)) {
        return { ok: false, error: "Manifest field 'contributes.sidebar' must be an object." };
      }
      if (
        typeof raw.contributes.sidebar.label !== "string" ||
        raw.contributes.sidebar.label.trim().length === 0
      ) {
        return {
          ok: false,
          error: "Manifest field 'contributes.sidebar.label' must be a non-empty string.",
        };
      }
      if (
        raw.contributes.sidebar.icon !== undefined &&
        typeof raw.contributes.sidebar.icon !== "string"
      ) {
        return {
          ok: false,
          error: "Manifest field 'contributes.sidebar.icon' must be a string.",
        };
      }
      if (
        raw.contributes.sidebar.shortcut !== undefined &&
        typeof raw.contributes.sidebar.shortcut !== "string"
      ) {
        return {
          ok: false,
          error: "Manifest field 'contributes.sidebar.shortcut' must be a string.",
        };
      }
      sidebar = {
        label: raw.contributes.sidebar.label.trim(),
        ...(raw.contributes.sidebar.icon !== undefined
          ? { icon: raw.contributes.sidebar.icon }
          : {}),
        ...(raw.contributes.sidebar.shortcut !== undefined
          ? { shortcut: raw.contributes.sidebar.shortcut }
          : {}),
      };
    }

    let slots: ReadonlyArray<PluginSlot> | undefined;
    if (raw.contributes.slots !== undefined) {
      if (!Array.isArray(raw.contributes.slots)) {
        return { ok: false, error: "Manifest field 'contributes.slots' must be an array." };
      }
      const dedupedSlots = new Set<PluginSlot>();
      for (const slot of raw.contributes.slots) {
        if (typeof slot !== "string" || !PLUGIN_SLOT_SET.has(slot)) {
          return { ok: false, error: `Unsupported plugin slot "${String(slot)}".` };
        }
        dedupedSlots.add(slot as PluginSlot);
      }
      slots = [...dedupedSlots];
    }

    contributes = {
      ...(sidebar !== undefined ? { sidebar } : {}),
      ...(slots !== undefined ? { slots } : {}),
    };
  }

  return {
    ok: true,
    manifest: {
      id: raw.id,
      name: raw.name.trim(),
      version: raw.version.trim(),
      ...(description !== undefined ? { description } : {}),
      apiVersion: PLUGIN_API_VERSION,
      ...(ui !== undefined ? { ui } : {}),
      ...(backend !== undefined ? { backend } : {}),
      ...(build !== undefined ? { build } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
      ...(contributes !== undefined ? { contributes } : {}),
    },
  };
}

export function parsePluginManifestJson(rawJson: string): ManifestParseResult {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return parsePluginManifest(parsed);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `Invalid JSON in ${PLUGIN_MANIFEST_FILENAME}: ${detail}` };
  }
}

export function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function safeStringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
