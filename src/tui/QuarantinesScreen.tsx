import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { createComponent } from "solid-js/web";
import type { QuarantineEntry } from "../domain/model/quarantine.js";
import { deriveQuarantineView } from "./quarantine-view.js";

export interface QuarantinesScreenProps {
  entries: QuarantineEntry[];
  selectedIndex?: number;
  loading?: boolean;
  error?: string;
  notice?: string;
  api?: TuiPluginApi;
}

export function QuarantinesScreen(props: QuarantinesScreenProps): JSX.Element {
  const view = deriveQuarantineView(props.entries);
  const selectedIdx = props.selectedIndex ?? 0;

  // Fallback for test / host component rendering contract
  if (props.api?.ui?.DialogAlert) {
    if (props.loading) {
      return createComponent(props.api.ui.DialogAlert, {
        title: "Quarantines",
        message: "Loading quarantines...",
      });
    }
    if (props.error) {
      return createComponent(props.api.ui.DialogAlert, {
        title: "Quarantines Error",
        message: `Error loading quarantines: ${props.error}`,
      });
    }

    if (view.isEmpty) {
      return createComponent(props.api.ui.DialogAlert, {
        title: "Quarantines",
        message: "No quarantine rules active or set.\n\n↑/↓ move · Enter release / add · Esc back",
      });
    }

    const lines = view.items.map((item, idx) => {
      const prefix = idx === selectedIdx ? "> " : "  ";
      return `${prefix}[${item.level}] ${item.targetLabel} — ${item.statusLabel}`;
    });

    const noticeHeader = props.notice ? `Notice: ${props.notice}\n\n` : "";
    return createComponent(props.api.ui.DialogAlert, {
      title: "Quarantines",
      message: `${noticeHeader}${lines.join("\n")}\n\n↑/↓ move · Enter release / add · Esc back`,
    });
  }

  if (props.loading) {
    return jsxs("box", {
      flexDirection: "column",
      borderStyle: "single",
      padding: 1,
      children: [
        jsx("text", { bold: true, color: "yellow", children: "Quarantine Management" }),
        jsx("text", { marginTop: 1, children: "Loading quarantine rules..." }),
      ],
    });
  }

  if (props.error) {
    return jsxs("box", {
      flexDirection: "column",
      borderStyle: "single",
      padding: 1,
      children: [
        jsx("text", { bold: true, color: "red", children: "Quarantine Management Error" }),
        jsx("text", { marginTop: 1, color: "red", children: `Error: ${props.error}` }),
      ],
    });
  }

  return jsxs("box", {
    flexDirection: "column",
    borderStyle: "single",
    padding: 1,
    children: [
      jsxs("box", {
        flexDirection: "row",
        justifyContent: "space-between",
        children: [
          jsx("text", { bold: true, color: "yellow", children: "Quarantine Management" }),
          jsx("text", { dimColor: true, children: `Active: ${view.activeCount}/${view.items.length}` }),
        ],
      }),
      props.notice
        ? jsx("text", { marginTop: 1, color: "cyan", children: props.notice })
        : null,
      view.isEmpty
        ? jsx("text", { marginTop: 1, dimColor: true, children: "No quarantine entries found." })
        : jsxs("box", {
            flexDirection: "column",
            marginTop: 1,
            children: view.items.map((item, index) => {
              const isSelected = index === selectedIdx;
              const prefix = isSelected ? "> " : "  ";
              const color = !item.isActive
                ? "gray"
                : item.level === "provider"
                  ? "red"
                  : item.level === "model"
                    ? "yellow"
                    : "cyan";
              return jsxs("box", {
                flexDirection: "row",
                children: [
                  jsx("text", {
                    color: isSelected ? "green" : color,
                    bold: isSelected,
                    children: `${prefix}[${item.level}] `,
                  }),
                  jsx("text", {
                    bold: isSelected,
                    children: item.targetLabel,
                  }),
                  jsx("text", {
                    dimColor: !isSelected,
                    color: item.isActive ? "yellow" : "gray",
                    children: ` — ${item.statusLabel}`,
                  }),
                ],
              });
            }),
          }),
      jsx("text", {
        dimColor: true,
        marginTop: 1,
        children: "↑/↓ move · Enter action · Esc back",
      }),
    ],
  });
}

export default QuarantinesScreen;
