import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebCadClient } from './cadClient.js';

test('the web catalog poll asks nothing while the page is hidden, and only whether it changed while it is seen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = { visibilityState: 'visible' };
  const tags = [];
  let revision = 'r1';
  const client = createWebCadClient({ document: page, fetch: async (_url, options) => {
    const sent = options.headers?.['if-none-match'] || '';
    tags.push(sent);
    const headers = new Headers({ etag: `"${revision}"` });
    if (sent === `"${revision}"`) return { ok: false, status: 304, headers, json: async () => { throw new SyntaxError('a 304 has no body'); } };
    return { ok: true, status: 200, headers, json: async () => ({ revision, entries: [{ file: 'part.step', hash: revision }] }) };
  } });
  t.after(() => client.dispose());
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const tick = async (ms) => { for (let at = 0; at < ms; at += 2000) { t.mock.timers.tick(2000); await settle(); } };
  t.after(client.subscribe(() => {}));
  await settle();
  const read = client.getSnapshot();
  await tick(2000);
  assert.deepEqual(tags, ['', '"r1"'], 'a seen page asks whether its catalog changed');
  assert.equal(client.getSnapshot(), read, 'and an unchanged catalog publishes nothing');
  page.visibilityState = 'hidden';
  revision = 'r2';
  await tick(10_000);
  assert.equal(tags.length, 2, 'a hidden page asks nothing');
  page.visibilityState = 'visible';
  await tick(2000);
  assert.deepEqual(tags.slice(2), ['"r1"']);
  assert.equal(client.getSnapshot().entries[0].hash, 'r2');
});
