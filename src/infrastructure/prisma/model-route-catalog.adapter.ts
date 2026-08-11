/**
 * Adapter: implement `ModelRouteCatalogPort` over the Prisma SQLite catalog
 * (`Provider` / `Model` / `ModelProvider`). Identity-only projection;
 * never selects benchmark/pricing/subscription columns (design c96148ae).
 */

import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ModelRouteCatalogPort, RouteCandidate } from "../../ports/model-route-catalog.port.js";

export class PrismaModelRouteCatalogAdapter implements ModelRouteCatalogPort {
  constructor(private readonly prisma: PrismaClient) {}

  async existsCanonical(providerId: string, modelId: string): Promise<boolean> {
    if (typeof providerId !== "string" || typeof modelId !== "string") return false;
    if (providerId.length === 0 || modelId.length === 0) return false;
    const row = await this.prisma.modelProvider.findUnique({
      where: { modelId_providerId: { modelId, providerId } },
      select: { modelId: true },
    });
    return row !== null;
  }

  async searchNormalized(term: string, limit: number): Promise<ReadonlyArray<RouteCandidate>> {
    if (typeof term !== "string" || term.length === 0) return [];
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 64));
    const needle = term.toLowerCase();
    const rows = await this.prisma.$queryRaw<
      ReadonlyArray<{ providerId: string; modelId: string; modelName: string }>
    >`
      SELECT mp.providerId AS providerId, m.id AS modelId, m.name AS modelName
      FROM ModelProvider mp
      INNER JOIN Model m ON m.id = mp.modelId
      WHERE LOWER(mp.providerId) LIKE ${"%" + needle + "%"}
         OR LOWER(m.id)         LIKE ${"%" + needle + "%"}
         OR LOWER(m.name)       LIKE ${"%" + needle + "%"}
      ORDER BY mp.providerId ASC, m.id ASC
      LIMIT ${boundedLimit}
    `;
    return rows.map((row) => ({
      providerId: row.providerId,
      modelId: row.modelId,
      modelName: row.modelName,
    }));
  }
}
