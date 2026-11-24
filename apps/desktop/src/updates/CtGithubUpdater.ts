// @effect-diagnostics nodeBuiltinImport:off -- Launches detached OS installer scripts and streams downloaded installers to disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Electron from "electron";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";

const DEFAULT_CT_UPDATE_REPO = "linas-lin/t3code";
const CT_TAG_PREFIX = "ct-v";
const CT_APP_NAME = "T3 Code (CT).app";
const DEFAULT_MAC_APP_PATH = `/Applications/${CT_APP_NAME}`;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const USER_AGENT = "t3-code-ct-updater";
const RELEASE_NOTES_TIMEOUT_MS = 5_000;

export interface CtReleaseCandidate {
  readonly tag: string;
  readonly version: string;
  readonly assetName: string;
  readonly downloadUrl: string;
  readonly releaseNotes?: string | undefined;
  readonly releaseDate?: string | undefined;
}

interface DownloadedCtRelease extends CtReleaseCandidate {
  readonly filePath: string;
}

interface GitHubReleaseApiAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
}

interface GitHubReleaseApiEntry {
  readonly draft?: unknown;
  readonly tag_name?: unknown;
  readonly body?: unknown;
  readonly published_at?: unknown;
  readonly assets?: unknown;
}

export type CtUpdaterFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type CtUpdaterSpawnDetached = (command: string, args: readonly string[]) => void;

export interface CtGithubUpdaterDeps {
  readonly repo: string;
  readonly platform: NodeJS.Platform;
  readonly hostArch: string;
  readonly currentVersion: string;
  readonly appPath: string;
  readonly execPath: string;
  readonly baseDir: string;
  readonly logDir: string;
  readonly tempDir?: string;
  readonly pid?: number;
  readonly fetchFn?: CtUpdaterFetch;
  readonly spawnDetached?: CtUpdaterSpawnDetached;
  readonly quitApp: Effect.Effect<void>;
}

export function parseCtReleaseTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!trimmed.startsWith(CT_TAG_PREFIX)) {
    return null;
  }
  const version = trimmed.slice(CT_TAG_PREFIX.length);
  return SEMVER_PATTERN.test(version) ? version : null;
}

export function resolveCtAssetName(
  platform: NodeJS.Platform,
  hostArch: string,
  version: string,
): string | null {
  const arch = hostArch === "arm64" ? "arm64" : hostArch === "x64" ? "x64" : null;
  if (arch === null) {
    return null;
  }
  if (platform === "darwin") {
    return `T3-Code-CT-${version}-${arch}.dmg`;
  }
  if (platform === "win32") {
    return `T3-Code-CT-${version}-${arch}.exe`;
  }
  return null;
}

