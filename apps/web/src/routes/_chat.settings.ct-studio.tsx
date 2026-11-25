import { createFileRoute } from "@tanstack/react-router";

import { CtStudioSettingsPage } from "../components/ctStudio/CtStudioSettingsPage";

function SettingsCtStudioRoute() {
  return <CtStudioSettingsPage />;
}

export const Route = createFileRoute("/_chat/settings/ct-studio")({
  component: SettingsCtStudioRoute,
});
