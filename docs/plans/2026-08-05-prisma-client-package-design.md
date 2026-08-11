# Prisma Client Package Design

**Goal:** Make the published `sdd-plugin2` package importable by OpenCode without relying on a workspace-local `node_modules/.prisma` directory.

**Decision:** Generate Prisma Client into `src/generated/prisma`, compile it into `dist/generated/prisma`, and import that generated client from production runtime modules. The package already publishes `dist/`, so the generated runtime and schema become part of the same distributable artifact.

**Verification:** Add a package-artifact test that requires a completed build and checks `npm pack --dry-run --json` contains the generated client and schema. Then install the resulting package in OpenCode and rerun the public SDD-tool E2E.

**Alternatives rejected:** Lazy Prisma loading would leave model-routing runtime broken; manually copying `.prisma` would depend on private `@prisma/client` layout.
