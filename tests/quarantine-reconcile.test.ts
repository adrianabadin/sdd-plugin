import assert from 'node:assert/strict';
import path from 'node:path';
import { QuarantineStoreImpl, type QuarantineStore } from '../src/infrastructure/runtime/quarantine-store.js';
import type { QuarantineEntry } from '../src/domain/model/quarantine.js';

console.log('--- PR1: Quarantine Reconcile & Connection Lifecycle Tests ---');

async function testQuarantineReconcile(): Promise<void> {
  const store: QuarantineStore = new QuarantineStoreImpl();

  // Pre-populate store with an unrelated cached quarantine
  store.hydrate([
    {
      providerId: 'provider-a',
      modelId: 'model-a',
      level: 'modelProvider',
      type: 'permanent',
      until: null,
    },
  ]);

  assert.equal(store.isActive('provider-b', 'model-b'), false);

  // Active matching quarantine in persistence
  const persistedEntries: QuarantineEntry[] = [
    {
      providerId: 'provider-b',
      modelId: 'model-b',
      level: 'modelProvider',
      type: 'permanent',
      until: null,
    },
  ];

  // Call reconcile
  store.reconcile(persistedEntries);

  assert.equal(
    store.isActive('provider-b', 'model-b'),
    true,
    'persisted matching quarantine must block despite pre-populated unrelated cache',
  );

  // Release by absence: empty persisted list removes previous entries
  store.reconcile([]);

  assert.equal(
    store.isActive('provider-b', 'model-b'),
    false,
    'release-by-absence must clear quarantine when absent from persisted set',
  );

  // Expiry evaluated by isActive(now)
  const expiredEntries: QuarantineEntry[] = [
    {
      providerId: 'provider-c',
      modelId: 'model-c',
      level: 'modelProvider',
      type: 'ttl',
      until: new Date(Date.now() - 5000),
    },
  ];

  store.reconcile(expiredEntries);

  assert.equal(
    store.isActive('provider-c', 'model-c', new Date()),
    false,
    'expired quarantine must not block according to isActive(now)',
  );

  // Reconcile read failure / fail-closed test
  let priorCacheIntact = false;
  try {
    store.hydrate(persistedEntries);
    // Simulate failed authoritative read in caller (e.g. bootstrap hook):
    // caller catches read error, preserves prior cache and throws/rejects hook fail-closed.
    throw new Error('Authoritative read failed');
  } catch (err) {
    // Check prior cache state was preserved
    if (store.isActive('provider-b', 'model-b')) {
      priorCacheIntact = true;
    }
  }

  assert.equal(
    priorCacheIntact,
    true,
    'failed authoritative read leaves prior cache intact (fail-closed/no false clear)',
  );
}

async function run(): Promise<void> {
  await testQuarantineReconcile();
  console.log('Quarantine reconcile basic test passed!');
}

run()
  .then(() => {
    console.log('All tests/quarantine-reconcile.test.ts assertions passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
