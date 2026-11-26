import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { __resetDesktopPrimaryAuthForTests } from "../../environments/primary/desktopAuth";
import { updateSlackRelayConfig } from "./slackRelayClient";

describe("slackRelayClient", () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    vi.unstubAllGlobals();
  });

  it("uses POST when saving Slack Relay config so desktop CORS preflight succeeds", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ config: { enabled: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    vi.stubGlobal("window", {
      location: {
        origin: "t3code-dev://app",
        href: "t3code-dev://app/settings/ct-studio",
      },
      desktopBridge: {
        getLocalEnvironmentEnabled: () => true,
        getLocalEnvironmentBootstraps: () => [
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
          },
        ],
        getLocalEnvironmentBearerToken: async () => "test-desktop-token",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateSlackRelayConfig({ enabled: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3773/api/ct-studio/slack-relay/config");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("omit");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-desktop-token",
    });
    expect(init?.body).toBe(JSON.stringify({ enabled: true }));
  });
});
