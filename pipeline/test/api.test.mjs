import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4390 + Math.floor(Math.random() * 50);
const BASE = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'deskcheck-test-'));
let server;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => fetch(BASE + p).then(async (r) => ({ status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }));
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, data: await r.json() }));

async function runs() {
  const r = await fetch(BASE + '/api/events');
  const reader = r.body.getReader();
  const { value } = await reader.read();
  reader.cancel();
  return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
}

function seedMarkedRun() {
  const dir = join(DIR, '777777');
  mkdirSync(join(dir, 'shots', 'web'), { recursive: true });
  for (const f of ['S1-01-marked', 'S1-02-plain']) {
    writeFileSync(join(dir, 'shots', `${f}.png`), '');
    writeFileSync(join(dir, 'shots', 'web', `${f}.jpg`), '');
  }
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ scenarios: [{ id: 'S1', shots: [{ file: 'S1-01-marked.png', marks: [{ n: 1, note: 'Aqui', x: 1, y: 2, width: 3, height: 4 }] }, { file: 'S1-02-plain.png' }] }] }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ id: 777777, status: 'done', title: 'seeded', step: 5, log: [], finishedAt: '2026-01-01T00:00:00Z', result: { verdict: 'rejected', scenarios: [], defects: [] } }));
}

before(async () => {
  seedMarkedRun();
  server = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs'), '--simulate'], { env: { ...process.env, PORT: String(PORT), DESKCHECK_ROOT: DIR, DESKCHECK_PIPELINE_CONFIG: join(ROOT, 'pipeline.config.example.json') }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { await get('/api/config'); return; } catch { await sleep(150); }
  }
  throw new Error('server did not start');
});
after(() => { server?.kill(); rmSync(DIR, { recursive: true, force: true }); });

test('serves the front and the vendored React', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.data, /Esteira de Desk Check/);
  assert.doesNotMatch(home.data, /cdnjs|unpkg|jsdelivr/);
  assert.equal((await get('/vendor/react.production.min.js')).status, 200);
});

test('lists agents and config', async () => {
  const agents = await get('/api/agents');
  assert.deepEqual(agents.data.map((x) => x.id), ['agent', 'agent-events']);
  const config = await get('/api/config');
  assert.equal(config.data.simulate, true);
  assert.equal(config.data.defaultAgent, 'agent');
  assert.equal(config.data.defaultDataMode, 'real');
  assert.equal(config.data.defaultEnv, 'dev');
  assert.equal(config.data.envs.dev.adminUsers, 'https://app.dev.example.com/admin/users');
  assert.equal(config.data.envs.stg.appUsers, 'https://app.stg.example.com/web/admin/users');
  assert.equal(config.data.steps.length, 5);
  const loginRes = await post('/api/login', { url: 'https://dev.azure.com' });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.data.ok, true);
});

