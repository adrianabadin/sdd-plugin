import type { RefreshedModelEntry } from "./refreshed-model.js";

export function formatConnectedModels(
  models: ReadonlyArray<RefreshedModelEntry>,
): string {
  const header = `Refreshed connected models count: ${models.length}\n`;
  const body = models
    .map((model) =>
      ` - [${model.providerId}] ${model.modelId}${model.pricingInfo ? ` (${model.pricingInfo})` : ""}`,
    )
    .join("\n");

  return header + body;
}
