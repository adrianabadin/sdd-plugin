import type {
  QuarantineEntry,
  QuarantineTarget,
  QuarantineType,
  QuarantineLevel,
} from "../domain/model/quarantine.js";

export interface SetQuarantineCommand {
  level: QuarantineLevel;
  providerId?: string;
  modelId?: string;
  type: QuarantineType;
  until?: Date | null;
  /**
   * Operator-supplied reason. The use case trims and re-validates the value
   * before persisting; implementations SHOULD write the trimmed value (or
   * `null` for an absent/empty reason) to the `quarantineReason` column.
   */
  reason?: string | null;
}

export interface QuarantineWritePort {
  setQuarantine(cmd: SetQuarantineCommand): Promise<QuarantineEntry>;
  releaseQuarantine(target: QuarantineTarget): Promise<void>;
  listQuarantines(): Promise<QuarantineEntry[]>;
}
