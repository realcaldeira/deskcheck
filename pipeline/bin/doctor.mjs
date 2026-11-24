#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAgents } from '../server/agents.mjs';
import { CONFIG, CONFIG_FILE, configProblems } from '../server/config.mjs';
import { chromeCandidates } from '../harness/deskcheck/lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOS = CONFIG.reposDir;
const DC_ROOT = process.env.DESKCHECK_ROOT || join(ROOT, '.deskcheck');
const DC = join(ROOT, 'harness', 'bin', 'deskcheck');
const GH_USER = CONFIG.github.user;
const PORT = Number(process.env.PORT || 4310);
const MFE_REPOS = CONFIG.repos.map((r) => r.name);
const ENVS = Object.values(CONFIG.envs).map((e) => [e.label, e.base]);
const quick = process.argv.includes('--quick');
const tty = process.stdout.isTTY;
const paint = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const ICON = { ok: paint(32, '✔'), warn: paint(33, '!'), bad: paint(31, '✖') };

const sh = (cmd, args, timeoutMs = 20_000) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { cwd: ROOT });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); done({ code: 1, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, out, err }); });
  });

const reach = async (url) => {
  const r = await sh('curl', ['-s', '-o', '/dev/null', '-m', '8', '-w', '%{http_code}', url], 12_000);
  const status = Number(r.out.trim());
  return status ? { ok: true, status } : { ok: false, reason: 'sem resposta' };
};

const checks = [];
const add = (level, name, detail, fix) => checks.push({ level, name, detail, fix });

const major = Number(process.versions.node.split('.')[0]);
add(major >= 22 ? 'ok' : 'bad', 'Node', `v${process.versions.node}`, 'instale o Node 22 ou mais novo');

const problems = configProblems();
add(problems.length ? 'bad' : 'ok', 'Configuração', problems.length ? problems.join('; ') : CONFIG_FILE, 'cp pipeline.config.example.json pipeline.config.json e preencha');

for (const repo of MFE_REPOS) {
  const ok = existsSync(join(REPOS, repo, '.git'));
  add(ok ? 'ok' : 'warn', `Repositório ${repo.replace(CONFIG.repoPrefix, '')}`, ok ? join(REPOS, repo) : 'ainda não clonado', `será clonado sozinho em ${REPOS} no primeiro desk check`);
}

const chrome = chromeCandidates().find((p) => existsSync(p));
add(chrome ? 'ok' : 'bad', 'Chrome', chrome || 'não encontrado', 'instale o Google Chrome');

let gh = GH_USER ? await sh('gh', ['auth', 'token', '--user', GH_USER]) : { code: 1, out: '' };
const preferred = gh.code === 0 && gh.out.trim();
if (!preferred) gh = await sh('gh', ['auth', 'token']);
const ghOk = gh.code === 0 && gh.out.trim();
add(ghOk ? 'ok' : 'bad', 'GitHub', ghOk ? (preferred ? `conta ${GH_USER} logada` : 'usando a conta ativa do gh') : 'sem login', 'instale o gh e rode: gh auth login');

const agents = listAgents(process.env.PATH);
const ready = agents.filter((a) => a.available).map((a) => a.id);
add(ready.length ? 'ok' : 'bad', 'Agentes', ready.length ? ready.join(', ') : 'nenhum instalado', agents[0]?.install);

let vpn = true;
for (const [label, url] of ENVS) {
  const r = await reach(url);
  if (!r.ok) vpn = false;
  add(r.ok ? 'ok' : 'bad', `Ambiente ${label}`, r.ok ? `responde (HTTP ${r.status})` : `inacessível (${r.reason})`, 'conecte a VPN');
}

const server = await reach(`http://localhost:${PORT}/api/config`);
add(server.ok ? 'ok' : 'warn', 'Esteira', server.ok ? `no ar em http://localhost:${PORT}` : 'parada', 'yarn dev');

if (quick) add('warn', 'Azure DevOps', 'não conferido (--quick)', 'rode sem --quick');
else {
  const who = await sh(DC, ['whoami'], 90_000);
  add(who.code === 0 ? 'ok' : 'bad', 'Azure DevOps', who.code === 0 ? who.out.trim() : (who.err.trim().split('\n').pop() || 'sem sessão'), `${DC} login`);
}

const pending = [];
for (const d of existsSync(DC_ROOT) ? readdirSync(DC_ROOT, { withFileTypes: true }) : []) {
  const f = join(DC_ROOT, d.name, 'user-original.json');
  if (!d.isDirectory() || !existsSync(f)) continue;
  try { if (!JSON.parse(readFileSync(f, 'utf8')).restored) pending.push(d.name); } catch { pending.push(d.name); }
}
add(pending.length ? 'bad' : 'ok', 'Papéis do usuário', pending.length ? `restauração pendente em ${pending.join(', ')}` : 'nenhuma troca pendente', pending.length ? `${DC} role restore ${pending[0]} --root ${DC_ROOT}` : '');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ready: !checks.some((c) => c.level === 'bad'), vpn, checks }));
  process.exit(0);
}
const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) console.log(`${ICON[c.level]} ${c.name.padEnd(width)}  ${c.detail}${c.level !== 'ok' && c.fix ? paint(2, `  → ${c.fix}`) : ''}`);
const bad = checks.filter((c) => c.level === 'bad').length;
console.log(bad ? `\n${paint(31, `${bad} item(ns) impedem o desk check.`)}${vpn ? '' : ' Sem VPN, os ambientes não respondem.'}` : `\n${paint(32, 'Tudo pronto: pode pedir o desk check.')}`);
process.exitCode = bad ? 1 : 0;