test('rejects a link without a number and an unknown agent', async () => {
  assert.equal((await post('/api/runs', { link: 'abc' })).status, 400);
  const unknown = await post('/api/runs', { link: '123456', agent: 'skynet' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /skynet/);
  assert.equal(unknown.data.code, 'agent.unknown');
  assert.equal(unknown.data.params.id, 'skynet');
  assert.equal((await post('/api/runs', { link: 'abc' })).data.code, 'link.noNumber');
});

test('does not serve files outside the report folder', async () => {
  assert.equal((await get('/report/123456/..%2F..%2Fpackage.json')).status, 404);
});

test('simulated desk check reaches a verdict and is saved to history', async () => {
  const r = await post('/api/runs', { link: 'https://dev.azure.com/x/_workitems/edit/123456', agent: 'agent-events' });
  assert.equal(r.status, 201);
  assert.equal(r.data.agent, 'agent-events');
  assert.equal(r.data.dataMode, 'real');
  assert.equal(r.data.env, 'dev');
  assert.equal((await post('/api/runs', { link: '123456' })).status, 409, 'same card twice at the same time');
  let run;
  for (let i = 0; i < 60; i++) {
    run = (await runs()).find((x) => x.key === r.data.key);
    if (run.status !== 'running') break;
    await sleep(200);
  }
  assert.equal(run.status, 'done');
  assert.equal(run.step, 5);
  assert.equal(run.result.verdict, 'rejected');
  assert.equal(run.result.scenarios.length, 3);
  assert.equal(run.result.defects.length, 1);
  assert.ok(run.log.every((l) => 'time' in l && 'level' in l && 'text' in l && 'step' in l));
  assert.ok(run.stepTimes && run.stepTimes.card?.startedAt && run.stepTimes.report?.finishedAt);
  const verdict = run.log.find((l) => l.key === 'verdict');
  assert.deepEqual(verdict.params, { verdict: 'rejected', pass: 2, fail: 1, warn: 0, blocked: 0, defects: 1 });
  assert.match(verdict.text, /^Veredito: reprovado/);
  assert.ok(['card.reading', 'card.read', 'pr.searching', 'pr.chosen', 'agent.simulate', 'sim.tc', 'nothingWritten'].every((k) => run.log.some((l) => l.key === k)));
  assert.ok(run.finishedAt);
  const saved = join(DIR, '123456', 'run.json');
  assert.ok(existsSync(saved));
  assert.equal(JSON.parse(readFileSync(saved, 'utf8')).result.verdict, 'rejected');
});

test('history brings the marks of each screenshot', async () => {
  const seeded = (await runs()).find((r) => r.id === 777777);
  assert.deepEqual(seeded.shots.map((s) => [s.name, s.marks]), [['S1-01-marked', [{ n: 1, note: 'Aqui' }]], ['S1-02-plain', undefined]]);
});

test('rejects an invalid PR choice', async () => {
  assert.equal((await post('/api/runs/9999/choose', { number: 1 })).status, 400);
});

test('reloads saved runs from disk via /api/reload', async () => {
  const dir = join(DIR, '888888');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ id: 888888, status: 'done', title: 'External agent run', step: 5, log: [], finishedAt: '2026-01-02T00:00:00Z', result: { verdict: 'approved', scenarios: [], defects: [] } }));
  const res = await post('/api/reload', {});
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.ok((await runs()).some((r) => r.id === 888888));
});

test('deletes a finished run from memory and disk', async () => {
  const target = (await runs()).find((r) => r.id === 888888);
  assert.ok(target);
  const del = await fetch(`${BASE}/api/runs/${target.key}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.equal(body.ok, true);
  assert.equal((await runs()).some((r) => r.id === 888888), false);
  assert.equal(existsSync(join(DIR, '888888')), false);
  const again = await fetch(`${BASE}/api/runs/${target.key}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});

test('refuses requests that do not come from the local page', async () => {
  const raw = (headers, method = 'POST') => fetch(BASE + '/api/reload', { method, headers, body: method === 'POST' ? '{}' : undefined }).then((r) => r.status);
  assert.equal(await raw({ 'Content-Type': 'application/json' }), 200);
  assert.equal(await raw({ 'Content-Type': 'text/plain' }), 403);
  assert.equal(await raw({ 'Content-Type': 'application/json', Origin: 'https://evil.example.com' }), 403);
  assert.equal(await raw({ 'Content-Type': 'application/json', Origin: BASE }), 200);
  const { request } = await import('node:http');
  const status = await new Promise((done) => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '/api/config', headers: { Host: 'evil.example.com' } }, (res) => { res.resume(); done(res.statusCode); });
    req.end();
  });
  assert.equal(status, 403);
});

test('waits for the screen to be prepared before testing, then continues', async () => {
  const r = await post('/api/runs', { link: '654321', prepare: true });
  assert.equal(r.status, 201);
  let run;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    run = (await runs()).find((x) => x.id === 654321);
    if (run?.prepare?.state === 'open') break;
  }
  assert.equal(run.prepare.state, 'open');
  assert.equal(run.status, 'running');
  await sleep(1500);
  assert.equal((await runs()).find((x) => x.id === 654321).status, 'running', 'still waiting for the user');
  assert.equal((await post(`/api/runs/${run.key}/continue`, {})).status, 200);
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    run = (await runs()).find((x) => x.id === 654321);
    if (run.status === 'done') break;
  }
  assert.equal(run.status, 'done');
  assert.equal(run.prepare.state, 'done');
  assert.equal((await post(`/api/runs/${run.key}/continue`, {})).status, 409);
});
