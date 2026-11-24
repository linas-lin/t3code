export const DEFAULT_CT_STUDIO_URL = "http://127.0.0.1:4600";
const CT_STUDIO_URL_STORAGE_KEY = "t3code:ct-studio:url";
const CT_STUDIO_REPO_URL_STORAGE_KEY = "t3code:ct-studio:repo-url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const NON_TICKET_PREFIXES = new Set([
  "UTF",
  "SHA",
  "HTTP",
  "HTTPS",
  "RFC",
  "ISO",
  "CVE",
  "ES",
  "PR",
  "MR",
  "MD",
  "TLS",
  "SSL",
  "AES",
  "RSA",
  "ARM",
  "X",
  "V",
]);
const TICKET_KEY_PATTERN = /\b([A-Z]{2,10}-\d+)\b/g;
const SCP_GIT_URL_PATTERN = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+):([^/\s][^:\s]*)$/;

function readBuildEnvString(key: string): string {
  try {
    const env = (import.meta as { env?: Record<string, unknown> }).env;
    const raw = env?.[key];
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

export function normalizeCtStudioUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""));
  } catch {
    return null;
  }
}

export function readCtStudioUrl(): string {
  try {
    const saved = window.localStorage.getItem(CT_STUDIO_URL_STORAGE_KEY);
    if (saved) {
      const normalized = normalizeCtStudioUrl(saved);
      if (normalized) return normalized;
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
  const fromEnv = normalizeCtStudioUrl(readBuildEnvString("VITE_CT_STUDIO_URL"));
  return fromEnv ?? DEFAULT_CT_STUDIO_URL;
}

export function writeCtStudioUrl(raw: string): string | null {
  const normalized = normalizeCtStudioUrl(raw);
  if (!normalized) return null;
  try {
    if (normalized === DEFAULT_CT_STUDIO_URL && !readBuildEnvString("VITE_CT_STUDIO_URL")) {
      window.localStorage.removeItem(CT_STUDIO_URL_STORAGE_KEY);
    } else {
      window.localStorage.setItem(CT_STUDIO_URL_STORAGE_KEY, normalized);
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
  return normalized;
}

export function normalizeGitRepoUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (SCP_GIT_URL_PATTERN.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:") {
      return null;
    }
    if (!parsed.pathname || parsed.pathname === "/") return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function toggleGitRepoProtocol(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const scp = SCP_GIT_URL_PATTERN.exec(trimmed);
  if (scp) {
    const host = scp[2];
    const repoPath = scp[3]?.replace(/^\/+/, "");
    if (!host || !repoPath) return null;
    const withGit = repoPath.endsWith(".git") ? repoPath : `${repoPath}.git`;
    return `https://${host}/${withGit}`;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const repoPath = parsed.pathname.replace(/^\/+/, "");
    if (!repoPath || !repoPath.includes("/")) return null;
    const withGit = repoPath.endsWith(".git") ? repoPath : `${repoPath}.git`;
    return `git@${parsed.host}:${withGit}`;
  } catch {
    return null;
  }
}

export function readCtStudioRepoUrl(): string {
  try {
    const saved = window.localStorage.getItem(CT_STUDIO_REPO_URL_STORAGE_KEY);
    if (saved) {
      const normalized = normalizeGitRepoUrl(saved);
      if (normalized) return normalized;
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
  return normalizeGitRepoUrl(readBuildEnvString("VITE_CT_STUDIO_REPO_URL")) ?? "";
}

export function writeCtStudioRepoUrl(raw: string): void {
  const normalized = normalizeGitRepoUrl(raw);
  try {
    if (normalized) {
      window.localStorage.setItem(CT_STUDIO_REPO_URL_STORAGE_KEY, normalized);
    } else {
      window.localStorage.removeItem(CT_STUDIO_REPO_URL_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
}

export type ClientPlatform = "macos" | "windows" | "other";

export function detectClientPlatform(
  platformHint?: string,
  userAgentHint?: string,
): ClientPlatform {
  const platform = (
    platformHint ?? (typeof navigator !== "undefined" ? navigator.platform : "")
  ).toLowerCase();
  const userAgent = (
    userAgentHint ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")
  ).toLowerCase();
  const combined = `${platform} ${userAgent}`;
  if (combined.includes("win")) return "windows";
  if (combined.includes("mac")) return "macos";
  return "other";
}

export function joinCtStudioClonePath(baseRoot: string | null | undefined): string {
  if (!baseRoot) return "~/projects/ct-studio";
  const usesBackslash = baseRoot.includes("\\") && !baseRoot.includes("/");
  const trimmed = baseRoot.replace(/[\\/]+$/, "");
  return usesBackslash ? `${trimmed}\\ct-studio` : `${trimmed}/ct-studio`;
}

export function isCtStudioWorkspace(project: {
  readonly title: string;
  readonly workspaceRoot: string;
}): boolean {
  const normalized = project.workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.endsWith("/ct-studio") || project.title.toLowerCase() === "ct-studio";
}

export function isTrustedCtStudioOrigin(origin: string, configuredUrl: string): boolean {
  try {
    const parsed = new URL(origin);
    const configured = new URL(configuredUrl);
    if (parsed.origin === configured.origin) return true;
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      LOOPBACK_HOSTS.has(parsed.hostname) &&
      LOOPBACK_HOSTS.has(configured.hostname) &&
      parsed.port === configured.port
    );
  } catch {
    return false;
  }
}

export function extractTicketKey(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const upper = candidate.toUpperCase();
    for (const match of upper.matchAll(TICKET_KEY_PATTERN)) {
      const key = match[1];
      if (!key) continue;
      const prefix = key.split("-")[0] ?? "";
      if (NON_TICKET_PREFIXES.has(prefix)) continue;
      return key;
    }
  }
  return null;
}

export function buildCtStudioUrl(
  baseUrl: string,
  options: {
    ticket?: string | undefined;
    stage?: string | undefined;
    view?: "timeline" | "jira" | "sessions" | "settings" | undefined;
  } = {},
): string {
  const normalized = normalizeCtStudioUrl(baseUrl) ?? DEFAULT_CT_STUDIO_URL;
  const parsed = new URL(`${normalized}/`);
  parsed.searchParams.set("embedded", "1");
  if (options.ticket?.trim()) {
    parsed.hash = `jira/${encodeURIComponent(options.ticket.trim())}`;
  } else if (options.view && options.view !== "timeline") {
    parsed.hash = options.view;
  }
  return parsed.toString();
}
