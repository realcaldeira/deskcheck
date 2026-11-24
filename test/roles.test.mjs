import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromeCandidates } from '../src/cdp.mjs';
import { backupRole, createUsersApi, jwtClaims, patchBody, readBackup, restoreRole, roleStatus, sameSnapshot, setRole, snapshotOf, withRoleSession } from '../src/roles.mjs';

const hasChrome = chromeCandidates().some((p) => existsSync(p));
const jwt = (claims) => `Bearer x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

function fakeBackend() {
  const users = [
    { id: 'u1', email: 'me@example.com', firstName: 'Me', lastName: 'X', active: true, roles: ['reviewer'], roleTitle: { id: 't1', name: 'Legal' }, markets: [{ id: 'm1', name: 'BR' }], brands: [{ id: 'b1', name: 'Brand' }], zones: [], isGlobal: false },
    { id: 'u2', email: 'other@example.com', firstName: 'O', lastName: 'Y', active: true, roles: ['author'], roleTitle: { id: 't1', name: 'Legal' }, markets: [], brands: [], zones: [], isGlobal: false },
  ];
  const patches = [];
  const page = `<!doctype html><h1>Users</h1><script>const auth = { headers: { Authorization: ${JSON.stringify(jwt({ preferred_username: 'Me@Example.com' }))} } }; fetch('/stats/users', auth); fetch('/v1/users?page=1&pageSize=50', auth);</script>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/admin/users') return res.end(page);
    if (!/^Bearer /.test(req.headers.authorization || '')) { res.statusCode = 401; return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && u.pathname === '/v1/users') {
      const q = (u.searchParams.get('search') || '').toLowerCase();
      return res.end(JSON.stringify({ items: users.filter((x) => x.email.includes(q)), total: users.length, page: 1, pageSize: 10 }));
    }
    const m = u.pathname.match(/^\/v1\/users\/([^/]+)$/);
    if (req.method === 'PATCH' && m) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const dto = JSON.parse(body);
        const user = users.find((x) => x.id === m[1]);
        patches.push({ id: m[1], dto });
        if (dto.roles) user.roles = dto.roles;
        if (dto.active !== undefined) user.active = dto.active;
        res.end(JSON.stringify({ id: user.id }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return { server, users, patches };
}

test('papéis: claims do token, snapshot e corpo do PATCH', () => {
  assert.equal(jwtClaims(jwt({ email: 'a@b.c' })).email, 'a@b.c');
  assert.deepEqual(jwtClaims('lixo'), {});
  const snap = snapshotOf({ roles: ['b', 'a'], roleTitle: { id: 't1' }, markets: [{ id: 'm2' }, { id: 'm1' }], brands: [], zones: [{ id: 'z1' }], active: true });
  assert.deepEqual(snap, { roles: ['a', 'b'], roleTitleId: 't1', marketIds: ['m1', 'm2'], brandIds: [], zoneIds: ['z1'], active: true });
  assert.deepEqual(patchBody(snap).zoneIds, ['z1']);
  assert.equal('zoneIds' in patchBody({ ...snap, zoneIds: [] }), false);
  process.env.DESKCHECK_ZONE_ROLE = 'regionlead';
  try {
    assert.equal('zoneIds' in patchBody(snap), false);
    assert.deepEqual(patchBody({ ...snap, roles: ['regionlead'] }).zoneIds, ['z1']);
    assert.equal(sameSnapshot(snap, { ...snap, zoneIds: [] }), true);
  } finally {
    delete process.env.DESKCHECK_ZONE_ROLE;
  }
  assert.equal(sameSnapshot(snap, { ...snap, roles: ['a'] }), false);
});

test('papéis: escrita em host fora de teste é recusada antes de sair', async () => {
  let called = 0;
  const api = createUsersApi({ apiBase: 'https://api.app.example.com/v1', auth: jwt({ email: 'a@b.c' }), fetchImpl: async () => { called++; return { ok: true, status: 200, text: async () => '{}' }; } });
  await assert.rejects(() => api.patch('u1', { roles: ['x'] }), /não é localhost nem host de teste/);
  assert.equal(called, 0);
  await assert.rejects(() => withRoleSession('https://app.example.com/admin/users', {}, () => {}), /Recusado/);
});

test('papéis no Chrome: backup, troca, restauração conferida e só o próprio usuário', { skip: !hasChrome && 'sem Chrome', timeout: 90_000 }, async () => {
  const { server, users, patches } = fakeBackend();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/admin/users`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-role-'));
  const opts = { profileDir: path.join(dir, 'chrome'), headless: true, timeoutMs: 30_000 };
  try {
    assert.equal(roleStatus(dir).state, 'none');
    const set = await withRoleSession(url, opts, ({ session, fetchImpl }) => {
      assert.equal(session.email, 'me@example.com');
      assert.match(session.apiBase, /\/v1$/);
      return setRole({ dir, url, session, fetchImpl, roles: ['editor'] });
    });
    assert.deepEqual(set.now.roles, ['editor']);
    assert.deepEqual(users[0].roles, ['editor']);
    assert.deepEqual(readBackup(dir).original.roles, ['reviewer']);
    assert.equal(roleStatus(dir).state, 'pending');

    await withRoleSession(url, opts, ({ session, fetchImpl }) => setRole({ dir, url, session, fetchImpl, roles: ['author'] }));
    assert.deepEqual(readBackup(dir).original.roles, ['reviewer'], 'o backup original nunca é sobrescrito');

    await assert.rejects(
      () => withRoleSession(url, opts, ({ session, fetchImpl }) => restoreRole({ dir, fetchImpl, session: { ...session, email: 'other@example.com' } })),
      /só o próprio usuário/,
    );

    const back = await withRoleSession(url, opts, ({ session, fetchImpl }) => restoreRole({ dir, session, fetchImpl }));
    assert.deepEqual(back.now.roles, ['reviewer']);
    assert.deepEqual(users[0].roles, ['reviewer']);
    assert.deepEqual(users[1].roles, ['author']);
    assert.ok(patches.every((p) => p.id === 'u1'), 'nenhum outro usuário foi alterado');
    assert.equal(roleStatus(dir).state, 'restored');
    const again = await withRoleSession(url, opts, ({ session, fetchImpl }) => restoreRole({ dir, session, fetchImpl }));
    assert.equal(again.already, true);
    const fresh = await withRoleSession(url, opts, ({ session, fetchImpl }) => backupRole({ dir, url, session, fetchImpl }));
    assert.equal(fresh.created, true);
  } finally {
    server.close();
  }
});

test('papéis: backup corrompido é recusado com aviso e a cópia íntegra é apontada', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-role-bad-'));
  assert.equal(readBackup(dir), null);
  writeFileSync(path.join(dir, 'user-original.json'), '{"id":"u1","email":"me@exam');
  assert.throws(() => readBackup(dir), /corrompido/);
  assert.throws(() => roleStatus(dir), /corrompido/);
  writeFileSync(path.join(dir, 'user-original.json.bak'), JSON.stringify({ id: 'u1', email: 'me@example.com', original: { roles: ['reviewer'] } }));
  assert.throws(() => readBackup(dir), /cópia íntegra/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'user-original.json.bak'), 'utf8')).id, 'u1');
});
