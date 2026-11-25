import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import type { SlackRelayConfigPatch } from "./slackRelayCore.ts";
import * as SlackRelayService from "./SlackRelayService.ts";

const ROUTE_PREFIX = "/api/ct-studio/slack-relay";

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

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* SlackRelayService.SlackRelayService;

    const getSnapshotRoute = HttpRouter.add(
      "GET",
      ROUTE_PREFIX,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const snapshot = yield* service.getSnapshot();
        return jsonNoStore(snapshot);
      }),
    );

    const updateConfigRoute = HttpRouter.add(
      "PUT",
      `${ROUTE_PREFIX}/config`,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const patch = (yield* request.json.pipe(
          Effect.orElseSucceed(() => ({})),
        )) as SlackRelayConfigPatch;
        const snapshot = yield* service.updateConfig(patch);
        return jsonNoStore(snapshot);
      }),
    );

    const reconnectRoute = HttpRouter.add(
      "POST",
      `${ROUTE_PREFIX}/reconnect`,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const snapshot = yield* service.reconnect();
        return jsonNoStore(snapshot);
      }),
    );

    const sendDraftRoute = HttpRouter.add(
      "POST",
      `${ROUTE_PREFIX}/drafts/send`,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
          id?: string;
          text?: string;
        };
        if (!body?.id || typeof body.id !== "string") {
          return jsonNoStore({ error: "Missing draft id." }, 400);
        }
        return yield* service.sendDraft(body.id, body.text).pipe(
          Effect.map((snapshot) => jsonNoStore(snapshot)),
          Effect.catch((err) => Effect.succeed(jsonNoStore({ error: err.message }, 400))),
        );
      }),
    );

    const discardDraftRoute = HttpRouter.add(
      "POST",
      `${ROUTE_PREFIX}/drafts/discard`,
      Effect.gen(function* () {
        yield* requireOperateSession;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
          id?: string;
        };
        if (!body?.id || typeof body.id !== "string") {
          return jsonNoStore({ error: "Missing draft id." }, 400);
        }
        return yield* service.discardDraft(body.id).pipe(
          Effect.map((snapshot) => jsonNoStore(snapshot)),
          Effect.catch((err) => Effect.succeed(jsonNoStore({ error: err.message }, 400))),
        );
      }),
    );

    return Layer.mergeAll(
      getSnapshotRoute,
      updateConfigRoute,
      reconnectRoute,
      sendDraftRoute,
      discardDraftRoute,
    );
  }),
);
