import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
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
  // Plain non-focusable OpenTUI box/text JSX. The `api` prop is
  // retained for type compatibility but is not consulted here.
  void props.api;
  const searchHeader = props.searchActive
    ? `[Search Mode Active] Query: "${props.query}"`
    : props.query
    ? `[Filtered] Query: "${props.query}" (press / to search)`
    : `(press / to search)`;

  return jsxs("box", {
    flexDirection: "column",
    borderStyle: "single",
    padding: 1,
    children: [
      jsxs("box", {
        flexDirection: "row",
        justifyContent: "space-between",
        children: [
          jsx("text", { bold: true, color: "cyan", children: `Models (${props.providerId})` }),
          jsx("text", { dimColor: true, children: searchHeader }),
        ],
      }),
      props.models.length === 0
        ? jsx("text", {
            marginTop: 1,
            dimColor: true,
            children: props.query ? "No models match query" : "No models available",
          })
        : jsxs("box", {
            flexDirection: "column",
            marginTop: 1,
            children: props.models.map((m, idx) => {
              const isSelected = idx === props.selectedIndex;
              const prefix = isSelected ? "> " : "  ";
              const namePart = m.modelName !== m.modelId ? `${m.modelName} (${m.modelId})` : m.modelId;
              return jsx("text", {
                color: isSelected ? "green" : "white",
                bold: isSelected,
                children: `${prefix}${namePart}`,
              });
            }),
          }),
      jsx("text", {
        dimColor: true,
        marginTop: 1,
        children: "↑/↓ move · / search · Enter open · Esc back",
      }),
    ],
  });
}

export default ModelsScreen;
