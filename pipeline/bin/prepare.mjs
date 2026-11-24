#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../server/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOS = CONFIG.reposDir;
const WORKTREES = join(REPOS, '.worktrees');
const GH_ORG = CONFIG.github.org;
const GH_USER = CONFIG.github.user;
const DC_ROOT = process.env.DESKCHECK_ROOT || join(ROOT, '.deskcheck');
const DC = join(ROOT, 'harness', 'bin', 'deskcheck');
const MFE_MAP = Object.fromEntries(CONFIG.repos.map((r) => [r.name, { mfe: r.app, port: r.port, kit: r.kit }]));
const MFE_REPOS = Object.keys(MFE_MAP);
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);

function sh(cmd, args, opts = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: process.env, ...opts });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ code: 1, out, err: String(e) }));
    child.on('close', (code) => done({ code, out, err }));
  });
}

async function githubEnv() {
  let t = GH_USER ? await sh('gh', ['auth', 'token', '--user', GH_USER]) : { code: 1, out: '' };
  if (t.code !== 0 || !t.out.trim()) t = await sh('gh', ['auth', 'token']);
  if (t.code !== 0 || !t.out.trim()) throw new Error('Sem login do GitHub nesta máquina. Rode: gh auth login.');
  return { ...process.env, GH_TOKEN: t.out.trim() };
}

async function findPrs(card, env) {
  const ids = [
    card.id,
    ...(card.parent ? [card.parent.id] : []),
    ...(card.tasks || []).map((t) => t.id),
    ...(card.stories || []).map((s) => s.id),
  ].map(String);
  const found = [];
  for (const repo of MFE_REPOS) {
    const r = await sh('gh', ['pr', 'list', '-R', `${GH_ORG}/${repo}`, '--state', 'all', '--limit', '200',
      '--json', 'number,title,headRefName,body,author,state,isDraft,updatedAt,url,isCrossRepository'], { env });
    if (r.code !== 0) continue;
    for (const pr of JSON.parse(r.out || '[]')) {
      const hay = `${pr.title} ${pr.headRefName} ${pr.body || ''}`;
      if (!pr.isCrossRepository && ids.some((id) => new RegExp(`(^|\\D)${id}(\\D|$)`).test(hay)) && pr.state !== 'CLOSED') {
        found.push({
          repo,
          number: pr.number,
          title: pr.title,
          branch: pr.headRefName,
          author: pr.author?.login,
          state: pr.state,
          draft: pr.isDraft,
          updatedAt: pr.updatedAt,
          url: pr.url,
        });
      }
    }
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function prepareWorktree(id, pr, env) {
  const repoDir = join(REPOS, pr.repo);
  const wt = join(WORKTREES, `deskcheck-${id}`);
  const git = (...a) => sh('git', ['-C', repoDir, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...a], { env });
  if (!existsSync(join(repoDir, '.git'))) {
    mkdirSync(REPOS, { recursive: true });
    const c = await sh('gh', ['repo', 'clone', `${GH_ORG}/${pr.repo}`, repoDir, '--', '--quiet'], { env });
    if (c.code !== 0) throw new Error(`Falha ao clonar ${pr.repo}: ${c.err.trim()}`);
  }
  const f = await git('fetch', '-q', 'origin', `pull/${pr.number}/head`);
  if (f.code !== 0) throw new Error(`Falha ao baixar PR #${pr.number}: ${f.err.trim()}`);
  if (existsSync(wt)) await git('worktree', 'remove', '--force', wt);
  const w = await git('worktree', 'add', '--detach', wt, 'FETCH_HEAD');
  if (w.code !== 0) throw new Error(`Falha ao criar worktree: ${w.err.trim()}`);
  const common = (await sh('git', ['-C', wt, 'rev-parse', '--git-common-dir'])).out.trim();
  const exclude = join(common.startsWith('/') ? common : join(wt, common), 'info/exclude');
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  for (const p of ['.deskcheck/', '.local-harness/']) if (!current.includes(p)) appendFileSync(exclude, `\n${p}\n`);
  const commit = (await sh('git', ['-C', wt, 'rev-parse', '--short', 'HEAD'])).out.trim();
  return { worktree: wt, commit };
}

async function main() {
  const raw = argv.find((a) => /\d{5,7}/.test(a));
  const m = raw && /(\d{5,7})/.exec(raw);
  if (!m || has('--help') || has('-h')) {
    console.log('Uso: yarn prepare-card <link ou número do card> [--pr <N>] [--skip-card]');
    process.exit(has('--help') || has('-h') ? 0 : 1);
  }
  const id = Number(m[1]);
  const dir = join(DC_ROOT, String(id));
  const cardFile = join(dir, 'card.json');
  mkdirSync(dir, { recursive: true });
  if (!has('--skip-card') || !existsSync(cardFile)) {
    const r = await sh(DC, ['card', String(id), '--root', DC_ROOT], { cwd: ROOT });
    if (r.code !== 0 || !existsSync(cardFile)) throw new Error(`Falha ao ler card ${id}: ${(r.err || r.out).trim()}`);
  }
  const card = JSON.parse(readFileSync(cardFile, 'utf8'));
  const env = await githubEnv();
  const prs = await findPrs(card, env);
  const wantedPr = opt('--pr') ? Number(opt('--pr')) : null;
  const wantedRepo = opt('--repo') || null;
  let pr = null;
  if (wantedPr) pr = prs.find((p) => p.number === wantedPr && (!wantedRepo || p.repo === wantedRepo)) || null;
  else if (prs.length === 1) pr = prs[0];

  if (!pr) {
    const out = {
      status: prs.length ? 'multiple_prs' : 'no_pr',
      id,
      dir,
      card: { id: card.id, type: card.type, title: card.title, state: card.state, assignedTo: card.assignedTo, parent: card.parent || null, fronts: card.fronts || [], testCasesCount: (card.testCases || []).length, criteriaCount: (card.acceptanceCriteria || []).length },
      prs,
    };
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = 2;
    return;
  }

  const { worktree, commit } = await prepareWorktree(id, pr, env);
  const mfeInfo = MFE_MAP[pr.repo] || { mfe: 'unknown', port: 3100, kit: '' };
  const prep = {
    status: 'ready',
    id,
    dir,
    cardMd: join(dir, 'card.md'),
    cardJson: cardFile,
    planPath: join(dir, 'plan.json'),
    dcBin: DC,
    dcRoot: DC_ROOT,
    card: {
      id: card.id,
      type: card.type,
      title: card.title,
      state: card.state,
      assignedTo: card.assignedTo,
      parent: card.parent || null,
      fronts: card.fronts || [],
      testCases: (card.testCases || []).map((tc) => ({ id: tc.id, title: tc.title, state: tc.state })),
      criteriaCount: (card.acceptanceCriteria || []).length,
    },
    pr,
    worktree,
    commit,
    mfe: mfeInfo.mfe,
    port: mfeInfo.port,
    localKit: existsSync(mfeInfo.kit) ? mfeInfo.kit : null,
    mfeGuide: join(ROOT, 'harness', 'mfe-local.md'),
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'prep.json'), JSON.stringify(prep, null, 2));
  console.log(JSON.stringify(prep, null, 2));
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exitCode = 1;
});
