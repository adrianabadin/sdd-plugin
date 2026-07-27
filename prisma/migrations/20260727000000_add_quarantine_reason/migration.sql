-- Additive nullable column for the operator-supplied quarantine reason.
-- Backwards compatible: existing rows are filled with NULL, the runtime
-- migration in src/infrastructure/runtime/database-path.ts performs the
-- same ALTER TABLE on legacy databases that predate this migration file.
ALTER TABLE "Provider" ADD COLUMN "quarantineReason" TEXT;
ALTER TABLE "Model" ADD COLUMN "quarantineReason" TEXT;
ALTER TABLE "ModelProvider" ADD COLUMN "quarantineReason" TEXT;
