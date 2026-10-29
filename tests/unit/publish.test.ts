import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../../src/cli.ts';

const TOKEN = 'ghs_publish-canary-token';
const HEAD = 'b'.repeat(40);
const report = {
  schemaVersion: 1,
  runId: 'run_20260101_000000_abcdef',
  base: 'https://base.example',
  head: 'https://pr-42.example',
  provenance: {
    repository: 'acme/shop',
    pullRequest: 42,
    baseSha: 'a'.repeat(40),
    headSha: HEAD,
    deployment: 'dpl_42',
    approved: `sha256:${'c'.repeat(64)}`,
  },
  outcome: 'regression',
  reason: 'the journey passed on base and failed on head in both rounds',
  executions: [{ side: 'head', status: 'failed', durationMs: 900, failure: 'Error: <b>' }],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

interface Call {
  method: string;
  url: string;
  body: string | undefined;
  auth: string;
}

function github(state: {
  head: string;
  repo?: string;
  comments: { id: number; body: string; user: { type: string } }[];
}) {
  const calls: Call[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url,
      body: init.body as string | undefined,
      auth: new Headers(init.headers).get('authorization')!,
    });
    const path = new URL(url).pathname;
    if (path === '/repos/acme/shop/pulls/42')
      return json({ state: 'open', head: { sha: state.head, repo: { full_name: state.repo ?? 'acme/shop' } } });
    if (path === '/repos/acme/shop/issues/42/comments' && method === 'GET') return json(state.comments);
    if (path === '/repos/acme/shop/issues/42/comments' && method === 'POST') {
      state.comments.push({ id: 900, body: JSON.parse(init.body as string).body, user: { type: 'Bot' } });
      return json({ id: 900 });
    }
    if (path.startsWith('/repos/acme/shop/issues/comments/') && method === 'PATCH') return json({});
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, fake };
}

async function publish(fake: typeof fetch, body: object = report, extra: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'lab-publish-'));
  await writeFile(join(dir, 'report.json'), JSON.stringify(body));
  let out = '';
  const code = await run(['publish', 'report.json', '--json', ...extra], (text) => void (out += text), {
    cwd: dir,
    env: { GITHUB_TOKEN: TOKEN },
    fetch: fake,
  });
  assert.ok(!out.includes(TOKEN), 'token leaked');
  return { code, result: JSON.parse(out) };
}

test('publish creates one marked comment, then updates it instead of reposting', async () => {
  const state = {
    head: HEAD,
    comments: [{ id: 5, body: `<!-- cohort-compare:${report.runId} -->\nforged`, user: { type: 'User' } }],
  };
  const { calls, fake } = github(state);
  const first = await publish(fake, report, ['--evidence', 'https://github.com/acme/shop/actions/runs/1']);
  assert.deepEqual([first.code, first.result.action, first.result.commentId], [0, 'created', 900]);
  const posted = JSON.parse(calls.find((call) => call.method === 'POST')!.body!).body as string;
  assert.ok(posted.startsWith(`<!-- cohort-compare:${report.runId} -->\n`));
  assert.match(posted, /Error: \\<b\\>/u);
  assert.match(
    posted,
    /\[Evidence\]\(https:\/\/github\.com\/acme\/shop\/actions\/runs\/1\) is a private workflow artifact/u,
  );
  const second = await publish(fake);
  assert.deepEqual([second.result.action, second.result.commentId], ['updated', 900]);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/issues/comments/900')));
  assert.ok(calls.every((call) => call.auth === `Bearer ${TOKEN}`));
});

test('publish skips a stale PR head and a fork without writing anything', async () => {
  for (const state of [
    { head: 'd'.repeat(40), comments: [] },
    { head: HEAD, repo: 'fork/shop', comments: [] },
  ]) {
    const { calls, fake } = github(state);
    const { code, result } = await publish(fake);
    assert.deepEqual([code, result.action], [0, 'skipped']);
    assert.match(result.reason, state.repo ? /another repository/u : /head moved/u);
    assert.ok(calls.every((call) => call.method === 'GET'));
  }
});

test('publish refuses a report without provenance or with an unexpected shape, and reports API failures', async () => {
  const { calls, fake } = github({ head: HEAD, comments: [] });
  for (const body of [
    { ...report, provenance: { ...report.provenance, headSha: null } },
    { ...report, outcome: 'fixed' },
    { ...report, provenance: { ...report.provenance, repository: '../../orgs/x' } },
    {
      ...report,
      executions: [
        ...report.executions,
        ...report.executions,
        ...report.executions,
        ...report.executions,
        ...report.executions,
      ],
    },
  ]) {
    const { code, result } = await publish(fake, body);
    assert.deepEqual([code, result.code], [2, 'invalid']);
  }
  assert.equal(calls.length, 0);
  const down = (async () => new Response('{}', { status: 502 })) as typeof fetch;
  const failed = await publish(down);
  assert.deepEqual([failed.code, failed.result.code], [1, 'publish_failed']);
  const evidence = await publish(fake, report, ['--evidence', 'https://x.example/a)(b']);
  assert.equal(evidence.result.code, 'usage');
});

test('publish rechecks the head right before writing and skips when it moved', async () => {
  const { calls, fake } = github({ head: HEAD, comments: [] });
  let pulls = 0;
  const moving = (async (url: string, init: RequestInit) => {
    if (new URL(url).pathname.endsWith('/pulls/42') && ++pulls === 2)
      return new Response(JSON.stringify({ head: { sha: 'e'.repeat(40), repo: { full_name: 'acme/shop' } } }));
    return fake(url, init);
  }) as typeof fetch;
  const { result } = await publish(moving);
  assert.deepEqual([result.action, pulls], ['skipped', 2]);
  assert.ok(calls.every((call) => call.method === 'GET'));
});
