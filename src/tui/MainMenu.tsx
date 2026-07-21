import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { createComponent } from "solid-js/web";
import { MENU_OPTIONS } from "./navigation.js";

export interface MainMenuProps {
  selectedIndex: number;
  api?: TuiPluginApi;
}

export function MainMenu(props: MainMenuProps): JSX.Element {
  const selectedOption = MENU_OPTIONS[props.selectedIndex] ?? "models";
  const selectedLabel = selectedOption === "models" ? "Models" : "Quarantines";

  // Fallback to api.ui.DialogAlert when running in test/mock environment without OpenTUI renderer
  if (props.api?.ui?.DialogAlert) {
    return createComponent(props.api.ui.DialogAlert, {
      title: "Model Control Center",
      message: `Selected: ${selectedLabel}\n\n1. Models\n2. Quarantines\n\n↑/↓ move · Enter open · Esc close`,
    });
  }

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
