import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROFILE, DeskcheckError, isWriteAllowedUrl, openPage, sleep, withChrome } from './cdp.mjs';

export const ROLE_FILE = 'user-original.json';
const ZONE_ROLE = () => process.env.DESKCHECK_ZONE_ROLE || '';
const USERS_PATH = /\/users(\/|\?|$)/;

const emailOf = (claims) => [claims.email, claims.preferred_username, claims.upn, claims.unique_name].map((v) => String(v || '').trim().toLowerCase()).find((v) => /^[^@\s]+@[^@\s]+$/.test(v)) || '';

export function jwtClaims(auth) {
  try {
    const token = String(auth || '').replace(/^Bearer\s+/i, '').trim();
    const payload = token.split('.')[1];
    if (!payload) return {};
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {};
  } catch {
    return {};
  }
}

const ids = (list) => (Array.isArray(list) ? list.map((x) => (x && typeof x === 'object' ? x.id : x)).filter(Boolean).map(String).sort() : []);

export function snapshotOf(user) {
  return {
    roles: [...(user.roles || [])].map(String).sort(),
    roleTitleId: String(user.roleTitle?.id || user.roleTitleId || ''),
    marketIds: ids(user.markets || user.marketIds),
    brandIds: ids(user.brands || user.brandIds),
    zoneIds: ids(user.zones || user.zoneIds),
    active: user.active !== false,
  };
}

export function sameSnapshot(a, b) {
  const norm = (s) => JSON.stringify({ ...s, zoneIds: !ZONE_ROLE() || s.roles.includes(ZONE_ROLE()) ? s.zoneIds : [] });
  return norm(a) === norm(b);
}

export function patchBody(snapshot) {
  const body = { roles: snapshot.roles, active: snapshot.active, marketIds: snapshot.marketIds, brandIds: snapshot.brandIds };
  if (snapshot.roleTitleId) body.roleTitleId = snapshot.roleTitleId;
  if (ZONE_ROLE() ? snapshot.roles.includes(ZONE_ROLE()) : snapshot.zoneIds.length) body.zoneIds = snapshot.zoneIds;
  return body;
}

