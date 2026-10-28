import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CatalogError,
  ConfigError,
  createProviders,
  loadCatalog,
  loadProjectConfig,
  resolveSubmission,
  run,
  runBatch,
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
  ])
    assert.equal(typeof fn, 'function');
  assert.ok(new ConfigError('x') instanceof Error);
  assert.ok(new CatalogError('x') instanceof Error);
});
