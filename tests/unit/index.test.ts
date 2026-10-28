import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BundleError,
  CatalogError,
  ConfigError,
  createProviders,
  loadCatalog,
  loadProjectConfig,
  replayRun,
  resolveSubmission,
  run,
  runBatch,
  validateClaim,
  validateSubmission,
} from '../../src/index.ts';

test('the package entry exposes the engine API', () => {
  for (const fn of [
    run,
    loadProjectConfig,
    loadCatalog,
    createProviders,
    validateSubmission,
    resolveSubmission,
    runBatch,
    replayRun,
    validateClaim,
  ])
    assert.equal(typeof fn, 'function');
  assert.ok(new ConfigError('x') instanceof Error);
  assert.ok(new CatalogError('x') instanceof Error);
  assert.ok(new BundleError('x') instanceof Error);
});
