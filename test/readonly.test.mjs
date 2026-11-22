import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromeCandidates, isLocalUrl, isReadRequest } from '../src/cdp.mjs';
import { needsReadonly, runPlan } from '../src/runner.mjs';

const hasChrome = chromeCandidates().some((p) => existsSync(p));

test('regras do modo somente leitura', () => {
  assert.equal(isReadRequest('GET', 'https://app.example.com/api/x'), true);
  assert.equal(isReadRequest('OPTIONS', 'https://app.example.com/api/x'), true);
  assert.equal(isReadRequest('POST', 'https://app.example.com/api/x'), false);
  assert.equal(isReadRequest('DELETE', 'https://app.example.com/api/x'), false);
  assert.equal(isReadRequest('POST', 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token'), true);
  assert.equal(isReadRequest('POST', 'https://device.login.microsoftonline.com/'), true);
  assert.equal(isReadRequest('POST', 'https://login.microsoftonline.com.evil.com/x'), false);

  const idp = { resourceType: 'Document', headers: { Origin: 'https://login.microsoftonline.com' }, postData: 'SAMLResponse=PHNhbWw%3D&RelayState=x' };
  assert.equal(isReadRequest('POST', 'https://app.example.com/saml/acs', idp), true);
  assert.equal(isReadRequest('POST', 'https://app.example.com/saml/acs', { ...idp, headers: { Origin: 'https://app.example.com' } }), false);
  assert.equal(isReadRequest('POST', 'https://app.example.com/api/save', { ...idp, resourceType: 'Fetch' }), false);
  assert.equal(isReadRequest('POST', 'https://app.example.com/api/save', { ...idp, postData: '{"status":"approve"}' }), false);

  assert.equal(isReadRequest('POST', 'https://auth.example.com/realms/corp/broker/saml/endpoint'), true);
  assert.equal(isReadRequest('POST', 'https://auth.example.com/realms/corp/login-actions/authenticate?x=1'), true);
  assert.equal(isReadRequest('POST', 'https://auth.example.com/shot-sensor'), false);
  assert.equal(isReadRequest('POST', 'https://app.example.com/realms/corp/broker/x'), false);

  const kcIdp = { resourceType: 'Document', headers: { Origin: 'https://auth.example.com' }, postData: 'SAMLResponse=PHNhbWw%3D&RelayState=x' };
  assert.equal(isReadRequest('POST', 'https://app.example.com/saml/acs', kcIdp), true);
  assert.equal(isReadRequest('POST', 'https://app.example.com/api/save', { ...kcIdp, resourceType: 'Fetch' }), false);
  assert.equal(isReadRequest('POST', 'https://app.example.com/api/save', { ...kcIdp, postData: '{"status":"approve"}' }), false);
  assert.equal(isLocalUrl('http://localhost:3000/x'), true);
  assert.equal(isLocalUrl('file:///tmp/a.html'), true);
  assert.equal(isLocalUrl('https://app.example.com/dashboard'), false);
  const plan = { scenarios: [{ id: 'S1', title: 't', steps: [{ do: 'goto', url: '/a' }] }] };
  assert.equal(needsReadonly(plan, 'https://app.example.com/dashboard'), true);
  assert.equal(needsReadonly(plan, 'http://localhost:3000'), false);
  assert.equal(needsReadonly({ scenarios: [{ id: 'S1', title: 't', steps: [{ do: 'goto', url: 'https://prd.example.com' }] }] }, 'http://localhost:3000'), true);
});

test('somente leitura: o POST da tela nunca chega ao servidor', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, async () => {
  const seen = [];
  const page = `<!doctype html><button id="save">Save</button><p id="out">idle</p>
<script>document.getElementById('save').onclick = async () => {
  try { const r = await fetch('/api/save', { method: 'POST', body: '{"x":1}' }); document.getElementById('out').textContent = 'saved ' + r.status; }
  catch (e) { document.getElementById('out').textContent = 'blocked'; }
};</script>`;
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/') return res.end(page);
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-ro-'));
  try {
    const plan = { scenarios: [{ id: 'S1', title: 'Clicar em Save', steps: [{ do: 'click', role: 'button', name: 'Save' }, { do: 'expectText', text: 'blocked' }] }] };
    const r = await runPlan(plan, { baseUrl: base, outDir: out, profileDir: path.join(out, 'chrome'), readonly: true });
    assert.equal(r.readonly, true);
    assert.equal(r.scenarios[0].status, 'pass');
    assert.deepEqual(r.scenarios[0].blockedRequests.map((b) => b.method), ['POST']);
    assert.ok(!seen.some((s) => s.startsWith('POST')), `servidor recebeu: ${seen.join(', ')}`);
    assert.ok(seen.includes('GET /'));
  } finally {
    server.close();
  }
});

test('janela de login em PRD: escritas barradas em todas as abas', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, async () => {
  const { guardBrowser, withChrome, sleep } = await import('../src/cdp.mjs');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/') return res.end(`<!doctype html><script>fetch('/api/track', { method: 'POST' }).catch(() => {});</script>`);
    if (req.url === '/popup') return res.end(`<!doctype html><script>fetch('/api/popup-save', { method: 'PUT' }).catch(() => {});</script>`);
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-guard-'));
  try {
    await withChrome({ profileDir: path.join(out, 'chrome') }, async (cdp) => {
      const blocked = await guardBrowser(cdp);
      const { targetId } = await cdp.send('Target.createTarget', { url: base });
      const second = await cdp.send('Target.createTarget', { url: `${base}popup` });
      for (let i = 0; i < 40 && blocked.length < 2; i++) await sleep(150);
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
      await cdp.send('Target.closeTarget', { targetId: second.targetId }).catch(() => undefined);
      assert.deepEqual(blocked.map((b) => b.method).sort(), ['POST', 'PUT'], `seen: ${seen.join(', ')}`);
    });
    assert.ok(!seen.some((s) => /^(POST|PUT)/.test(s)), `servidor recebeu: ${seen.join(', ')}`);
    assert.ok(seen.includes('GET /') && seen.includes('GET /popup'));
  } finally {
    server.close();
  }
});

test('somente leitura no run: POST de iframe de outro site também é barrado', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.headers.host} ${req.url}`);
    const port = server.address().port;
    if (req.url === '/') return res.end(`<!doctype html><p>main</p><iframe src="http://localhost:${port}/frame"></iframe>`);
    if (req.url === '/frame') return res.end(`<!doctype html><script>fetch('/api/frame-save', { method: 'POST', body: 'x' }).then(() => document.body.append('sent'), () => document.body.append('blocked'));</script>`);
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-ro-frame-'));
  try {
    const plan = { scenarios: [{ id: 'S1', title: 'iframe', steps: [{ do: 'wait', ms: 1500 }] }] };
    const r = await runPlan(plan, { baseUrl: base, outDir: out, profileDir: path.join(out, 'chrome'), readonly: true });
    assert.ok(seen.some((s) => s.includes('/frame')), `iframe não carregou: ${seen.join(', ')}`);
    assert.ok(!seen.some((s) => s.startsWith('POST')), `servidor recebeu: ${seen.join(', ')}`);
    assert.deepEqual(r.scenarios[0].blockedRequests.map((b) => b.method), ['POST']);
  } finally {
    server.close();
  }
});
