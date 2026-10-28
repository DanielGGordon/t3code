import { createFileRoute } from "@tanstack/react-router";

import { FeaturesSettingsPanel } from "../components/settings/FeaturesSettings";

function SettingsFeaturesRoute() {
  return <FeaturesSettingsPanel />;
}

export const Route = createFileRoute("/_chat/settings/features")({
  component: SettingsFeaturesRoute,
});
