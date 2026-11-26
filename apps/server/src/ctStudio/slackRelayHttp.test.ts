import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import {
  DEFAULT_SLACK_RELAY_CONFIG,
  mergeSlackRelayConfigPatch,
  toPublicSlackRelayConfig,
  type SlackRelayConfigPatch,
} from "./slackRelayCore.ts";
import * as SlackRelayHttp from "./slackRelayHttp.ts";
import * as SlackRelayService from "./SlackRelayService.ts";

function makeSnapshot(patch: SlackRelayConfigPatch = {}): SlackRelayService.SlackRelaySnapshot {
  const config = mergeSlackRelayConfigPatch(DEFAULT_SLACK_RELAY_CONFIG, patch);
  return {
    config: toPublicSlackRelayConfig(config),
    status: {
      state: config.enabled ? "connecting" : "disabled",
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
      mappedThreads: 0,
    },
    pending: [],
    projects: [],
    skills: [],
  };
}

describe("slackRelayHttp", () => {
  it("allows cross-origin desktop POST config updates and preserves PUT compatibility", async () => {
    const receivedPatches: SlackRelayConfigPatch[] = [];
    const mockRelayLayer = Layer.succeed(SlackRelayService.SlackRelayService, {
      getSnapshot: () => Effect.succeed(makeSnapshot()),
      updateConfig: (patch) => {
        receivedPatches.push(patch);
        return Effect.succeed(makeSnapshot(patch));
      },
      reconnect: () => Effect.succeed(makeSnapshot()),
      sendDraft: () => Effect.succeed(makeSnapshot()),
      discardDraft: () => Effect.succeed(makeSnapshot()),
    });
    const mockAuthLayer = Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
      authenticateHttpRequest: () =>
        Effect.succeed({
          scopes: [AuthOrchestrationOperateScope],
        }),
    } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);

    const layerApp = Layer.mergeAll(
      SlackRelayHttp.layer,
      ServerHttp.layerBrowserApiCors,
      mockAuthLayer,
    ).pipe(
      Layer.provide(mockRelayLayer),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "slack-relay-http-test-" })),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

    try {
      const preflight = await handler(
        new Request("http://127.0.0.1:3773/api/ct-studio/slack-relay/config", {
          method: "OPTIONS",
          headers: {
            origin: "t3code-dev://app",
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization,content-type",
          },
        }),
      );
      expect(preflight.status).toBe(204);
      const allowedMethods = (preflight.headers.get("access-control-allow-methods") ?? "")
        .split(",")
        .map((method) => method.trim().toUpperCase());
      expect(allowedMethods).toContain("POST");

      const postResponse = await handler(
        new Request("http://127.0.0.1:3773/api/ct-studio/slack-relay/config", {
          method: "POST",
          headers: {
            origin: "t3code-dev://app",
            authorization: "Bearer desktop-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ enabled: true }),
        }),
      );
      expect(postResponse.status).toBe(200);
      expect(postResponse.headers.get("access-control-allow-origin")).toBeTruthy();
      const postJson = (await postResponse.json()) as SlackRelayService.SlackRelaySnapshot;
      expect(postJson.config.enabled).toBe(true);

      const putResponse = await handler(
        new Request("http://127.0.0.1:3773/api/ct-studio/slack-relay/config", {
          method: "PUT",
          headers: {
            authorization: "Bearer desktop-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ enabled: false }),
        }),
      );
      expect(putResponse.status).toBe(200);
      const putJson = (await putResponse.json()) as SlackRelayService.SlackRelaySnapshot;
      expect(putJson.config.enabled).toBe(false);

      expect(receivedPatches).toEqual([{ enabled: true }, { enabled: false }]);
    } finally {
      await dispose();
    }
  });
});
