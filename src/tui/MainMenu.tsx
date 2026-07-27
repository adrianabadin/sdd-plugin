import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { MENU_OPTIONS } from "./navigation.js";

export interface MainMenuProps {
  selectedIndex: number;
  api?: TuiPluginApi;
}

export function MainMenu(props: MainMenuProps): JSX.Element {
  // Plain non-focusable OpenTUI box/text JSX. No DialogAlert for normal
  // navigation screens — host alert primitives own Return/Esc, which
  // would steal keyboard ownership from the MCC keymap. The `api` prop
  // is retained for type compatibility but is not consulted here.
  void props.api;
  return jsxs("box", {
    flexDirection: "column",
    borderStyle: "single",
    padding: 1,
    children: [
      jsx("text", {
        bold: true,
        color: "cyan",
        children: "Model Control Center",
      }),
      jsx("box", {
        flexDirection: "column",
        marginTop: 1,
        children: MENU_OPTIONS.map((option, index) => {
          const isSelected = index === props.selectedIndex;
          const label = option === "models" ? "Models" : "Quarantines";
          const prefix = isSelected ? "> " : "  ";
          return jsx("text", {
            color: isSelected ? "green" : "white",
            bold: isSelected,
            children: `${prefix}${label}`,
          });
        }),
      }),
      jsx("text", {
        dimColor: true,
        marginTop: 1,
        children: "↑/↓ move · Enter open · Esc close",
      }),
    ],
  });
}

export default MainMenu;
