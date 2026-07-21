/**
 * Domain primitive: the lifetime of a quarantine at any level.
 *
 * - "ttl":      active until `quarantineUntil` (e.g. temporary outage).
 * - "permanent": never re-enabled until a human intervenes.
 *
 * This type is intentionally narrow (string literal union) so the use case
 * cannot accidentally persist a malformed value.
 */
export type QuarantineType = "ttl" | "permanent";
