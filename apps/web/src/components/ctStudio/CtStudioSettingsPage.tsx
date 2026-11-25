import { SettingsPageContainer } from "../settings/settingsLayout";
import { CtStudioSettingsSection } from "./CtStudioSettingsSection";
import { SlackRelaySettingsSection } from "./SlackRelaySettingsSection";

export function CtStudioSettingsPage() {
  return (
    <SettingsPageContainer>
      <CtStudioSettingsSection />
      <SlackRelaySettingsSection />
    </SettingsPageContainer>
  );
}
