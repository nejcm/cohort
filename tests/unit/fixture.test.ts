import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEALTHY_MINIMUM_ACTIONS, MUTATIONS, type Mutation } from '../fixtures/friction-app/scenarios.ts';
import { startFixture } from '../fixtures/friction-app/server.ts';

async function journey(mutations: Mutation[], form: Record<string, string>) {
  const fixture = await startFixture({ mutations });
  try {
    const get = async (path: string): Promise<string> => (await fetch(`${fixture.url}${path}`)).text();
    const post = (path: string, body: Record<string, string>) =>
      fetch(`${fixture.url}${path}`, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
    const pages = { home: await get('/?scope=t'), request: await get('/request?scope=t') };
    const review = await (await post('/review?scope=t', form)).text();
    const submit = await post('/submit?scope=t', form);
    return { pages, review, submit, stored: fixture.submissions('t') };
  } finally {
    await fixture.close();
  }
}

test('healthy journey stores one scoped submission', async () => {
  const form = { name: 'Ana', arrival: 'Afternoon', notes: '' };
  const { pages, review, submit, stored } = await journey([], form);
  assert.match(pages.home, />Arrival instructions</u);
  assert.match(review, /Send request/u);
  assert.equal(submit.status, 303);
  assert.equal(submit.headers.get('location'), '/confirmation?scope=t');
  assert.deepEqual(stored, [form]);
  assert.equal(HEALTHY_MINIMUM_ACTIONS, 6);
});

test('each seeded mutation changes only its documented surface', async () => {
  assert.deepEqual(Object.keys(MUTATIONS).toSorted(), [
    'confusing_label',
    'extra_field',
    'hidden_primary',
    'icon_only',
  ]);
  const base = { name: 'Ana', arrival: 'Evening', notes: '' };
  assert.match((await journey(['confusing_label'], base)).pages.home, />Orientation module</u);
  assert.match((await journey(['icon_only'], base)).pages.home, /aria-label="Contact host"[^>]*>✉</u);
  assert.match((await journey(['hidden_primary'], base)).pages.request, /height: 1800px/u);
  const extra = await journey(['extra_field'], base);
  assert.match(extra.review, /Please enter your company\./u);
  assert.match(extra.pages.request, /Company \(required\)/u);
});

test('review rejects missing fields with alerts', async () => {
  const { review } = await journey([], { name: '', arrival: 'Lunch', notes: '' });
  assert.match(review, /role="alert">Please enter your name\./u);
  assert.match(review, /role="alert">Please choose an arrival time\./u);
});
