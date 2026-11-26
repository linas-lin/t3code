import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import type {
  PluginInstallRequest,
  PluginListResponse,
  PluginSingleResponse,
  PluginUninstallResponse,
  PluginUpdateResponse,
} from "./pluginTypes";

const PLUGINS_ROUTE_PREFIX = "/api/plugins";

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }
  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

async function resolvePluginRequestAuth(): Promise<{
  readonly credentials: RequestCredentials;
  readonly bearerToken: string | null;
}> {
  if (isSameOriginBrowserPrimary()) {
    return { credentials: "include", bearerToken: null };
  }
  const bearerToken = await readDesktopPrimaryBearerToken();
  return { credentials: "omit", bearerToken };
}

async function requestPluginJson<T>(
  path: string,
  init: { readonly method?: "GET" | "POST"; readonly body?: unknown } = {},
): Promise<T> {
  const url = resolvePrimaryEnvironmentHttpUrl(`${PLUGINS_ROUTE_PREFIX}${path}`);
  const headers: Record<string, string> = {};
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const auth = await resolvePluginRequestAuth();
  if (auth.bearerToken) {
    headers.Authorization = `Bearer ${auth.bearerToken}`;
  }

  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    credentials: auth.credentials,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(payload.error || `Plugin request failed (${response.status})`);
  }
  return payload;
}

export function listPlugins(): Promise<PluginListResponse> {
  return requestPluginJson<PluginListResponse>("");
}

export function installPlugin(request: PluginInstallRequest): Promise<PluginSingleResponse> {
  return requestPluginJson<PluginSingleResponse>("/install", {
    method: "POST",
    body: request,
  });
}

export function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
): Promise<PluginSingleResponse> {
  return requestPluginJson<PluginSingleResponse>(`/${encodeURIComponent(pluginId)}/enable`, {
    method: "POST",
    body: { enabled },
  });
}

export function updatePlugin(
  pluginId: string,
  options: { readonly runBuild?: boolean } = {},
): Promise<PluginUpdateResponse> {
  return requestPluginJson<PluginUpdateResponse>(`/${encodeURIComponent(pluginId)}/update`, {
    method: "POST",
    body: options,
  });
}

export function reloadPluginRemote(pluginId: string): Promise<PluginSingleResponse> {
  return requestPluginJson<PluginSingleResponse>(`/${encodeURIComponent(pluginId)}/reload`, {
    method: "POST",
    body: {},
  });
}

export function uninstallPlugin(
  pluginId: string,
  options: { readonly removeData?: boolean } = {},
): Promise<PluginUninstallResponse> {
  return requestPluginJson<PluginUninstallResponse>(`/${encodeURIComponent(pluginId)}/uninstall`, {
    method: "POST",
    body: options,
  });
}

function encodeAssetPath(assetPath: string): string {
  return assetPath
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export async function fetchPluginAssetText(
  pluginId: string,
  assetPath: string,
  cacheBust?: string | number,
): Promise<string> {
  const encodedPath = encodeAssetPath(assetPath);
  if (!encodedPath) {
    throw new Error(`Invalid plugin asset path for "${pluginId}"`);
  }
  const url = resolvePrimaryEnvironmentHttpUrl(
    `${PLUGINS_ROUTE_PREFIX}/${encodeURIComponent(pluginId)}/assets/${encodedPath}`,
    cacheBust !== undefined ? { v: String(cacheBust) } : undefined,
  );
  const auth = await resolvePluginRequestAuth();
  const headers: Record<string, string> = {};
  if (auth.bearerToken) {
    headers.Authorization = `Bearer ${auth.bearerToken}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    credentials: auth.credentials,
    cache: "no-store",
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    let message = `Failed to load plugin asset "${assetPath}" (${response.status})`;
    if (errorText) {
      try {
        const parsed = JSON.parse(errorText) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim()) {
          message = parsed.error.trim();
        }
      } catch {
        // Keep HTTP status fallback when response body is plain text or HTML.
      }
    }
    throw new Error(message);
  }
  return response.text();
}

/**
 * Builds the plugin-scoped `host.api.fetch(path, init)` transport under `/api/plugins/:id/api/*`.
 * Tunnels non-GET/POST methods via `POST` + `?_ct_method=<METHOD>` for Electron CORS compatibility.
 */
export function createPluginApiFetch(
  pluginId: string,
): (path: string, init?: RequestInit) => Promise<Response> {
  const encodedId = encodeURIComponent(pluginId);

  return async (path: string, init?: RequestInit): Promise<Response> => {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const parsedInput = new URL(normalizedPath, "http://ct-plugin.local");
    const basePathname = `${PLUGINS_ROUTE_PREFIX}/${encodedId}/api${parsedInput.pathname}`;
    const targetUrl = new URL(resolvePrimaryEnvironmentHttpUrl(basePathname));

    parsedInput.searchParams.forEach((value, key) => {
      targetUrl.searchParams.append(key, value);
    });

    const requestedMethod = (init?.method ?? "GET").toUpperCase();
    const shouldTunnelMethod = requestedMethod !== "GET" && requestedMethod !== "POST";
    if (shouldTunnelMethod) {
      targetUrl.searchParams.set("_ct_method", requestedMethod);
    }

    const auth = await resolvePluginRequestAuth();
    const headers = new Headers(init?.headers);
    if (auth.bearerToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${auth.bearerToken}`);
    }

    return fetch(targetUrl.toString(), {
      ...init,
      method: shouldTunnelMethod ? "POST" : requestedMethod,
      headers,
      credentials: auth.credentials,
    });
  };
}
