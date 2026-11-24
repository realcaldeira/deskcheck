#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);
const PORT = Number(opt('--port') || process.env.PORT || 4310);
const BASE = `http://localhost:${PORT}`;
const color = process.stdout.isTTY ? { ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' } : { ok: '', warn: '', bad: '', dim: '', b: '', x: '' };
const STATUS_LABEL = { pass: 'OK', fail: 'Falhou', warn: 'Ressalva', blocked: 'Bloqueado' };
const VERDICT_LABEL = { approved: 'aprovado', 'approved-with-notes': 'aprovado com ressalvas', rejected: 'reprovado', incomplete: 'incompleto' };
const VERDICT_COLOR = { approved: color.ok, 'approved-with-notes': color.warn, rejected: color.bad, incomplete: color.warn };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: r.status, data: await r.json() };
}
const isUp = () => api('/api/config').then(() => true, () => false);

async function ensureServer() {
  if (await isUp()) return;
  const logFile = join(tmpdir(), 'deskcheck-pipeline.log');
  mkdirSync(dirname(logFile), { recursive: true });
  const args = [join(ROOT, 'server', 'index.mjs'), ...(has('--simulate') ? ['--simulate'] : [])];
  spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', openSync(logFile, 'a'), openSync(logFile, 'a')], env: { ...process.env, PORT: String(PORT) } }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await isUp()) { console.log(`${color.dim}Esteira no ar em ${BASE} (log: ${logFile})${color.x}`); return; }
  }
  throw new Error(`A esteira não subiu. Veja ${logFile}.`);
}

async function follow(onRuns) {
  const r = await fetch(BASE + '/api/events');
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      if (ev.startsWith('data: ') && onRuns(JSON.parse(ev.slice(6)))) return;
    }
  }
}

function printSummary(run) {
  const res = run.result || {};
  const scenarios = res.scenarios || [];
  const count = (s) => scenarios.filter((x) => x.status === s).length;
  console.log(`\n${color.b}${run.type} ${run.id} · ${run.title}${color.x}`);
  if (run.status !== 'done') { console.log(`${color.warn}Status: ${run.status}${color.x} · ${run.log.at(-1)?.text || ''}`); return; }
  console.log(`${VERDICT_COLOR[res.verdict] || ''}${color.b}Veredito: ${VERDICT_LABEL[res.verdict] || res.verdict}${color.x} · ${count('pass')} ok · ${count('fail')} falhas · ${count('warn')} ressalvas · ${count('blocked')} bloqueados`);
  if (res.summary) console.log(res.summary);
  console.log('');
  for (const s of scenarios) console.log(`  ${s.id.padEnd(4)} TC ${String(s.tc || '—').padEnd(7)} ${(STATUS_LABEL[s.status] || s.status).padEnd(10)} ${s.notes || ''}`);
  for (const x of res.notTested || []) console.log(`  ${color.dim}Não testado ${x.ref}: ${x.reason}${color.x}`);
  if ((res.acWithoutTc || []).length) console.log(`  ${color.dim}Critérios sem TC: ${res.acWithoutTc.join('; ')}${color.x}`);
  const defects = res.defects || [];
  console.log(`\n${color.b}Defeitos apontados (${defects.length})${color.x}`);
  for (const d of defects) console.log(`  - ${d.title} (${d.scenario}${d.tc ? ', TC ' + d.tc : ''})\n    Expected: ${d.expected}\n    Actual: ${d.actual}`);
  console.log(`\nRelatório com prints: ${BASE}/report/${run.id}/report.html`);
  console.log(`${color.ok}Nada foi gravado no Azure nem no GitHub.${color.x}`);
}

async function main() {
  if (has('--help') || has('-h') || !argv.length) {
    console.log('Uso: yarn pipeline <link ou número do card> [--agent <id>] [--data real|mock] [--env dev|stg] [--pr N] [--simulate] [--port N]\n     yarn pipeline --agents | --list');
    return;
  }
  await ensureServer();
  if (has('--agents')) {
    const { data } = await api('/api/agents');
    for (const a of data) console.log(`${a.available ? color.ok + '●' : color.dim + '○'} ${a.id.padEnd(9)} ${a.name}${color.x}${a.available ? '' : color.dim + '  (instalar: ' + a.install + ')' + color.x}`);
    return;
  }
  if (has('--list')) {
    await follow((runs) => {
      for (const r of runs) console.log(`${String(r.id).padEnd(7)} ${r.status.padEnd(8)} ${(VERDICT_LABEL[r.result?.verdict] || '').padEnd(24)} ${r.agent || ''}  ${r.title}`);
      return true;
    });
    return;
  }
  const target = argv.find((a) => /\d{5,7}/.test(a));
  if (!target) throw new Error('Passe o link ou o número do card.');
  const dataMode = opt('--data') === 'mock' ? 'mock' : 'real';
  const env = opt('--env') === 'stg' ? 'stg' : 'dev';
  const { status, data } = await api('/api/runs', { link: target, agent: opt('--agent'), dataMode, env });
  if (status >= 400) throw new Error(data.error);
  console.log(`${color.dim}Desk check do card ${data.id} com ${data.agent}. Acompanhe também em ${BASE}${color.x}`);
  let seen = 0, chosen = false;
  await follow((runs) => {
    const run = runs.find((r) => r.key === data.key);
    if (!run) return false;
    for (const l of run.log.slice(seen)) console.log(`${color.dim}${l.time}${color.x} ${color[l.level] || ''}${l.text}${color.x}`);
    seen = run.log.length;
    if (run.status === 'waiting' && !chosen) {
      const wanted = Number(opt('--pr'));
      const pr = run.prs.find((x) => x.number === wanted);
      if (!pr) {
        console.log(`\nMais de um PR. Rode de novo com --pr <número>, ou escolha em ${BASE}:`);
        for (const x of run.prs) console.log(`  #${x.number} ${x.repo} ${x.branch} (${x.author}) ${x.title}`);
        return true;
      }
      chosen = true; api(`/api/runs/${run.key}/choose`, { number: pr.number, repo: pr.repo });
    }
    if (['done', 'blocked', 'error'].includes(run.status)) { printSummary(run); process.exitCode = run.status === 'done' ? 0 : 2; return true; }
    return false;
  });
}

main().catch((e) => { console.error(`${color.bad}${e.message}${color.x}`); process.exitCode = 1; });
