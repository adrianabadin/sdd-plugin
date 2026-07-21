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
}

export interface QuarantineWritePort {
  setQuarantine(cmd: SetQuarantineCommand): Promise<QuarantineEntry>;
  releaseQuarantine(target: QuarantineTarget): Promise<void>;
  listQuarantines(): Promise<QuarantineEntry[]>;
}
