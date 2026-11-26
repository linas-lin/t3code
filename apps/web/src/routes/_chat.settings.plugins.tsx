import { createFileRoute } from "@tanstack/react-router";

import { PluginsSettingsPage } from "../components/plugins/PluginsSettingsPage";

function SettingsPluginsRoute() {
  return <PluginsSettingsPage />;
}

export const Route = createFileRoute("/_chat/settings/plugins")({
  component: SettingsPluginsRoute,
});
