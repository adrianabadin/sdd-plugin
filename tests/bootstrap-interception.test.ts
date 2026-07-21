import assert from 'node:assert/strict';
import { SddPlugin } from '../src/bootstrap/index.js';
import { getOrCreateModelConfigRegistry } from '../src/infrastructure/runtime/model-config-registry.js';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { execSync } from 'node:child_process';
import path from 'node:path';

console.log('--- Bootstrap Runtime Interception & Hydration Test ---');

const dbPath = path.resolve('opencode-models.test.db');
process.env.SDD_PLUGIN_DB_PATH = dbPath;
process.env.DATABASE_URL = `file:${dbPath}`;
execSync('npx prisma db push --accept-data-loss', { stdio: 'ignore' });

const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter: prismaAdapter });

async function runTest() {
  // Seed provider & model in DB
  await prisma.provider.upsert({
    where: { id: 'openai' },
    update: {},
    create: { id: 'openai', name: 'OpenAI', isBlocked: false },
  });
  await prisma.model.upsert({
    where: { id: 'gpt-4o' },
    update: {},
    create: { id: 'gpt-4o', name: 'GPT-4o' },
  });
  await prisma.modelProvider.upsert({
    where: { modelId_providerId: { modelId: 'gpt-4o', providerId: 'openai' } },
    update: {},
    create: { modelId: 'gpt-4o', providerId: 'openai' },
  });

  const registry = getOrCreateModelConfigRegistry();
  assert.equal(registry.get('openai', 'gpt-4o'), undefined);

  const plugin = await SddPlugin({ project: 'test', client: {} });
  const hook = plugin['tool.execute.before'];

  const output = { args: { subagent_type: 'task-1', model: 'openai/gpt-4o' } };
  await hook({ tool: 'task' }, output);

  // Assert DB read-through hydrated the registry!
  const cached = registry.get('openai', 'gpt-4o');
  assert.ok(cached !== undefined);
  assert.equal(cached.providerId, 'openai');
  assert.equal(cached.modelId, 'gpt-4o');
  console.log('  pass: registry-first DB read-through hydration on task interception');

  await prisma.$disconnect();
}

runTest().catch((e) => {
  console.error(e);
  process.exit(1);
});
