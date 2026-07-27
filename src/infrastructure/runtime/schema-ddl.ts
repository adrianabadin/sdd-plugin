/**
 * Bundled DDL source for clean installations.
 *
 * `prisma/migrations/` is not included in the published NPM package (only `dist/`),
 * so runtime initialization cannot read `migration.sql` from disk. This string is
 * emitted into `dist/schema-ddl.js` during build and ensures clean installations
 * can self-provision without external file dependencies.
 */
export const SCHEMA_DDL = `-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "subscription" TEXT,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "metadata" TEXT,
    "metadataEnvelopeHash" TEXT,
    "quarantineType" TEXT,
    "quarantineUntil" DATETIME,
    "quarantineReason" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Model" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "metadata" TEXT,
    "metadataEnvelopeHash" TEXT,
    "mmlu" REAL,
    "humaneval" REAL,
    "sweBench" REAL,
    "gpqa" REAL,
    "math" REAL,
    "bbh" REAL,
    "mtBench" REAL,
    "multineedle" REAL,
    "quarantineType" TEXT,
    "quarantineUntil" DATETIME,
    "quarantineReason" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "quarantineType" TEXT,
    "quarantineUntil" DATETIME,
    "quarantineReason" TEXT,
    CONSTRAINT "ModelProvider_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModelProvider_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelProviderPricing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelProviderId" TEXT NOT NULL,
    "inputPerMillion" REAL,
    "outputPerMillion" REAL,
    "cachedPerMillion" REAL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveUntil" DATETIME,
    CONSTRAINT "ModelProviderPricing_modelProviderId_fkey" FOREIGN KEY ("modelProviderId") REFERENCES "ModelProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelProvider_modelId_providerId_key" ON "ModelProvider"("modelId", "providerId");

-- CreateIndex
CREATE INDEX "ModelProviderPricing_modelProviderId_effectiveFrom_idx" ON "ModelProviderPricing"("modelProviderId", "effectiveFrom");`;

export interface SchemaColumnSpec {
  table: string;
  column: string;
}

export interface SchemaIndexSpec {
  name: string;
  table: string;
}

export interface SchemaFkSpec {
  table: string;
  foreignKey: string;
}

export const REQUIRED_SCHEMA_COLUMNS: readonly SchemaColumnSpec[] = [
  // Provider
  { table: 'Provider', column: 'id' },
  { table: 'Provider', column: 'name' },
  { table: 'Provider', column: 'subscription' },
  { table: 'Provider', column: 'isBlocked' },
  { table: 'Provider', column: 'metadata' },
  { table: 'Provider', column: 'metadataEnvelopeHash' },
  { table: 'Provider', column: 'quarantineType' },
  { table: 'Provider', column: 'quarantineUntil' },
  { table: 'Provider', column: 'quarantineReason' },
  { table: 'Provider', column: 'updatedAt' },

  // Model
  { table: 'Model', column: 'id' },
  { table: 'Model', column: 'name' },
  { table: 'Model', column: 'metadata' },
  { table: 'Model', column: 'metadataEnvelopeHash' },
  { table: 'Model', column: 'mmlu' },
  { table: 'Model', column: 'humaneval' },
  { table: 'Model', column: 'sweBench' },
  { table: 'Model', column: 'gpqa' },
  { table: 'Model', column: 'math' },
  { table: 'Model', column: 'bbh' },
  { table: 'Model', column: 'mtBench' },
  { table: 'Model', column: 'multineedle' },
  { table: 'Model', column: 'quarantineType' },
  { table: 'Model', column: 'quarantineUntil' },
  { table: 'Model', column: 'quarantineReason' },
  { table: 'Model', column: 'updatedAt' },

  // ModelProvider
  { table: 'ModelProvider', column: 'id' },
  { table: 'ModelProvider', column: 'modelId' },
  { table: 'ModelProvider', column: 'providerId' },
  { table: 'ModelProvider', column: 'quarantineType' },
  { table: 'ModelProvider', column: 'quarantineUntil' },
  { table: 'ModelProvider', column: 'quarantineReason' },

  // ModelProviderPricing
  { table: 'ModelProviderPricing', column: 'id' },
  { table: 'ModelProviderPricing', column: 'modelProviderId' },
  { table: 'ModelProviderPricing', column: 'inputPerMillion' },
  { table: 'ModelProviderPricing', column: 'outputPerMillion' },
  { table: 'ModelProviderPricing', column: 'cachedPerMillion' },
  { table: 'ModelProviderPricing', column: 'currency' },
  { table: 'ModelProviderPricing', column: 'effectiveFrom' },
  { table: 'ModelProviderPricing', column: 'effectiveUntil' },
] as const;

export const REQUIRED_SCHEMA_INDEXES: readonly SchemaIndexSpec[] = [
  { name: 'ModelProvider_modelId_providerId_key', table: 'ModelProvider' },
  { name: 'ModelProviderPricing_modelProviderId_effectiveFrom_idx', table: 'ModelProviderPricing' },
] as const;

export const REQUIRED_SCHEMA_FKS: readonly SchemaFkSpec[] = [
  { table: 'ModelProvider', foreignKey: 'modelId' },
  { table: 'ModelProvider', foreignKey: 'providerId' },
  { table: 'ModelProviderPricing', foreignKey: 'modelProviderId' },
] as const;
