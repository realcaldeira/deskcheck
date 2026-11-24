#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workItemUrl } from '../server/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DC_ROOT = process.env.DESKCHECK_ROOT || join(ROOT, '.deskcheck');
const PORT = Number(process.env.PORT || 4310);
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const VERDICT_LABEL = { approved: 'aprovado', 'approved-with-notes': 'aprovado com ressalvas', rejected: 'reprovado', incomplete: 'incompleto' };

function sh(cmd, args) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => done({ code: 1, out }));
    child.on('close', (code) => done({ code, out }));
  });
}

async function main() {
  const raw = argv.find((a) => /\d{5,7}/.test(a));
  const m = raw && /(\d{5,7})/.exec(raw);
  const file = opt('--file');
  if (!m || !file || !existsSync(file)) {
    console.error('Uso: yarn save-run <id> --file <result.json> [--agent <id>]');
    process.exit(1);
  }
  const id = Number(m[1]);
  const agent = opt('--agent') || '';
  const dir = join(DC_ROOT, String(id));
  mkdirSync(dir, { recursive: true });
  const card = existsSync(join(dir, 'card.json')) ? JSON.parse(readFileSync(join(dir, 'card.json'), 'utf8')) : null;
  const prep = existsSync(join(dir, 'prep.json')) ? JSON.parse(readFileSync(join(dir, 'prep.json'), 'utf8')) : null;
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const now = new Date().toISOString();
  const startedAt = prep?.preparedAt || now;
  const stamp = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  let changedFiles;
  if (prep?.worktree && existsSync(prep.worktree)) {
    const st = await sh('git', ['-C', prep.worktree, 'status', '--porcelain']);
    const changed = st.out.split('\n').filter((l) => l.trim() && !/\.(deskcheck|local-harness)\//.test(l));
    if (changed.length) changedFiles = changed.map((l) => l.slice(3));
  }

  const scenarios = result.scenarios || [];
  const count = (s) => scenarios.filter((c) => c.status === s).length;
  const defects = (result.defects || []).length;
  const log = [
    { time: stamp, level: 'ok', kind: 'phase', step: 'card', key: 'card.read', params: { type: card?.type || '', state: card?.state || '', assignee: card?.assignedTo || '—', tcs: (card?.testCases || []).length, acs: (card?.acceptanceCriteria || []).length }, text: `Card lido: ${card?.type || ''}, ${card?.state || ''}, responsável ${card?.assignedTo || '—'}. ${(card?.testCases || []).length} Test Case(s) no Tested By, ${(card?.acceptanceCriteria || []).length} critério(s) de aceite.` },
  ];
  if (prep?.pr) {
    log.push({ time: stamp, level: 'ok', kind: 'phase', step: 'pr', key: 'pr.chosen', params: { number: prep.pr.number, repo: prep.pr.repo, branch: prep.pr.branch, author: prep.pr.author }, text: `PR escolhido: #${prep.pr.number} (${prep.pr.repo}), branch ${prep.pr.branch}, de ${prep.pr.author}.` });
  }
  if (prep?.commit) {
    log.push({ time: stamp, level: 'ok', kind: 'phase', step: 'screen', key: 'worktree.ready', params: { commit: prep.commit }, text: `Código do PR baixado numa worktree só de teste (${prep.commit}). Seu checkout não é tocado.` });
  }
  log.push(
    changedFiles
      ? { time: stamp, level: 'warn', kind: 'phase', step: 'scenarios', key: 'code.changed', params: { count: changedFiles.length, files: changedFiles.slice(0, 3).join(', ') }, text: `Atenção: ${changedFiles.length} arquivo(s) do código foram alterados durante o teste (${changedFiles.slice(0, 3).join(', ')}).` }
      : { time: stamp, level: 'ok', kind: 'phase', step: 'scenarios', key: 'code.untouched', params: {}, text: 'Conferido: nenhum arquivo do código do colega foi alterado.' },
    { time: stamp, level: count('fail') ? 'warn' : 'ok', kind: 'phase', step: 'report', key: 'verdict', params: { verdict: result.verdict, pass: count('pass'), fail: count('fail'), warn: count('warn'), blocked: count('blocked'), defects }, text: `Veredito: ${VERDICT_LABEL[result.verdict] || result.verdict}. ${count('pass')} ok · ${count('fail')} falhas · ${count('warn')} ressalvas · ${count('blocked')} bloqueados. ${defects} defeito(s) apontado(s).` },
    { time: stamp, level: 'ok', kind: 'phase', step: 'report', key: 'nothingWritten', params: {}, text: 'Nada foi gravado no Azure nem no GitHub.' },
  );

  const run = {
    id,
    link: card?.url || workItemUrl(id),
    type: card?.type || '',
    title: card?.title || `Card ${id}`,
    step: 5,
    stepTimes: { card: { startedAt, finishedAt: now }, pr: { startedAt, finishedAt: now }, screen: { startedAt, finishedAt: now }, scenarios: { startedAt, finishedAt: now }, report: { startedAt, finishedAt: now } },
    status: 'done',
    agent,
    startedAt,
    finishedAt: now,
    pr: prep?.pr,
    worktree: prep?.worktree,
    commit: prep?.commit,
    changedFiles,
    card: card && {
      type: card.type,
      title: card.title,
      state: card.state,
      assignedTo: card.assignedTo,
      parent: card.parent || null,
      testCases: (card.testCases || []).map((tc) => ({ id: tc.id, title: tc.title, state: tc.state, steps: tc.steps })),
      acceptanceCriteria: card.acceptanceCriteria || [],
      defects: card.defects || [],
      tasks: card.tasks || [],
      stories: card.stories || [],
    },
    result,
    log,
  };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 1));
  try { await fetch(`http://localhost:${PORT}/api/reload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
  console.log(`Desk check ${id} salvo em ${join(dir, 'run.json')} (http://localhost:${PORT})`);
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exitCode = 1;
});
