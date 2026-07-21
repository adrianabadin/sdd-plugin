import type { QuarantineType } from "./quarantine.js";

/**
 * Canonical representation of a Provider in the domain.
 *
 * The "Data" suffix distinguishes the input shape (used by use cases to
 * talk to ports) from any concrete entity class that might wrap behavior.
 */
export interface ProviderData {
  readonly id: string;
  readonly name: string;

  /**
   * Subscription tier if any (small/medium/large). null/undefined = API access.
   * - undefined: source did not provide a value; repository must preserve existing.
   * - null:      source explicitly cleared the value.
   */
  readonly subscription?: string | null | undefined;

  readonly isBlocked?: boolean | null | undefined;

  readonly quarantineType?: QuarantineType | null | undefined;
  readonly quarantineUntil?: Date | null | undefined;
}
