import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import type { ProviderSummary } from "./catalog-view.js";

export interface ProvidersScreenProps {
  api: TuiPluginApi;
  providers: ReadonlyArray<ProviderSummary>;
  selectedIndex: number;
}

export function ProvidersScreen(props: ProvidersScreenProps): JSX.Element {
  if (props.providers.length === 0) {
    return props.api.ui.DialogAlert({
      title: "Connected Providers",
      message: "No connected providers",
    });
  }

  const items = props.providers.map((p, idx) => {
    const isSelected = idx === props.selectedIndex;
    const prefix = isSelected ? "> " : "  ";
    return `${prefix}${p.providerId} (${p.modelCount} models)`;
  });

  return props.api.ui.DialogAlert({
    title: "Connected Providers",
    message: items.join("\n"),
  });
}

export default ProvidersScreen;