export function createUsersApi({ apiBase, auth, fetchImpl = fetch }) {
  const base = String(apiBase).replace(/\/+$/, '');
  const call = async (method, url, body) => {
    if (method !== 'GET' && !isWriteAllowedUrl(url)) {
      throw new DeskcheckError(`troca de papel recusada: ${new URL(url).host} não é localhost nem host de teste (dev, stg, uat...).`);
    }
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new DeskcheckError(`${method} ${url} respondeu ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    base,
    async findByEmail(email) {
      const data = await call('GET', `${base}/users?search=${encodeURIComponent(email)}&page=1&pageSize=10`);
      return (data.items || []).find((u) => String(u.email || '').toLowerCase() === String(email).toLowerCase()) || null;
    },
    patch: (id, body) => call('PATCH', `${base}/users/${encodeURIComponent(id)}`, body),
  };
}

export async function withRoleSession(url, { profileDir = DEFAULT_PROFILE, timeoutMs = 240_000, headless = false, log = () => {} } = {}, fn) {
  if (!isWriteAllowedUrl(url)) throw new DeskcheckError(`troca de papel só em localhost ou ambiente de teste (dev, stg, uat...). Recusado: ${url}`);
  return withChrome({ profileDir, headless }, async (cdp) => {
    const page = await openPage(cdp, { readonly: false });
    const seen = new Map();
    cdp.on((msg) => {
      if (msg.method !== 'Network.requestWillBeSent') return;
      const req = msg.params?.request;
      const auth = req?.headers?.Authorization || req?.headers?.authorization;
      if (!auth || !/^Bearer\s+\S+/i.test(auth)) return;
      const u = new URL(req.url);
      if (!USERS_PATH.test(u.pathname)) return;
      seen.set(`${u.origin}${u.pathname.slice(0, u.pathname.search(USERS_PATH))}`, auth);
    });
    log(`Abrindo ${url} (se pedir login, faça na janela do Chrome)...\n`);
    await page.navigate(url).catch(() => undefined);
    const fetchImpl = async (target, init) => {
      const r = await page.evaluate(`fetch(${JSON.stringify(target)}, ${JSON.stringify(init)}).then(async (r) => ({ ok: r.ok, status: r.status, text: await r.text() }), (e) => ({ ok: false, status: 0, text: String(e && e.message || e) }))`);
      return { ok: r.ok, status: r.status, text: async () => r.text };
    };
    const tried = new Set();
    const until = Date.now() + timeoutMs;
    let session = null;
    let lastError = '';
    while (!session && Date.now() < until) {
      for (const [apiBase, auth] of seen) {
        if (tried.has(apiBase)) continue;
        tried.add(apiBase);
        const email = emailOf(jwtClaims(auth));
        if (!email) { lastError = 'o token da sessão não traz o e-mail do usuário logado.'; continue; }
        try {
          if (await createUsersApi({ apiBase, auth, fetchImpl }).findByEmail(email)) { session = { apiBase, auth, email }; break; }
          lastError = `o usuário logado (${email}) não está cadastrado nessa tela de usuários.`;
        } catch (e) {
          lastError = String(e.message || e);
        }
      }
      if (!session) await sleep(500);
    }
    if (!session) throw new DeskcheckError(lastError || `não vi a tela de usuários chamar a API em ${Math.round(timeoutMs / 1000)} s (login pendente, VPN desligada ou sem permissão de admin?).`);
    return fn({ session, fetchImpl });
  });
}

const fileOf = (dir) => path.join(dir, ROLE_FILE);
export function readBackup(dir) {
  const file = fileOf(dir);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data?.id || !data?.email || !Array.isArray(data?.original?.roles)) throw new Error('faltam id, email ou original.roles');
    return data;
  } catch (e) {
    const copy = `${file}.bak`;
    const hint = existsSync(copy) ? ` Há uma cópia íntegra em ${copy}: confira e renomeie para ${ROLE_FILE}.` : '';
    throw new DeskcheckError(`${file} está corrompido (${e.message}).${hint} Não apague: é o registro do papel original.`);
  }
}
const writeBackup = (dir, data) => {
  mkdirSync(dir, { recursive: true });
  const file = fileOf(dir);
  const body = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(`${file}.tmp`, body);
  renameSync(`${file}.tmp`, file);
  writeFileSync(`${file}.bak`, body);
};

async function ownUser(session, fetchImpl) {
  const api = createUsersApi({ ...session, fetchImpl });
  const user = await api.findByEmail(session.email);
  if (!user) throw new DeskcheckError(`o usuário logado (${session.email}) não está cadastrado nessa tela de usuários.`);
  return { api, user };
}

export async function backupRole({ dir, url, session, fetchImpl }) {
  const current = readBackup(dir);
  if (current && !current.restored) return { backup: current, created: false };
  const { user } = await ownUser(session, fetchImpl);
  const backup = { url, apiBase: session.apiBase, email: session.email, id: String(user.id), savedAt: new Date().toISOString(), original: snapshotOf(user), restored: false, history: [] };
  writeBackup(dir, backup);
  return { backup, created: true };
}

function assertOwn(backup, session, user) {
  if (backup.email !== session.email || String(user.id) !== backup.id) {
    throw new DeskcheckError(`o backup é de ${backup.email} e a sessão é de ${session.email}: só o próprio usuário pode ser alterado.`);
  }
  if (backup.apiBase !== session.apiBase) throw new DeskcheckError(`o backup é de ${backup.apiBase} e a sessão aponta para ${session.apiBase}.`);
}

async function applySnapshot({ api, session, backup, target }) {
  await api.patch(backup.id, patchBody(target));
  const after = await api.findByEmail(session.email);
  if (!after) throw new DeskcheckError('não encontrei o usuário depois da troca: confira a tela de usuários.');
  const got = snapshotOf(after);
  if (!sameSnapshot(got, target)) throw new DeskcheckError(`a API não aplicou a troca. Esperado ${JSON.stringify(target.roles)}, ficou ${JSON.stringify(got.roles)}.`);
  return got;
}

export async function setRole({ dir, url, session, roles, roleTitleId, fetchImpl }) {
  if (!roles?.length) throw new DeskcheckError('informe --roles a,b');
  const { backup } = await backupRole({ dir, url, session, fetchImpl });
  const { api, user } = await ownUser(session, fetchImpl);
  assertOwn(backup, session, user);
  const target = { ...snapshotOf(user), roles: [...roles].map(String).sort(), ...(roleTitleId ? { roleTitleId: String(roleTitleId) } : {}) };
  const got = await applySnapshot({ api, session, backup, target });
  backup.history.push({ at: new Date().toISOString(), roles: got.roles });
  backup.restored = false;
  writeBackup(dir, backup);
  return { backup, now: got };
}

export async function restoreRole({ dir, session, fetchImpl }) {
  const backup = readBackup(dir);
  if (!backup) throw new DeskcheckError(`sem ${ROLE_FILE} em ${dir}: nada para restaurar.`);
  if (backup.restored) return { backup, already: true };
  const { api, user } = await ownUser(session, fetchImpl);
  assertOwn(backup, session, user);
  const got = sameSnapshot(snapshotOf(user), backup.original) ? snapshotOf(user) : await applySnapshot({ api, session, backup, target: backup.original });
  backup.restored = true;
  backup.restoredAt = new Date().toISOString();
  writeBackup(dir, backup);
  return { backup, now: got, already: false };
}

export function roleStatus(dir) {
  const b = readBackup(dir);
  if (!b) return { state: 'none', text: 'nenhuma troca de papel registrada.' };
  if (b.restored) return { state: 'restored', text: `papel original restaurado em ${b.restoredAt}: ${b.original.roles.join(', ')}` };
  return { state: 'pending', text: `RESTAURAÇÃO PENDENTE: original ${b.original.roles.join(', ')}${b.history.length ? ` · atual ${b.history.at(-1).roles.join(', ')}` : ''} (${b.url})` };
}
