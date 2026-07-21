-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "subscription" TEXT,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "metadata" TEXT,
    "metadataEnvelopeHash" TEXT,
    "quarantineType" TEXT,
    "quarantineUntil" DATETIME,
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
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "quarantineType" TEXT,
    "quarantineUntil" DATETIME,
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
CREATE INDEX "ModelProviderPricing_modelProviderId_effectiveFrom_idx" ON "ModelProviderPricing"("modelProviderId", "effectiveFrom");
