import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import type { ProviderSummary } from "./catalog-view.js";

export interface ProvidersScreenProps {
  api: TuiPluginApi;
  providers: ReadonlyArray<ProviderSummary>;
  selectedIndex: number;
}

export function ProvidersScreen(props: ProvidersScreenProps): JSX.Element {
  // Plain non-focusable OpenTUI box/text JSX. The `api` prop is
  // retained for type compatibility but is not consulted here.
  void props.api;
  return jsxs("box", {
    flexDirection: "column",
    borderStyle: "single",
    padding: 1,
    children: [
      jsx("text", { bold: true, color: "cyan", children: "Connected Providers" }),
      props.providers.length === 0
        ? jsx("text", { marginTop: 1, dimColor: true, children: "No connected providers" })
        : jsxs("box", {
            flexDirection: "column",
            marginTop: 1,
            children: props.providers.map((p, idx) => {
              const isSelected = idx === props.selectedIndex;
              const prefix = isSelected ? "> " : "  ";
              return jsx("text", {
                color: isSelected ? "green" : "white",
                bold: isSelected,
                children: `${prefix}${p.providerId} (${p.modelCount} models)`,
              });
            }),
          }),
      jsx("text", {
        dimColor: true,
        marginTop: 1,
        children: "↑/↓ move · Enter open · Esc back",
      }),
    ],
  });
}

export default ProvidersScreen;
