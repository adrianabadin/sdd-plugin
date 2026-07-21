import { isQuarantineActive, type QuarantineEntry } from "../domain/model/quarantine.js";

export interface QuarantineItemView {
  entry: QuarantineEntry;
  level: "provider" | "model" | "modelProvider";
  targetLabel: string;
  statusLabel: string;
  isActive: boolean;
}

export interface QuarantineViewResult {
  items: QuarantineItemView[];
  isEmpty: boolean;
  activeCount: number;
}

export function deriveQuarantineView(
  entries: QuarantineEntry[],
  now: Date = new Date(),
): QuarantineViewResult {
  if (!entries || entries.length === 0) {
    return { items: [], isEmpty: true, activeCount: 0 };
  }

  const items: QuarantineItemView[] = entries.map((entry) => {
    const active = isQuarantineActive(entry, now);
    let targetLabel = "";
    if (entry.level === "provider") {
      targetLabel = entry.providerId ?? "unknown-provider";
    } else if (entry.level === "model") {
      targetLabel = entry.modelId ?? "unknown-model";
    } else if (entry.level === "modelProvider") {
      targetLabel = `${entry.providerId ?? "unknown"}/${entry.modelId ?? "unknown"}`;
    }

    let statusLabel = "";
    if (entry.type === "permanent") {
      statusLabel = "ACTIVE (Permanent)";
    } else if (entry.type === "ttl") {
      if (active && entry.until) {
        const remainingMs = entry.until.getTime() - now.getTime();
        const remainingMins = Math.max(1, Math.round(remainingMs / 60000));
        statusLabel = `ACTIVE (Expires in ${remainingMins}m)`;
      } else {
        statusLabel = "EXPIRED (Inactive)";
      }
    }

    return {
      entry,
      level: entry.level,
      targetLabel,
      statusLabel,
      isActive: active,
    };
  });

  // Sort active first, then level precedence provider > model > modelProvider, then targetLabel
  items.sort((a, b) => {
    if (a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }
    const levelRank = { provider: 1, model: 2, modelProvider: 3 };
    const rankA = levelRank[a.level] ?? 4;
    const rankB = levelRank[b.level] ?? 4;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return a.targetLabel.localeCompare(b.targetLabel);
  });

  const activeCount = items.filter((i) => i.isActive).length;

  return {
    items,
    isEmpty: false,
    activeCount,
  };
}