export function resolveMacAppBundlePath(appPath: string, execPath?: string): string {
  for (const candidate of [execPath, appPath]) {
    if (!candidate) continue;
    const normalized = candidate.replace(/\\/g, "/");
    const match = normalized.match(/^(.*?\.app)(?:\/|$)/);
    if (match?.[1] && !match[1].startsWith("/Volumes/")) {
      return match[1];
    }
  }
  return DEFAULT_MAC_APP_PATH;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildMacInstallScript(input: {
  readonly parentPid: number;
  readonly dmgPath: string;
  readonly destAppPath: string;
  readonly logPath: string;
}): string {
  const destDir = NodePath.posix.dirname(input.destAppPath);
  const appName = NodePath.posix.basename(input.destAppPath);
  return `#!/usr/bin/env bash
set -euo pipefail

PARENT_PID=${Math.trunc(input.parentPid)}
DMG_PATH=${shellQuote(input.dmgPath)}
DEST_APP=${shellQuote(input.destAppPath)}
DEST_DIR=${shellQuote(destDir)}
APP_NAME=${shellQuote(appName)}
LOG_PATH=${shellQuote(input.logPath)}
SCRIPT_PATH="$0"

mkdir -p "$(dirname "$LOG_PATH")" 2>/dev/null || true
exec >>"$LOG_PATH" 2>&1

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting T3 Code (CT) macOS update from $DMG_PATH -> $DEST_APP"

for _ in $(seq 1 60); do
  if ! kill -0 "$PARENT_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

WORK_DIR="$(mktemp -d "\${TMPDIR:-/tmp}/t3-code-ct-apply.XXXXXX")"
MOUNT_DIR="$WORK_DIR/mnt"
MOUNTED=0

cleanup() {
  if [[ "$MOUNTED" -eq 1 ]]; then
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || hdiutil detach "$MOUNT_DIR" -force -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR" "$SCRIPT_PATH" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$MOUNT_DIR"
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_DIR" "$DMG_PATH" -quiet
MOUNTED=1

SRC_APP="$MOUNT_DIR/$APP_NAME"
if [[ ! -d "$SRC_APP" ]]; then
  SRC_APP="$(find "$MOUNT_DIR" -maxdepth 1 -name '*.app' -print -quit)"
fi
if [[ -z "$SRC_APP" || ! -d "$SRC_APP" ]]; then
  echo "Error: app bundle not found in mounted DMG."
  exit 1
fi

mkdir -p "$DEST_DIR" 2>/dev/null || true
if [[ -w "$DEST_DIR" ]] && [[ ! -e "$DEST_APP" || -w "$DEST_APP" ]]; then
  rm -rf "$DEST_APP"
  ditto "$SRC_APP" "$DEST_APP"
  xattr -cr "$DEST_APP" || true
else
  /usr/bin/osascript - "$SRC_APP" "$DEST_APP" <<'APPLESCRIPT'
on run argv
  set srcApp to item 1 of argv
  set destApp to item 2 of argv
  set cmd to "rm -rf " & quoted form of destApp & " && ditto " & quoted form of srcApp & " " & quoted form of destApp & " && (xattr -cr " & quoted form of destApp & " || true)"
  do shell script cmd with administrator privileges
end run
APPLESCRIPT
fi

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Update applied; relaunching $DEST_APP"
open "$DEST_APP"
`;
}

export function buildWindowsInstallScript(input: {
  readonly parentPid: number;
  readonly installerPath: string;
  readonly appExePath: string;
  readonly isSilent: boolean;
  readonly isForceRunAfter: boolean;
  readonly logPath: string;
}): string {
  const installerArg = input.isSilent ? "-ArgumentList '/S'" : "";
  const relaunchBlock = input.isForceRunAfter
    ? `
if ($ExitCode -eq 0 -and (Test-Path -LiteralPath $AppExePath)) {
  Start-Process -FilePath $AppExePath
}`
    : "";
  return `$ErrorActionPreference = 'Stop'
$ParentPid = ${Math.trunc(input.parentPid)}
$InstallerPath = ${powerShellQuote(input.installerPath)}
$AppExePath = ${powerShellQuote(input.appExePath)}
$LogPath = ${powerShellQuote(input.logPath)}
$ScriptPath = $MyInvocation.MyCommand.Path

function Write-Log([string]$Message) {
  try {
    $Dir = Split-Path -Parent $LogPath
    if ($Dir -and -not (Test-Path -LiteralPath $Dir)) {
      New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    }
    Add-Content -LiteralPath $LogPath -Value ("[" + (Get-Date).ToUniversalTime().ToString("o") + "] " + $Message)
  } catch {}
}

try {
  Write-Log "Starting T3 Code (CT) Windows update from $InstallerPath"
  for ($i = 0; $i -lt 60; $i++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
      break
    }
    Start-Sleep -Milliseconds 500
  }

  try {
    Unblock-File -LiteralPath $InstallerPath -ErrorAction SilentlyContinue
  } catch {}

  $Proc = Start-Process -FilePath $InstallerPath ${installerArg} -Wait -PassThru
  $ExitCode = if ($null -ne $Proc) { $Proc.ExitCode } else { 0 }
  Write-Log "Installer finished with exit code $ExitCode"
${relaunchBlock}
} catch {
  Write-Log ("Update failed: " + $_.Exception.Message)
} finally {
  if ($ScriptPath -and (Test-Path -LiteralPath $ScriptPath)) {
    Remove-Item -LiteralPath $ScriptPath -Force -ErrorAction SilentlyContinue
  }
}
`;
}

function defaultFetch(): CtUpdaterFetch {
  if (typeof Electron.net?.fetch === "function") {
    return (input, init) => Electron.net.fetch(input, init);
  }
  // @effect-diagnostics-next-line globalFetch:off -- Fallback outside Electron runtime; production uses Electron.net.fetch for OS proxy support.
  return (input, init) => globalThis.fetch(input, init);
}

function defaultSpawnDetached(command: string, args: readonly string[]): void {
  const child = NodeChildProcess.spawn(command, [...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function parseTagFromReleaseUrl(url: string): string | null {
  const match = url.match(/\/releases\/tag\/([^/?#]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function assetExists(fetchFn: CtUpdaterFetch, url: string): Promise<boolean> {
  try {
    // Electron net.fetch rejects on redirect: "manual", so follow redirects and inspect the final status.
    const head = await fetchFn(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });
    if (head.ok) {
      return true;
    }
    if (head.status !== 405 && head.status !== 403) {
      return false;
    }
  } catch {
    // Fall through to a 1-byte Range GET probe for CDNs that reject HEAD.
  }

  try {
    const probe = await fetchFn(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Range: "bytes=0-0" },
    });
    await probe.body?.cancel().catch(() => undefined);
    return probe.ok || probe.status === 206;
  } catch {
    return false;
  }
}

async function fetchReleaseMetadataBestEffort(
  fetchFn: CtUpdaterFetch,
  repo: string,
  tag: string,
): Promise<{ readonly releaseNotes?: string; readonly releaseDate?: string }> {
  try {
    const response = await fetchFn(
      `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(RELEASE_NOTES_TIMEOUT_MS),
      },
    );
    if (!response.ok) return {};
    const json = (await response.json()) as GitHubReleaseApiEntry;
    return {
      ...(typeof json.body === "string" && json.body.trim().length > 0
        ? { releaseNotes: json.body }
        : {}),
      ...(typeof json.published_at === "string" ? { releaseDate: json.published_at } : {}),
    };
  } catch {
    return {};
  }
}

async function resolveLatestReleaseViaApi(
  fetchFn: CtUpdaterFetch,
  repo: string,
  platform: NodeJS.Platform,
  hostArch: string,
): Promise<CtReleaseCandidate | null> {
  const response = await fetchFn(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub Releases API returned HTTP ${response.status}.`);
  }
  const entries = (await response.json()) as unknown;
  if (!Array.isArray(entries)) {
    return null;
  }

  for (const raw of entries as ReadonlyArray<GitHubReleaseApiEntry>) {
    if (raw.draft === true || typeof raw.tag_name !== "string") continue;
    const version = parseCtReleaseTag(raw.tag_name);
    if (!version) continue;
    const expectedAssetName = resolveCtAssetName(platform, hostArch, version);
    if (!expectedAssetName) return null;
    if (!Array.isArray(raw.assets)) continue;

    const matchedAsset = (raw.assets as ReadonlyArray<GitHubReleaseApiAsset>).find(
      (asset) => asset.name === expectedAssetName && typeof asset.browser_download_url === "string",
    );
    if (!matchedAsset || typeof matchedAsset.browser_download_url !== "string") {
      continue;
    }

    return {
      tag: raw.tag_name,
      version,
      assetName: expectedAssetName,
      downloadUrl: matchedAsset.browser_download_url,
      ...(typeof raw.body === "string" && raw.body.trim().length > 0
        ? { releaseNotes: raw.body }
        : {}),
      ...(typeof raw.published_at === "string" ? { releaseDate: raw.published_at } : {}),
    };
  }
  return null;
}

function parseTagFromReleaseHtml(html: string, repo: string): string | null {
  const canonicalMatch = html.match(
    /(?:property=["']og:url["'][^>]*content|rel=["']canonical["'][^>]*href)=["'][^"']*\/releases\/tag\/([^"'/?#]+)/i,
  );
  if (canonicalMatch?.[1]) {
    return parseTagFromReleaseUrl(`/releases/tag/${canonicalMatch[1]}`);
  }
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const repoTagMatch = html.match(new RegExp(`/${escapedRepo}/releases/tag/(ct-v[^"'/?#<>\\s]+)`));
  if (repoTagMatch?.[1]) {
    return parseTagFromReleaseUrl(`/releases/tag/${repoTagMatch[1]}`);
  }
  return null;
}

async function resolveLatestCtRelease(input: {
  readonly fetchFn: CtUpdaterFetch;
  readonly repo: string;
  readonly platform: NodeJS.Platform;
  readonly hostArch: string;
}): Promise<CtReleaseCandidate | null> {
  const { fetchFn, repo, platform, hostArch } = input;
  if (resolveCtAssetName(platform, hostArch, "0.0.0") === null) {
    return null;
  }

  // Prefer the unauthenticated /releases/latest HTML page to avoid GitHub API rate limits.
  // Electron's net.fetch leaves Response.url empty after redirects, so fall back to parsing the HTML.
  try {
    const latestResponse = await fetchFn(`https://github.com/${repo}/releases/latest`, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });
    const finalUrl = latestResponse.url || latestResponse.headers.get("location") || "";
    let tag = finalUrl ? parseTagFromReleaseUrl(finalUrl) : null;
    if (!tag && latestResponse.ok) {
      const html = await latestResponse.text();
      tag = parseTagFromReleaseHtml(html, repo);
    } else {
      await latestResponse.body?.cancel().catch(() => undefined);
    }
    const version = tag ? parseCtReleaseTag(tag) : null;
    if (tag && version) {
      const assetName = resolveCtAssetName(platform, hostArch, version);
      if (assetName) {
        const downloadUrl = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
        if (await assetExists(fetchFn, downloadUrl)) {
          return {
            tag,
            version,
            assetName,
            downloadUrl,
          };
        }
      }
    }
  } catch {
    // Fall back to the GitHub Releases API below.
  }

  return resolveLatestReleaseViaApi(fetchFn, repo, platform, hostArch);
}

async function cleanupOldUpdateFiles(dir: string, keepFileName: string): Promise<void> {
  try {
    const entries = await NodeFSP.readdir(dir);
    await Promise.all(
      entries
        .filter((entry) => entry !== keepFileName)
        .map((entry) => NodeFSP.rm(NodePath.join(dir, entry), { force: true, recursive: true })),
    );
  } catch {
    // Non-fatal cleanup failure.
  }
}

export function makeCtGithubUpdater(
  deps: CtGithubUpdaterDeps,
): ElectronUpdater.ElectronUpdater["Service"] {
  const fetchFn = deps.fetchFn ?? defaultFetch();
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
  const listeners = new Map<string, Set<(...args: Array<unknown>) => void>>();

  let channel = "latest";
  let allowDowngrade = false;
  let availableRelease: CtReleaseCandidate | null = null;
  let downloadedRelease: DownloadedCtRelease | null = null;

  const emit = (eventName: string, ...args: Array<unknown>): void => {
    const handlers = listeners.get(eventName);
    if (!handlers) return;
    for (const handler of Array.from(handlers)) {
      handler(...args);
    }
  };

  return ElectronUpdater.ElectronUpdater.of({
    setFeedURL: Effect.fn("CtGithubUpdater.setFeedURL")(() => Effect.void),
    setAutoDownload: Effect.fn("CtGithubUpdater.setAutoDownload")(() => Effect.void),
    setAutoInstallOnAppQuit: Effect.fn("CtGithubUpdater.setAutoInstallOnAppQuit")(
      () => Effect.void,
    ),
    setChannel: Effect.fn("CtGithubUpdater.setChannel")((nextChannel) =>
      Effect.sync(() => {
        channel = nextChannel;
      }),
    ),
    setAllowPrerelease: Effect.fn("CtGithubUpdater.setAllowPrerelease")(() => Effect.void),
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: Effect.fn("CtGithubUpdater.setAllowDowngrade")((value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    ),
    setFullChangelog: Effect.fn("CtGithubUpdater.setFullChangelog")(() => Effect.void),
    setDisableDifferentialDownload: Effect.fn("CtGithubUpdater.setDisableDifferentialDownload")(
      () => Effect.void,
    ),
    checkForUpdates: Effect.suspend(() => {
      const currentChannel = channel;
      return Effect.tryPromise({
        try: async () => {
          emit("checking-for-update");
          const candidate = await resolveLatestCtRelease({
            fetchFn,
            repo: deps.repo,
            platform: deps.platform,
            hostArch: deps.hostArch,
          });
          if (!candidate) {
            availableRelease = null;
            emit("update-not-available");
            return;
          }

          const comparison = compareSemverVersions(candidate.version, deps.currentVersion);
          const isOfferable = comparison > 0 || (allowDowngrade && comparison !== 0);
          if (!isOfferable) {
            availableRelease = null;
            emit("update-not-available");
            return;
          }

          let enriched = candidate;
          if (enriched.releaseNotes === undefined && enriched.releaseDate === undefined) {
            const metadata = await fetchReleaseMetadataBestEffort(
              fetchFn,
              deps.repo,
              candidate.tag,
            );
            enriched = { ...candidate, ...metadata };
          }
          availableRelease = enriched;
          emit("update-available", {
            version: enriched.version,
            releaseName: enriched.tag,
            ...(enriched.releaseNotes !== undefined ? { releaseNotes: enriched.releaseNotes } : {}),
            ...(enriched.releaseDate !== undefined ? { releaseDate: enriched.releaseDate } : {}),
          });
        },
        catch: (cause) =>
          new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
            channel: currentChannel,
            cause,
          }),
      });
    }),
    downloadUpdate: Effect.suspend(() => {
      const currentChannel = channel;
      return Effect.tryPromise({
        try: async () => {
          if (!availableRelease) {
            throw new Error("No available T3 Code (CT) update to download.");
          }
          const release = availableRelease;
          const updatesDir = NodePath.join(deps.baseDir, "runtime", "ct-updates");
          await NodeFSP.mkdir(updatesDir, { recursive: true });
          const destPath = NodePath.join(updatesDir, release.assetName);
          const partPath = `${destPath}.part`;

          const response = await fetchFn(release.downloadUrl, {
            method: "GET",
            redirect: "follow",
            headers: { "User-Agent": USER_AGENT },
          });
          if (!response.ok || !response.body) {
            throw new Error(`Failed to download ${release.assetName}: HTTP ${response.status}.`);
          }

          const contentLengthHeader = response.headers.get("content-length");
          const totalBytes =
            contentLengthHeader !== null ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;
          const hasTotalBytes = Number.isFinite(totalBytes) && totalBytes > 0;

          await NodeFSP.rm(partPath, { force: true });
          const writeStream = NodeFS.createWriteStream(partPath);
          let receivedBytes = 0;
          let lastEmittedPercent = -1;

          try {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value || value.byteLength === 0) continue;

              receivedBytes += value.byteLength;
              if (!writeStream.write(value)) {
                await new Promise<void>((resolve, reject) => {
                  writeStream.once("drain", resolve);
                  writeStream.once("error", reject);
                });
              }

              if (hasTotalBytes) {
                const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
                if (percent > lastEmittedPercent) {
                  lastEmittedPercent = percent;
                  emit("download-progress", { percent });
                }
              }
            }
            await new Promise<void>((resolve, reject) => {
              writeStream.end(() => resolve());
              writeStream.once("error", reject);
            });
          } catch (error) {
            writeStream.destroy();
            await NodeFSP.rm(partPath, { force: true }).catch(() => undefined);
            throw error;
          }

          if (receivedBytes === 0) {
            await NodeFSP.rm(partPath, { force: true }).catch(() => undefined);
            throw new Error(`Downloaded ${release.assetName} is empty.`);
          }

          await NodeFSP.rename(partPath, destPath);
          await cleanupOldUpdateFiles(updatesDir, release.assetName);

          if (lastEmittedPercent < 100) {
            emit("download-progress", { percent: 100 });
          }

          downloadedRelease = { ...release, filePath: destPath };
          emit("update-downloaded", {
            version: release.version,
            releaseName: release.tag,
            ...(release.releaseNotes !== undefined ? { releaseNotes: release.releaseNotes } : {}),
            ...(release.releaseDate !== undefined ? { releaseDate: release.releaseDate } : {}),
          });
        },
        catch: (cause) =>
          new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
            channel: currentChannel,
            cause,
          }),
      });
    }),
    quitAndInstall: Effect.fn("CtGithubUpdater.quitAndInstall")(function* ({
      isSilent,
      isForceRunAfter,
    }) {
      const currentChannel = channel;
      yield* Effect.tryPromise({
        try: async () => {
          if (!downloadedRelease) {
            throw new Error("No downloaded T3 Code (CT) update is ready to install.");
          }
          await NodeFSP.access(downloadedRelease.filePath);

          const tempDir = deps.tempDir ?? NodeOS.tmpdir();
          const logPath = NodePath.join(deps.logDir, "ct-updater.log");
          const parentPid = deps.pid ?? process.pid;
          const stamp = NodeCrypto.randomUUID();

          if (deps.platform === "darwin") {
            const destAppPath = resolveMacAppBundlePath(deps.appPath, deps.execPath);
            const scriptPath = NodePath.join(tempDir, `t3-code-ct-update-${stamp}.sh`);
            const script = buildMacInstallScript({
              parentPid,
              dmgPath: downloadedRelease.filePath,
              destAppPath,
              logPath,
            });
            await NodeFSP.writeFile(scriptPath, script, { encoding: "utf8", mode: 0o700 });
            spawnDetached("/bin/bash", [scriptPath]);
            return;
          }

          if (deps.platform === "win32") {
            const scriptPath = NodePath.join(tempDir, `t3-code-ct-update-${stamp}.ps1`);
            const script = buildWindowsInstallScript({
              parentPid,
              installerPath: downloadedRelease.filePath,
              appExePath: deps.execPath,
              isSilent,
              isForceRunAfter,
              logPath,
            });
            await NodeFSP.writeFile(scriptPath, script, "utf8");
            spawnDetached("powershell.exe", [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-WindowStyle",
              "Hidden",
              "-File",
              scriptPath,
            ]);
            return;
          }

          throw new Error(`Unsupported platform for T3 Code (CT) updates: ${deps.platform}.`);
        },
        catch: (cause) =>
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel: currentChannel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
      yield* deps.quitApp;
    }),
    on: Effect.fn("CtGithubUpdater.on")(function (eventName, listener) {
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          const existing = listeners.get(eventName) ?? new Set();
          existing.add(untypedListener);
          listeners.set(eventName, existing);
        }),
        () =>
          Effect.sync(() => {
            const existing = listeners.get(eventName);
            if (!existing) return;
            existing.delete(untypedListener);
            if (existing.size === 0) {
              listeners.delete(eventName);
            }
          }),
      ).pipe(Effect.asVoid);
    }),
  });
}

export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const policy = yield* DesktopUpdatePolicy.DesktopUpdatePolicy;

  // Preserve mock update server and administrator-managed mirrors via standard electron-updater.
  if (config.mockUpdates || policy.feedUrl !== undefined) {
    return ElectronUpdater.make;
  }

  return makeCtGithubUpdater({
    repo: Option.getOrElse(config.ctUpdateRepo, () => DEFAULT_CT_UPDATE_REPO),
    platform: environment.platform,
    hostArch: environment.runtimeInfo.hostArch,
    currentVersion: environment.appVersion,
    appPath: environment.appPath,
    execPath: process.execPath,
    baseDir: environment.baseDir,
    logDir: environment.logDir,
    quitApp: electronApp.quit,
  });
});
