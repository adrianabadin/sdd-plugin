/**
 * Prisma adapter for `ModelRouteQuarantinePort`.
 *
 * Reads the live Provider/Model/ModelProvider quarantine columns and returns
 * a QuarantineEntry[] projection. Expired TTL rows are filtered out at the
 * SQL boundary. Identity-only projection: never selects benchmark/pricing/
 * subscription columns (design 0695919c).
 */

import type { PrismaClient } from "@prisma/client";

import type { ModelRouteQuarantinePort } from "../../ports/model-route-quarantine.port.js";
import type { QuarantineEntry, QuarantineLevel } from "../../domain/model/quarantine.js";

interface QuarantineRow {
  quarantineType: string | null;
  quarantineUntil: Date | null;
  quarantineReason: string | null;
}

interface ProviderRow extends QuarantineRow { id: string; }
interface ModelRow extends QuarantineRow { id: string; }
interface ModelProviderRow extends QuarantineRow { providerId: string; modelId: string; }

function asEntry(
  level: QuarantineLevel,
  target: { providerId?: string; modelId?: string },
  row: QuarantineRow,
  now: Date,
): QuarantineEntry | null {
  if (row.quarantineType === "permanent") {
    return { level, ...target, type: "permanent", until: null, reason: row.quarantineReason };
  }
  if (row.quarantineType === "ttl" && row.quarantineUntil && now.getTime() < row.quarantineUntil.getTime()) {
    return { level, ...target, type: "ttl", until: row.quarantineUntil, reason: row.quarantineReason };
  }
  return null;
}

const ACTIVE_FILTER = {
  OR: [
    { quarantineType: "permanent" },
    { quarantineType: "ttl", quarantineUntil: { gt: new Date(0) } },
  ],
} as const;

const ACTIVE_COLUMNS = {
  quarantineType: true,
  quarantineUntil: true,
  quarantineReason: true,
} as const;

export class PrismaModelRouteQuarantineAdapter implements ModelRouteQuarantinePort {
  constructor(private readonly prisma: PrismaClient) {}

  async listActive(now: Date = new Date()): Promise<ReadonlyArray<QuarantineEntry>> {
    const filter = { OR: ACTIVE_FILTER.OR.map((clause) => "quarantineUntil" in clause
      ? { quarantineType: clause.quarantineType, quarantineUntil: { gt: now } }
      : { quarantineType: clause.quarantineType }) };

    const [providerRows, modelRows, modelProviderRows] = await Promise.all([
      this.prisma.provider.findMany({ where: filter, select: { id: true, ...ACTIVE_COLUMNS } }) as Promise<ReadonlyArray<ProviderRow>>,
      this.prisma.model.findMany({ where: filter, select: { id: true, ...ACTIVE_COLUMNS } }) as Promise<ReadonlyArray<ModelRow>>,
      this.prisma.modelProvider.findMany({ where: filter, select: { providerId: true, modelId: true, ...ACTIVE_COLUMNS } }) as Promise<ReadonlyArray<ModelProviderRow>>,
    ]);

    const out: QuarantineEntry[] = [];
    for (const row of providerRows) {
      const entry = asEntry("provider", { providerId: row.id }, row, now);
      if (entry) out.push(entry);
    }
    for (const row of modelRows) {
      const entry = asEntry("model", { modelId: row.id }, row, now);
      if (entry) out.push(entry);
    }
    for (const row of modelProviderRows) {
      const entry = asEntry("modelProvider", { providerId: row.providerId, modelId: row.modelId }, row, now);
      if (entry) out.push(entry);
    }
    return out;
  }
}
