import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SddPlugin } from '../src/bootstrap/index.js';
import { getOrCreateModelConfigRegistry } from '../src/infrastructure/runtime/model-config-registry.js';
import { getGlobalQuarantineStore } from '../src/infrastructure/runtime/quarantine-store.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaLibSql } from '@prisma/adapter-libsql';

import {
  createPrismaSchemaDatabase,
  makeTempDir,
  removeTempDir,
  restoreEnv,
  snapshotEnv,
} from './helpers/temp-database.js';

console.log('--- Finding 7: bootstrap interception (full temp isolation) ---');

const env = snapshotEnv();
const tmpDir = makeTempDir('sdd-bootstrap-intercept-');

async function runTest(): Promise<void> {
  const dbPath = path.join(tmpDir, 'data', 'opencode-models.db');
  process.env.SDD_PLUGIN_DB_PATH = dbPath;
  delete process.env.DATABASE_URL;
  delete process.env.SDD_PLUGIN_DATA_DIR;

  createPrismaSchemaDatabase(dbPath);

  const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter: prismaAdapter });

  try {
    await prisma.provider.upsert({
      where: { id: 'openai' },
      update: { quarantineType: 'permanent' },
      create: { id: 'openai', name: 'OpenAI', isBlocked: false, quarantineType: 'permanent' },
    });
    await prisma.provider.upsert({
      where: { id: 'anthropic' },
      update: {},
      create: { id: 'anthropic', name: 'Anthropic', isBlocked: false },
    });
    await prisma.model.upsert({
      where: { id: 'gpt-4o' },
      update: {},
      create: { id: 'gpt-4o', name: 'GPT-4o' },
    });
    await prisma.model.upsert({
      where: { id: 'claude-3-5-sonnet' },
      update: {},
      create: { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
    });
    await prisma.modelProvider.upsert({
      where: { modelId_providerId: { modelId: 'gpt-4o', providerId: 'openai' } },
      update: {},
      create: { modelId: 'gpt-4o', providerId: 'openai' },
    });
    await prisma.modelProvider.upsert({
      where: { modelId_providerId: { modelId: 'claude-3-5-sonnet', providerId: 'anthropic' } },
      update: {},
      create: { modelId: 'claude-3-5-sonnet', providerId: 'anthropic' },
    });

    const registry = getOrCreateModelConfigRegistry();
    assert.equal(registry.get('anthropic', 'claude-3-5-sonnet'), undefined);

    const plugin = await SddPlugin({ project: 'test', client: {} });
    const hook = plugin['tool.execute.before'];

    // Use a non-quarantined provider for the registry hydration assertion:
    // a provider-level quarantine on `openai` would otherwise block the
    // legacy task call. (Authoritative quarantine semantics: a quarantined
    // provider MUST prevent the task from running, which is what the block
    // assertion below checks.)
    const output = { args: { subagent_type: 'task-1', model: 'anthropic/claude-3-5-sonnet' } };
    await hook({ tool: 'task' }, output);

    const cached = registry.get('anthropic', 'claude-3-5-sonnet');
    assert.ok(cached !== undefined);
    assert.equal(cached.providerId, 'anthropic');
    assert.equal(cached.modelId, 'claude-3-5-sonnet');
    console.log('  pass: registry-first DB read-through hydration on task interception (temp DB)');

    const qStore = getGlobalQuarantineStore();
    assert.equal(qStore.isActive('openai', 'gpt-4o'), true);
    console.log('  pass: quarantine store DB read-through hydration on task interception');

    // Authoritative quarantine block: a quarantined provider MUST prevent the
    // legacy task call from running. The pre-existing stale test was
    // rewritten to assert the block instead of swallowing it.
    const blockedOutput = { args: { subagent_type: 'task-1', model: 'openai/gpt-4o' } };
    let blocked = false;
    try {
      await hook({ tool: 'task' }, blockedOutput);
    } catch (err) {
      if (err instanceof Error && /quarantined/i.test(err.message)) blocked = true;
    }
    assert.equal(blocked, true, 'quarantined provider blocks the legacy task call');
    console.log('  pass: quarantined provider blocks the legacy task call');
  } finally {
    await prisma.$disconnect();
  }
}

runTest()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    restoreEnv(env);
    removeTempDir(tmpDir);
  });

void fs;
