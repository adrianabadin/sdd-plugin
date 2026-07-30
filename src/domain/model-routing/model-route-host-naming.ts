import { createHash } from "node:crypto";

import {
  makeCanonicalModelId,
  type CanonicalModelId,
} from "./canonical-model-id.js";

export const ROUTED_HOST_NAME_PREFIX = "sdd-mr-v1-";
const ROUTED_HOST_NAME_HEX_LENGTH = 16;

export type RoutedHostName = string & {
  readonly __routedHostName: unique symbol;
};

export type CanonicalModelIdentity = Pick<
  CanonicalModelId,
  "providerId" | "modelId"
>;

export function formatCanonicalModelId(
  canonical: CanonicalModelIdentity,
): string {
  return makeCanonicalModelId(
    canonical.providerId,
    canonical.modelId,
  ).toString();
}

export function hashHostName(
  baseTemplate: string,
  canonical: CanonicalModelIdentity,
): RoutedHostName {
  if (typeof baseTemplate !== "string" || baseTemplate.length === 0) {
    throw new Error("hashHostName: base template must be non-empty");
  }

  const digest = createHash("sha256")
    .update(`${baseTemplate}\u0000${formatCanonicalModelId(canonical)}`)
    .digest("hex");

  return `${ROUTED_HOST_NAME_PREFIX}${digest.slice(0, ROUTED_HOST_NAME_HEX_LENGTH)}` as RoutedHostName;
}
