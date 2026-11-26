import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import {
  PLUGIN_API_VERSION,
  PluginError,
  pluginErrorHttpStatus,
  type PluginInstallRequest,
} from "./pluginContract.ts";
import * as PluginService from "./PluginService.ts";

const ROUTE_PREFIX = "/api/plugins";

const ALLOWED_CT_METHOD_OVERRIDES = new Set(["PUT", "PATCH", "DELETE"]);

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "origin",
  "referer",
  "x-forwarded-proto",
  "x-ct-plugin-token",
  "x-ct-studio-token",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "clear-site-data",
]);

const requireOperateSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
});

const jsonNoStore = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

const pluginErrorResponse = (error: PluginError) =>
  jsonNoStore(
    {
      error: error.message,
      code: error.code,
    },
    pluginErrorHttpStatus(error),
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInstallRequest(body: unknown): PluginInstallRequest | PluginError {
  if (!isRecord(body) || typeof body.source !== "string") {
    return new PluginError({
      code: "invalid_request",
      message: 'Request body must include source: "git" or "local".',
      status: 400,
    });
  }
  const runBuild =
    body.runBuild === undefined
      ? undefined
      : typeof body.runBuild === "boolean"
        ? body.runBuild
        : null;
  if (runBuild === null) {
    return new PluginError({
      code: "invalid_request",
      message: "Field 'runBuild' must be a boolean.",
      status: 400,
    });
  }

  if (body.source === "git") {
    if (typeof body.url !== "string" || body.url.trim().length === 0) {
      return new PluginError({
        code: "invalid_request",
        message: "Git install requires a non-empty 'url' string.",
        status: 400,
      });
    }
    if (body.ref !== undefined && typeof body.ref !== "string") {
      return new PluginError({
        code: "invalid_request",
        message: "Field 'ref' must be a string.",
        status: 400,
      });
    }
    return {
      source: "git",
      url: body.url,
      ...(body.ref !== undefined && body.ref.trim().length > 0 ? { ref: body.ref } : {}),
      ...(runBuild !== undefined ? { runBuild } : {}),
    };
  }

  if (body.source === "local") {
    if (typeof body.path !== "string" || body.path.trim().length === 0) {
      return new PluginError({
        code: "invalid_request",
        message: "Local install requires a non-empty 'path' string.",
        status: 400,
      });
    }
    return {
      source: "local",
      path: body.path,
      ...(runBuild !== undefined ? { runBuild } : {}),
    };
  }

  return new PluginError({
    code: "invalid_request",
    message: 'Install source must be "git" or "local".',
    status: 400,
  });
}

function extractRawPathname(request: HttpServerRequest.HttpServerRequest): string {
  const rawUrl = request.originalUrl || request.url;
  const withoutQuery = rawUrl.split("?", 1)[0] ?? rawUrl;
  if (/^https?:\/\//i.test(withoutQuery)) {
    const schemeEnd = withoutQuery.indexOf("://");
    const pathStart = withoutQuery.indexOf("/", schemeEnd + 3);
    return pathStart === -1 ? "/" : withoutQuery.slice(pathStart);
  }
  return withoutQuery;
}

function extractPluginSubpath(pathname: string, segment: "assets" | "api"): string | null {
  const marker = `/${segment}`;
  const prefixMatch = /^\/api\/plugins\/[^/]+/.exec(pathname);
  if (!prefixMatch) return null;
  const remainder = pathname.slice(prefixMatch[0].length);
  if (remainder === marker) {
    return "";
  }
  if (remainder.startsWith(`${marker}/`)) {
    return remainder.slice(marker.length + 1);
  }
  return null;
}

function buildForwardRequestHeaders(
  request: HttpServerRequest.HttpServerRequest,
  pluginId: string,
  token: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(lower) || value === undefined) {
      continue;
    }
    headers[name] = value;
  }
  headers["x-ct-plugin-token"] = token;
  headers["x-ct-studio-token"] = token;
  headers["x-ct-plugin-id"] = pluginId;
  return headers;
}

function requestMayHaveBody(request: HttpServerRequest.HttpServerRequest): boolean {
  if (request.method === "GET" || request.method === "HEAD") {
    return false;
  }
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    return contentLength.trim() !== "0";
  }
  return (
    request.headers["content-type"] !== undefined ||
    request.headers["transfer-encoding"] !== undefined
  );
}

