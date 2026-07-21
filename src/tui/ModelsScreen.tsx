import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import type { ConnectedModelInfo } from "../domain/model/connected-model.js";

export interface ModelsScreenProps {
  api: TuiPluginApi;
  providerId: string;
  models: ReadonlyArray<ConnectedModelInfo>;
  selectedIndex: number;
  query: string;
  searchActive: boolean;
}

export function ModelsScreen(props: ModelsScreenProps): JSX.Element {
  const searchHeader = props.searchActive
    ? `[Search Mode Active] Query: "${props.query}"`
    : props.query
    ? `[Filtered] Query: "${props.query}" (press / to search)`
    : `(press / to search)`;

  if (props.models.length === 0) {
    const emptyMsg = props.query ? "No models match query" : "No models available";
    return props.api.ui.DialogAlert({
      title: `Models (${props.providerId})`,
      message: `${searchHeader}\n\n${emptyMsg}`,
    });
  }

  const items = props.models.map((m, idx) => {
    const isSelected = idx === props.selectedIndex;
    const prefix = isSelected ? "> " : "  ";
    const namePart = m.modelName !== m.modelId ? `${m.modelName} (${m.modelId})` : m.modelId;
    return `${prefix}${namePart}`;
  });

  return props.api.ui.DialogAlert({
    title: `Models (${props.providerId})`,
    message: `${searchHeader}\n\n${items.join("\n")}`,
  });
}

export default ModelsScreen;
