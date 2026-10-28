import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../../src/cli.ts';

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await run(argv, (text) => {
    out += text;
  });
  return { code, out };
}

test('prints the package version', async () => {
  const { code, out } = await capture(['--version']);
  assert.equal(code, 0);
  assert.match(out, /^\d+\.\d+\.\d+/);
});

test('prints usage with no arguments', async () => {
  const { code, out } = await capture([]);
  assert.equal(code, 0);
  assert.match(out, /^Usage: lab/);
});

test('rejects an unknown command', async () => {
  const { code, out } = await capture(['nope']);
  assert.equal(code, 2);
  assert.match(out, /Unknown command: nope/);
});

test('rejects an unknown option', async () => {
  const { code, out } = await capture(['--bogus']);
  assert.equal(code, 2);
  assert.match(out, /Unknown option '--bogus'/);
  assert.match(out, /Usage: lab/);
});

test('invalid run invocations exit 2 before reading any project', async () => {
  const cases: [string[], RegExp][] = [
    [['run'], /choose --persona, --tag, --suite, or --url with --note/u],
    [['run', '--persona', 'a', '--tag', 'b'], /choose one of/u],
    [['run', '--persona', 'a', '--repeats', 'abc'], /submission\.repeats: must be a number/u],
    [['run', '--persona', 'a', '--effort', 'max'], /submission\.effort: must be one of/u],
    [['run', '--url', 'http://a.test/'], /url and note/u],
    [['run', 'extra'], /Unknown command: run extra/u],
  ];
  for (const [argv, expected] of cases) {
    const { code, out } = await capture(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.match(out, expected);
  }
});
