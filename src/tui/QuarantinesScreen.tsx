import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import type { QuarantineEntry } from "../domain/model/quarantine.js";
import { deriveQuarantineView } from "./quarantine-view.js";
import {
  type QuarantineOverlayState,
  type QuarantineCandidate,
  clampCandidateIndex,
  computeCandidateWindow,
  formatCandidateLabel,
  isCandidateShadowed,
} from "./quarantine-overlay.js";

export interface QuarantinesScreenProps {
  entries: QuarantineEntry[];
  selectedIndex?: number;
  loading?: boolean;
  error?: string;
  notice?: string;
  api?: TuiPluginApi;
  overlay?: QuarantineOverlayState | null;
  candidates?: readonly QuarantineCandidate[];
  catalogStatus?: "loading" | "error" | "ready";
  catalogErrorMessage?: string;
}

export function QuarantinesScreen(props: QuarantinesScreenProps): JSX.Element {
  // Plain non-focusable OpenTUI box/text JSX. The `api` prop is
  // retained for type compatibility but is not consulted here.
  void props.api;
  const view = deriveQuarantineView(props.entries);
  const selectedIdx = props.selectedIndex ?? 0;
  const overlay = props.overlay ?? null;
  const candidates = props.candidates ?? [];
  const catalogStatus = props.catalogStatus ?? "ready";

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

  // Render Overlay form when active
  if (overlay) {
    const isRelease = overlay.mode === "release";
    const isCreate = overlay.mode === "create";
    const title =
      isCreate
        ? "[QUARANTINE OVERLAY: CREATE RULE]"
        : overlay.mode === "modify"
          ? "[QUARANTINE OVERLAY: MODIFY RULE]"
          : "[QUARANTINE OVERLAY: CONFIRM RELEASE]";

    const selectedItem =
      overlay.targetIndex !== undefined ? view.items[overlay.targetIndex] : undefined;

    let targetContent: JSX.Element;
    if (isCreate) {
      if (candidates.length === 0) {
        targetContent = jsx("box", {
          marginTop: 1,
          children: jsx("text", {
            color: catalogStatus === "error" ? "red" : "yellow",
            dimColor: catalogStatus === "loading",
            children:
              catalogStatus === "loading"
                ? "Loading connected models…"
                : catalogStatus === "error"
                  ? `Catalog unavailable: ${props.catalogErrorMessage ?? "unknown error"}`
                  : overlay.level === "modelProvider" && overlay.filterQueryBuffer
                    ? `No connected model matches "${overlay.filterQueryBuffer}" — refine the filter or press Esc`
                    : "No connected targets available — press Esc to close",
          }),
        });
      } else {
        const window = computeCandidateWindow(overlay.candidateIndex, candidates.length);
        const candidateRows: JSX.Element[] = [];
        if (window.start > 0) {
          candidateRows.push(
            jsx("text", { dimColor: true, children: `  … ${window.start} above` })
          );
        }
        for (let i = window.start; i < window.end; i++) {
          const candidate = candidates[i]!;
          const isSelected = i === clampCandidateIndex(overlay.candidateIndex, candidates.length);
          const prefix = isSelected ? "> " : "  ";
          const shadowed = isCandidateShadowed(candidate, props.entries);
          const shadowedSuffix = shadowed ? "  (shadowed by an active provider/model rule)" : "";
          candidateRows.push(
            jsxs("box", {
              flexDirection: "row",
              children: [
                jsx("text", {
                  bold: isSelected,
                  color: isSelected ? "green" : shadowed ? "gray" : "white",
                  children: `${prefix}${formatCandidateLabel(candidate)}`,
                }),
                shadowed
                  ? jsx("text", { dimColor: true, children: shadowedSuffix })
                  : null,
              ],
            })
          );
        }
        if (window.end < candidates.length) {
          candidateRows.push(
            jsx("text", { dimColor: true, children: `  … ${candidates.length - window.end} more` })
          );
        }
        targetContent = jsxs("box", {
          flexDirection: "column",
          marginTop: 1,
          children: [
            jsx("text", {
              bold: overlay.focus === "id",
              color: overlay.focus === "id" ? "green" : "white",
              children: `${overlay.focus === "id" ? "> " : "  "}Select Target:`,
            }),
            ...candidateRows,
          ],
        });
      }
    } else {
      targetContent = jsxs("box", {
        flexDirection: "row",
        children: [
          jsx("text", {
            bold: overlay.focus === "id",
            color: overlay.focus === "id" ? "green" : "white",
            children: `${overlay.focus === "id" ? "> " : "  "}${
              overlay.level === "provider" ? "Provider ID" : "Model ID"
            }: `,
          }),
          jsx("text", {
            bold: overlay.focus === "id",
            color: "white",
            children:
              (overlay.level === "provider"
                ? overlay.providerIdBuffer
                : overlay.modelIdBuffer) || "<empty>",
          }),
        ],
      });
    }

    return jsxs("box", {
      flexDirection: "column",
      borderStyle: "double",
      padding: 1,
      children: [
        jsx("text", { bold: true, color: "yellow", children: title }),
        overlay.error
          ? jsx("text", { marginTop: 1, color: "red", children: `ERROR: ${overlay.error}` })
          : null,
        isRelease
          ? jsxs("box", {
              flexDirection: "column",
              marginTop: 1,
              children: [
                jsx("text", {
                  color: "white",
                  children: `Are you sure you want to release quarantine for ${
                    selectedItem ? selectedItem.targetLabel : `entry #${(overlay.targetIndex ?? 0) + 1}`
                  }?`,
                }),
                jsx("text", {
                  dimColor: true,
                  marginTop: 1,
                  children: "Enter confirm release · Esc cancel",
                }),
              ],
            })
          : jsxs("box", {
              flexDirection: "column",
              marginTop: 1,
              children: [
                // Scope Row
                jsxs("box", {
                  flexDirection: "row",
                  children: [
                    jsx("text", {
                      bold: overlay.focus === "scope",
                      color: overlay.focus === "scope" ? "green" : "white",
                      children: `${overlay.focus === "scope" ? "> " : "  "}Scope: `,
                    }),
                    jsx("text", {
                      bold: overlay.level === "provider",
                      color: overlay.level === "provider" ? "cyan" : "gray",
                      children: "[ Provider ] ",
                    }),
                    !isCreate
                      ? jsx("text", {
                          bold: overlay.level === "model",
                          color: overlay.level === "model" ? "cyan" : "gray",
                          children: "[ Model ] ",
                        })
                      : null,
                    jsx("text", {
                      bold: overlay.level === "modelProvider",
                      color: overlay.level === "modelProvider" ? "cyan" : "gray",
                      children: "[ Provider/Model ]",
                    }),
                    jsx("text", {
                      dimColor: true,
                      children: " (Tab / Left/Right toggle scope)",
                    }),
                  ],
                }),

                // Filter Row (Create mode + Provider/Model level only)
                isCreate && overlay.level === "modelProvider"
                  ? jsxs("box", {
                      flexDirection: "row",
                      children: [
                        jsx("text", {
                          bold: overlay.focus === "id",
                          color: overlay.focus === "id" ? "green" : "white",
                          children: "  Filter: ",
                        }),
                        jsx("text", {
                          color: "white",
                          children: overlay.filterQueryBuffer || "<type to filter>",
                        }),
                      ],
                    })
                  : null,

                // Target Selection (Create mode) vs Identifier Row (Modify mode)
                targetContent,

                // Reason Row
                jsxs("box", {
                  flexDirection: "row",
                  children: [
                    jsx("text", {
                      bold: overlay.focus === "reason",
                      color: overlay.focus === "reason" ? "green" : "white",
                      children: `${overlay.focus === "reason" ? "> " : "  "}Reason: `,
                    }),
                    jsx("text", {
                      bold: overlay.focus === "reason",
                      color: "white",
                      children: overlay.reasonBuffer || "<empty (required)>",
                    }),
                  ],
                }),
                // Duration Row
                jsxs("box", {
                  flexDirection: "row",
                  children: [
                    jsx("text", {
                      bold: overlay.focus === "duration",
                      color: overlay.focus === "duration" ? "green" : "white",
                      children: `${overlay.focus === "duration" ? "> " : "  "}Duration: `,
                    }),
                    jsx("text", {
                      bold: overlay.durationKind === "permanent",
                      color: overlay.durationKind === "permanent" ? "cyan" : "gray",
                      children: "[ Permanent ] ",
                    }),
                    jsx("text", {
                      bold: overlay.durationKind === "ttl",
                      color: overlay.durationKind === "ttl" ? "cyan" : "gray",
                      children: "[ TTL Hours ]",
                    }),
                    jsx("text", {
                      dimColor: true,
                      children: " (Tab / Left/Right toggle duration)",
                    }),
                  ],
                }),
                // TTL Hours Row (if TTL selected)
                overlay.durationKind === "ttl"
                  ? jsxs("box", {
                      flexDirection: "row",
                      children: [
                        jsx("text", {
                          bold: overlay.focus === "ttl",
                          color: overlay.focus === "ttl" ? "green" : "white",
                          children: `${overlay.focus === "ttl" ? "> " : "  "}TTL (hours): `,
                        }),
                        jsx("text", {
                          bold: overlay.focus === "ttl",
                          color: "white",
                          children: overlay.ttlHoursBuffer || "<empty>",
                        }),
                      ],
                    })
                  : null,
                jsx("text", {
                  dimColor: true,
                  marginTop: 1,
                  children: isCreate
                    ? "↑/↓ select target · Tab/Shift+Tab navigate field · Enter commit · Esc cancel"
                    : "Tab/Shift+Tab navigate field · Enter commit · Esc cancel",
                }),
              ],
            }),
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
              const reasonSuffix = item.reasonLabel ? ` (${item.reasonLabel})` : "";
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
                    children: ` — ${item.statusLabel}${reasonSuffix}`,
                  }),
                ],
              });
            }),
          }),
      jsx("text", {
        dimColor: true,
        marginTop: 1,
        children: "↑/↓ move · c create · m modify · r release · Esc back",
      }),
    ],
  });
}

export default QuarantinesScreen;