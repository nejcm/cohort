import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../../src/cli.ts';

function capture(argv: string[]): { code: number; out: string } {
  let out = '';
  const code = run(argv, (text) => {
    out += text;
  });
  return { code, out };
}

test('prints the package version', () => {
  const { code, out } = capture(['--version']);
  assert.equal(code, 0);
  assert.match(out, /^\d+\.\d+\.\d+/);
});

test('prints usage with no arguments', () => {
  const { code, out } = capture([]);
  assert.equal(code, 0);
  assert.match(out, /^Usage: lab/);
});

test('rejects an unknown command', () => {
  const { code, out } = capture(['nope']);
  assert.equal(code, 2);
  assert.match(out, /Unknown command: nope/);
});

test('rejects an unknown option', () => {
  const { code, out } = capture(['--bogus']);
  assert.equal(code, 2);
  assert.match(out, /Unknown option '--bogus'/);
  assert.match(out, /Usage: lab/);
});