const proxyToPluginBackend = Effect.fn("PluginHttp.proxyToPluginBackend")(function* (
  service: PluginService.PluginServiceShape,
  baseHttpClient: HttpClient.HttpClient,
) {
  yield* requireOperateSession;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = yield* HttpRouter.params;
  const pluginId = params.id;
  if (!pluginId) {
    return jsonNoStore({ error: "Missing plugin id.", code: "invalid_request" }, 400);
  }

  const parsedUrl = requestUrl(request);
  if (Option.isNone(parsedUrl)) {
    return jsonNoStore({ error: "Bad Request", code: "invalid_request" }, 400);
  }

  const rawPathname = extractRawPathname(request);
  const subPath = extractPluginSubpath(rawPathname, "api");
  if (subPath === null) {
    return jsonNoStore({ error: "Not Found", code: "not_found" }, 404);
  }
  const backendPath = subPath.length > 0 ? `/${subPath}` : "/";

  const forwardedParams = new URLSearchParams(parsedUrl.value.search);
  const rawOverride = forwardedParams.get("_ct_method");
  let targetMethod: string = request.method;
  if (rawOverride !== null) {
    const normalized = rawOverride.trim().toUpperCase();
    if (!ALLOWED_CT_METHOD_OVERRIDES.has(normalized)) {
      return jsonNoStore(
        {
          error: `Unsupported _ct_method "${rawOverride}". Allowed: PUT, PATCH, DELETE.`,
          code: "invalid_request",
        },
        400,
      );
    }
    forwardedParams.delete("_ct_method");
    targetMethod = normalized;
  }

  if (!HttpMethod.isHttpMethod(targetMethod)) {
    return jsonNoStore(
      { error: `Method "${targetMethod}" not allowed.`, code: "invalid_request" },
      405,
    );
  }

  const endpointResult = yield* service.ensureBackendReady(pluginId).pipe(Effect.result);
  if (endpointResult._tag === "Failure") {
    return pluginErrorResponse(endpointResult.failure);
  }
  const endpoint = endpointResult.success;

  const queryString = forwardedParams.toString();
  const upstreamUrl = `http://${endpoint.host}:${endpoint.port}${backendPath}${queryString.length > 0 ? `?${queryString}` : ""}`;

  const httpClient = HttpClient.withScope(baseHttpClient);
  const upstreamRequest = HttpClientRequest.make(targetMethod)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(buildForwardRequestHeaders(request, pluginId, endpoint.token)),
    requestMayHaveBody(request)
      ? HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        })
      : (self) => self,
  );

  const responseResult = yield* httpClient.execute(upstreamRequest).pipe(Effect.result);
  if (responseResult._tag === "Failure") {
    return jsonNoStore(
      {
        error: `Failed to reach plugin "${pluginId}" backend: ${String(responseResult.failure)}`,
        code: "backend_error",
      },
      502,
    );
  }

  const upstreamResponse = responseResult.success;
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    const lower = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(lower) || value === undefined) {
      continue;
    }
    responseHeaders[lower] = value;
  }

  const contentType = responseHeaders["content-type"];
  const isEventStream =
    contentType !== undefined && contentType.toLowerCase().includes("text/event-stream");
  if (isEventStream) {
    responseHeaders["cache-control"] = "no-store, no-transform";
    responseHeaders["x-accel-buffering"] = "no";
  } else if (responseHeaders["cache-control"] === undefined) {
    responseHeaders["cache-control"] = "no-store";
  }
  responseHeaders["x-content-type-options"] = "nosniff";

  if (
    upstreamResponse.status === 204 ||
    upstreamResponse.status === 304 ||
    targetMethod === "HEAD"
  ) {
    return HttpServerResponse.empty({
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  return HttpServerResponse.stream(upstreamResponse.stream, {
    status: upstreamResponse.status,
    headers: responseHeaders,
    ...(contentType !== undefined ? { contentType } : {}),
  });
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* PluginService.PluginService;
    const baseHttpClient = yield* HttpClient.HttpClient;

    const listRoute = HttpRouter.add(
      "GET",
      ROUTE_PREFIX,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const plugins = yield* service.list();
        return jsonNoStore({
          apiVersion: PLUGIN_API_VERSION,
          plugins,
        });
      }),
    );

    const installRoute = HttpRouter.add(
      "POST",
      `${ROUTE_PREFIX}/install`,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
        const parsed = parseInstallRequest(body);
        if (parsed instanceof PluginError) {
          return pluginErrorResponse(parsed);
        }
        return yield* service.install(parsed).pipe(
          Effect.map((plugin) => jsonNoStore({ plugin })),
          Effect.catchTags({ PluginError: (error) => Effect.succeed(pluginErrorResponse(error)) }),
        );
      }),
    );

    const enableRoute = HttpRouter.add(
      "POST",
      `${ROUTE_PREFIX}/:id/enable`,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const params = yield* HttpRouter.params;
        const pluginId = params.id;
        if (!pluginId) {
          return jsonNoStore({ error: "Missing plugin id.", code: "invalid_request" }, 400);
        }
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
        if (!isRecord(body) || typeof body.enabled !== "boolean") {
          return jsonNoStore(
            {
              error: "Request body must include boolean field 'enabled'.",
              code: "invalid_request",
            },
            400,
          );
        }
        return yield* service.setEnabled(pluginId, body.enabled).pipe(
          Effect.map((plugin) => jsonNoStore({ plugin })),
          Effect.catchTags({ PluginError: (error) => Effect.succeed(pluginErrorResponse(error)) }),
        );
      }),
    );

    const updateRoute = HttpRouter.add(
      "POST",
      `${ROUTE_PREFIX}/:id/update`,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const params = yield* HttpRouter.params;
        const pluginId = params.id;
        if (!pluginId) {
          return jsonNoStore({ error: "Missing plugin id.", code: "invalid_request" }, 400);
        }
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
        if (!isRecord(body)) {
          return jsonNoStore({ error: "Invalid request body.", code: "invalid_request" }, 400);
        }
        if (body.runBuild !== undefined && typeof body.runBuild !== "boolean") {
          return jsonNoStore(
            { error: "Field 'runBuild' must be a boolean.", code: "invalid_request" },
            400,
          );
        }
        return yield* service
          .update(pluginId, body.runBuild !== undefined ? { runBuild: body.runBuild } : undefined)
          .pipe(
            Effect.map((result) => jsonNoStore(result)),
            Effect.catchTags({
              PluginError: (error) => Effect.succeed(pluginErrorResponse(error)),
            }),
          );
      }),
    );

    const reloadRoute = HttpRouter.add(
      "POST",
      `${ROUTE_PREFIX}/:id/reload`,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const params = yield* HttpRouter.params;
        const pluginId = params.id;
        if (!pluginId) {
          return jsonNoStore({ error: "Missing plugin id.", code: "invalid_request" }, 400);
        }
        return yield* service.reload(pluginId).pipe(
          Effect.map((plugin) => jsonNoStore({ plugin })),
          Effect.catchTags({ PluginError: (error) => Effect.succeed(pluginErrorResponse(error)) }),
        );
      }),
    );

    const uninstallRoute = HttpRouter.add(
      "POST",
      `${ROUTE_PREFIX}/:id/uninstall`,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const params = yield* HttpRouter.params;
        const pluginId = params.id;
        if (!pluginId) {
          return jsonNoStore({ error: "Missing plugin id.", code: "invalid_request" }, 400);
        }
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
        if (!isRecord(body)) {
          return jsonNoStore({ error: "Invalid request body.", code: "invalid_request" }, 400);
        }
        if (body.removeData !== undefined && typeof body.removeData !== "boolean") {
          return jsonNoStore(
            { error: "Field 'removeData' must be a boolean.", code: "invalid_request" },
            400,
          );
        }
        return yield* service
          .uninstall(
            pluginId,
            body.removeData !== undefined ? { removeData: body.removeData } : undefined,
          )
          .pipe(
            Effect.map((result) => jsonNoStore(result)),
            Effect.catchTags({
              PluginError: (error) => Effect.succeed(pluginErrorResponse(error)),
            }),
          );
      }),
    );

    const assetsRoute = HttpRouter.add(
      "GET",
      `${ROUTE_PREFIX}/:id/assets/*`,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = yield* HttpRouter.params;
        const pluginId = params.id;
        if (!pluginId) {
          return jsonNoStore({ error: "Missing plugin id.", code: "invalid_request" }, 400);
        }

        const rawPathname = extractRawPathname(request);
        const assetSubpath = extractPluginSubpath(rawPathname, "assets");
        if (assetSubpath === null || assetSubpath.length === 0) {
          return jsonNoStore({ error: "Missing asset path.", code: "invalid_request" }, 400);
        }

        return yield* service.readAsset(pluginId, assetSubpath).pipe(
          Effect.map((asset) =>
            HttpServerResponse.uint8Array(asset.bytes, {
              status: 200,
              contentType: asset.contentType,
              headers: {
                "cache-control": "no-store",
                "x-content-type-options": "nosniff",
              },
            }),
          ),
          Effect.catchTags({ PluginError: (error) => Effect.succeed(pluginErrorResponse(error)) }),
        );
      }),
    );

    const apiProxyHandler = proxyToPluginBackend(service, baseHttpClient);
    const apiMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
    const apiWildcardRoutes = apiMethods.map((method) =>
      HttpRouter.add(method, `${ROUTE_PREFIX}/:id/api/*`, apiProxyHandler),
    );
    const apiRootRoutes = (["GET", "POST"] as const).map((method) =>
      HttpRouter.add(method, `${ROUTE_PREFIX}/:id/api`, apiProxyHandler),
    );

    return Layer.mergeAll(
      listRoute,
      installRoute,
      enableRoute,
      updateRoute,
      reloadRoute,
      uninstallRoute,
      assetsRoute,
      ...apiWildcardRoutes,
      ...apiRootRoutes,
    );
  }),
);
