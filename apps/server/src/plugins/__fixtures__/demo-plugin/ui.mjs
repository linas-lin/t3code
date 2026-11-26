function getReact() {
  const runtime = globalThis.__CT_PLUGIN_RUNTIME__;
  if (!runtime || !runtime.React) {
    throw new Error("CT Code plugin runtime global (__CT_PLUGIN_RUNTIME__) is unavailable.");
  }
  return runtime.React;
}

const plugin = {
  activate(ctx) {
    const React = getReact();
    const h = React.createElement;

    function DemoMainView() {
      const [pingResult, setPingResult] = React.useState(null);
      const [loading, setLoading] = React.useState(false);

      const handlePing = async () => {
        setLoading(true);
        try {
          const response = await ctx.host.api.fetch("/api/ping");
          const data = await response.json();
          setPingResult(JSON.stringify(data));
        } catch (error) {
          setPingResult(String(error));
        } finally {
          setLoading(false);
        }
      };

      return h(
        "div",
        { "data-plugin-id": ctx.pluginId },
        h(
          "div",
          { className: "demo-plugin-card" },
          h("h2", null, ctx.manifest.name),
          h("p", null, `Plugin ID: ${ctx.pluginId} (v${ctx.manifest.version})`),
          h(
            "button",
            { type: "button", disabled: loading, onClick: handlePing },
            loading ? "Pinging..." : "Ping Backend",
          ),
          pingResult ? h("pre", null, pingResult) : null,
        ),
      );
    }

    function DemoThreadCard(props) {
      return h(
        "div",
        { className: "demo-plugin-card", "data-plugin-id": ctx.pluginId },
        `Demo Thread Panel (${props?.threadId ?? "none"})`,
      );
    }

    function DemoThreadPopoverRow(props) {
      return h(
        "div",
        { "data-plugin-id": ctx.pluginId },
        `Demo Plugin (${props?.threadId ?? "none"})`,
      );
    }

    function DemoSettingsSection() {
      return h(
        "div",
        { className: "demo-plugin-card", "data-plugin-id": ctx.pluginId },
        `Demo Plugin Settings (apiVersion=${ctx.manifest.apiVersion})`,
      );
    }

    return {
      mainView: {
        Component: DemoMainView,
        keepAlive: true,
      },
      threadPanel: {
        Card: DemoThreadCard,
        PopoverRow: DemoThreadPopoverRow,
      },
      settingsSection: DemoSettingsSection,
      commands: [
        {
          id: "demo-plugin.ping",
          title: "Demo Plugin: Ping Backend",
          searchTerms: ["demo", "ping", "plugin"],
          async run() {
            const response = await ctx.host.api.fetch("/api/ping");
            const data = await response.json();
            ctx.host.ui.toast({
              title: "Demo Plugin Ping",
              description: data.pong ? "Backend responded OK" : "Unexpected response",
              type: data.pong ? "success" : "warning",
            });
          },
        },
      ],
    };
  },

  deactivate() {
    // No external resources to dispose.
  },
};

export default plugin;
