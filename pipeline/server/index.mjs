import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { AGENTS, findAgent, listAgents, extractJson, resolveBin, parseItemEvent } from './agents.mjs';
import { loadCache, pickRunPt, translateRun } from './translate.mjs';
import { CONFIG, configProblems, workItemUrl } from './config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4310);
const SIMULATE = process.argv.includes('--simulate');
const REPOS = CONFIG.reposDir;
const AGENT_TIMEOUT_MS = Math.max(1, Number(process.env.AGENT_TIMEOUT_MIN) || 45) * 60_000;
const WORKTREES = join(REPOS, '.worktrees');
const GH_ORG = CONFIG.github.org;
const MFE_REPOS = CONFIG.repos.map((r) => r.name);
const NODE_BIN = process.env.NODE_BIN || dirname(process.execPath);
const HARNESS = join(ROOT, 'harness');
const DC = join(HARNESS, 'bin', 'deskcheck');
const DC_ROOT = process.env.DESKCHECK_ROOT || join(ROOT, '.deskcheck');
const WEB = join(ROOT, 'web');
const ENV = { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH}`, NODE_BIN, DESKCHECK_ORG: CONFIG.azure.org, DESKCHECK_PROJECT: CONFIG.azure.project, DESKCHECK_ZONE_ROLE: CONFIG.zoneRole };
const CUSTOM_GUIDE = CONFIG.localGuide ? resolve(ROOT, CONFIG.localGuide) : '';
const LOCAL_GUIDE = CUSTOM_GUIDE && existsSync(CUSTOM_GUIDE) ? CUSTOM_GUIDE : join(HARNESS, 'mfe-local.md');
const NO_INSTALL_SCRIPTS = CONFIG.allowInstallScripts ? {} : { npm_config_ignore_scripts: 'true', yarn_ignore_scripts: 'true', YARN_ENABLE_SCRIPTS: 'false' };
const AGENT_ENV = { ...ENV, ...NO_INSTALL_SCRIPTS, PATH: `${join(HARNESS, 'guard')}:${join(HARNESS, 'bin')}:${ENV.PATH}` };
const GH_USER = CONFIG.github.user;
const DEFAULT_AGENT = process.env.AGENT || listAgents(ENV.PATH).find((a) => a.available)?.id || AGENTS[0]?.id || '';
const RUN_FILE = 'run.json';
const ENVS = CONFIG.envs;
const NO_ENV = { id: '', label: '', base: '', adminUsers: '', appUsers: '' };
const pickEnv = (v) => ENVS[v] || Object.values(ENVS)[0] || NO_ENV;
const PT_CACHE_FILE = join(DC_ROOT, 'translations.pt.json');
const ptCache = loadCache(PT_CACHE_FILE);

export const STEPS = [
  ['card', 'Card e Tested By'],
  ['pr', 'PR do colega'],
  ['screen', 'Subir a tela'],
  ['scenarios', 'Rodar os Test Cases'],
  ['report', 'Relatório'],
];

const runs = [];
const clients = new Set();
let seq = 1;

const stamp = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const view = (r) => ({ ...r, card: r.card && { ...r.card, description: undefined }, pt: r.pt || pickRunPt(r, ptCache) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function emit() {
  const data = `data: ${JSON.stringify(runs.map(view))}\n\n`;
  for (const res of clients) res.write(data);
}
async function ensurePt(run) {
  await translateRun(run, ptCache, PT_CACHE_FILE, { simulate: SIMULATE || !CONFIG.translate });
  emit();
}
const MESSAGES = {
  'card.reading': () => 'Lendo o card no Azure, com os Test Cases do Tested By (só leitura).',
  'card.read': (p) => `Card lido: ${p.type}, ${p.state}, responsável ${p.assignee}. ${p.tcs} Test Case(s) no Tested By, ${p.acs} critério(s) de aceite.`,
  'card.noTestCases': () => 'Parado: o QA ainda não ligou Test Cases no Tested By deste card. O desk check é feito em cima deles.',
  'pr.searching': () => 'Procurando o PR do colega pelo número do card, das Tasks e das histórias filhas.',
  'pr.none': () => 'Parado: não achei PR aberto ou mergeado com o número do card, das Tasks ou das histórias filhas nos repositórios configurados.',
  'pr.many': (p) => `Achei ${p.count} PRs. Escolha qual testar.`,
  'pr.chosen': (p) => `PR escolhido: #${p.number} (${p.repo}), branch ${p.branch}, de ${p.author}.`,
  'worktree.ready': (p) => `Código do PR baixado numa worktree só de teste (${p.commit}). Seu checkout não é tocado.`,
  'agent.simulate': (p) => `Modo simulação com ${p.agent}: nada é instalado nem executado.`,
  'agent.start': (p) => `${p.agent} subindo a tela (${p.dataMode === 'mock' ? 'dados mockados' : 'dados reais'}) e escrevendo um cenário por Test Case.`,
  'login.waiting': () => 'Aguardando você fazer login na janela do Chrome — conclua o login e feche a janela para continuar.',
  'sim.install': () => 'Instalando dependências (simulado).',
  'sim.screen': () => 'Tela no ar em http://localhost:3100 (simulado).',
  'sim.scenarios': () => 'Escrevendo um cenário por Test Case.',
  'sim.tc': (p) => `Executando cenário ${p.scenario} (TC ${p.tc}) no Chrome (simulado).`,
  'code.changed': (p) => `Atenção: ${p.count} arquivo(s) do código foram alterados durante o teste (${p.files}). Isso fica só nesta worktree de teste e não vai para lugar nenhum.`,
  'code.untouched': () => 'Conferido: nenhum arquivo do código do colega foi alterado.',
  'verdict': (p) => `Veredito: ${VERDICT_LABEL[p.verdict] || p.verdict}. ${p.pass} ok · ${p.fail} falhas · ${p.warn} ressalvas · ${p.blocked} bloqueados. ${p.defects} defeito(s) apontado(s).`,
  'nothingWritten': () => 'Nada foi gravado no Azure nem no GitHub.',
  'interrupted': () => 'Interrompido: a esteira foi reiniciada no meio da execução.',
};
const VERDICT_LABEL = { approved: 'aprovado', 'approved-with-notes': 'aprovado com ressalvas', rejected: 'reprovado', incomplete: 'incompleto' };
const currentStepKey = (run) => STEPS[Math.min(Math.max(run.step || 0, 0), STEPS.length - 1)]?.[0] || 'card';
const entry = (key, params = {}, level = '') => ({ time: stamp(), level, key, params, text: MESSAGES[key](params) });
function log(run, text, level = '', kind = 'info') { run.log.push({ time: stamp(), level, kind, step: currentStepKey(run), text }); emit(); }
function say(run, key, params, level) { run.log.push({ ...entry(key, params, level), kind: 'phase', step: currentStepKey(run) }); emit(); }
function step(run, k) {
  const idx = STEPS.findIndex(([key]) => key === k);
  const now = new Date().toISOString();
  if (!run.stepTimes) run.stepTimes = {};
  const prevKey = STEPS[run.step]?.[0];
  if (prevKey && run.stepTimes[prevKey] && !run.stepTimes[prevKey].finishedAt && prevKey !== k) {
    run.stepTimes[prevKey].finishedAt = now;
  }
  run.step = idx;
  if (k && !run.stepTimes[k]) run.stepTimes[k] = { startedAt: now };
  emit();
}

function sh(cmd, args, opts = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: ENV, ...opts });
    let out = '', err = '', timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, opts.timeoutMs) : null;
    child.stdout.on('data', (d) => { out += d; opts.onData?.(String(d)); });
    child.stderr.on('data', (d) => { err += d; opts.onErr?.(String(d)); });
    child.on('error', (e) => { clearTimeout(timer); done({ code: 1, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); done(timedOut ? { code: 124, out, err: `tempo esgotado depois de ${Math.round(opts.timeoutMs / 60000)} min` } : { code, out, err }); });
  });
}
const lastLine = (s) => String(s || '').trim().split('\n').pop();

let ghEnv;
async function githubEnv() {
  if (ghEnv) return ghEnv;
  let t = GH_USER ? await sh('gh', ['auth', 'token', '--user', GH_USER]) : { code: 1, out: '' };
  if (t.code !== 0 || !t.out.trim()) t = await sh('gh', ['auth', 'token']);
  if (t.code !== 0 || !t.out.trim()) throw new Error('Sem login do GitHub nesta máquina. Rode: gh auth login (com uma conta que acesse os repositórios configurados).');
  ghEnv = { ...ENV, GH_TOKEN: t.out.trim() };
  return ghEnv;
}

let chromeQueue = Promise.resolve();
function withChrome(task) {
  const next = chromeQueue.then(task, task);
  chromeQueue = next.catch(() => {});
  return next;
}

function save(run) {
  if (SIMULATE && !process.env.DESKCHECK_ROOT) return;
  try {
    mkdirSync(join(DC_ROOT, String(run.id)), { recursive: true });
    writeFileSync(join(DC_ROOT, String(run.id), RUN_FILE), JSON.stringify({ ...view(run), pt: undefined }, null, 1));
  } catch (e) {
    console.error(`Não consegui salvar o histórico do card ${run.id}: ${e.message}`);
  }
}
function shotMarks(id) {
  const file = join(DC_ROOT, String(id), 'results.json');
  if (!existsSync(file)) return {};
  try {
    const results = JSON.parse(readFileSync(file, 'utf8'));
    return Object.fromEntries(results.scenarios.flatMap((sc) => sc.shots || []).filter((s) => s.marks?.length).map((s) => [s.file, s.marks.map(({ n, note, box, label }) => ({ n, note, box, label }))]));
  } catch {
    return {};
  }
}
function screenshots(id) {
  const base = join(DC_ROOT, String(id), 'shots');
  if (!existsSync(join(base, 'web'))) return [];
  const marks = shotMarks(id);
  return readdirSync(join(base, 'web')).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().map((f) => {
    const png = f.replace(/\.jpe?g$/i, '.png');
    const shot = { name: f.replace(/\.[^.]+$/, ''), scenario: f.split('-')[0], thumb: `/report/${id}/shots/web/${f}`, full: existsSync(join(base, png)) ? `/report/${id}/shots/${png}` : `/report/${id}/shots/web/${f}` };
    if (marks[png]) shot.marks = marks[png];
    return shot;
  });
}
function loadHistory() {
  if (!existsSync(DC_ROOT)) return;
  const loaded = [];
  for (const d of readdirSync(DC_ROOT)) {
    const f = join(DC_ROOT, d, RUN_FILE);
    if (!existsSync(f)) continue;
    try {
      const r = JSON.parse(readFileSync(f, 'utf8'));
      if (r.status === 'running') { r.status = 'error'; r.log.push(entry('interrupted', {}, 'bad')); }
      r.shots = screenshots(r.id);
      loaded.push(r);
    } catch (e) {
      console.error(`Histórico ignorado (${f}): ${e.message}`);
    }
  }
  loaded.sort((a, b) => String(b.finishedAt || b.startedAt || '').localeCompare(String(a.finishedAt || a.startedAt || '')));
  for (const r of loaded) {
    r.key = seq++;
    r.pt = pickRunPt(r, ptCache);
    runs.push(r);
  }
  if (!SIMULATE && runs.length) {
    (async () => {
      for (const r of runs) await ensurePt(r);
    })().catch(() => {});
  }
}

const SAMPLE_CARD = {
  type: 'User Story', title: 'Exemplo da simulação (sem Azure)', state: 'Testing', assignedTo: 'Colega',
  testCases: [1, 2, 3].map((n) => ({ id: 900000 + n, title: `Test Case de exemplo ${n}`, state: 'Design', steps: [{ n: 1, action: 'Given: a tela está aberta' }, { n: 2, action: 'When: o usuário faz a ação' }, { n: 3, action: 'Then: o resultado aparece' }] })),
  acceptanceCriteria: [{ id: 'AC-1', text: 'Exemplo' }], defects: [], tasks: [], stories: [],
};
async function readCard(run) {
  const file = join(DC_ROOT, String(run.id), 'card.json');
  if (SIMULATE) return normalizeCard(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : SAMPLE_CARD);
  mkdirSync(DC_ROOT, { recursive: true });
  const r = await sh(DC, ['card', String(run.id), '--root', DC_ROOT], { cwd: ROOT });
  if (r.code !== 0 || !existsSync(file)) throw new Error(`Não consegui ler o card ${run.id}: ${lastLine(r.err || r.out)}. Se pedir login, rode: harness/bin/deskcheck login`);
  return normalizeCard(JSON.parse(readFileSync(file, 'utf8')));
}
const normalizeCard = (card) => ({
  type: card.type, title: card.title, state: card.state, assignedTo: card.assignedTo, parent: card.parent || null,
  testCases: card.testCases.map((tc) => ({ id: tc.id, title: tc.title, state: tc.state, steps: tc.steps })),
  acceptanceCriteria: card.acceptanceCriteria || [], defects: card.defects || [], tasks: card.tasks || [], stories: card.stories || [],
  description: card.description,
});

const mentionsId = (text, id) => new RegExp(`(^|\\D)${id}(\\D|$)`).test(text);

async function findPrs(run) {
  const ids = [run.id, ...(run.card.parent ? [run.card.parent.id] : []), ...run.card.tasks.map((t) => t.id), ...run.card.stories.map((s) => s.id)].map(String);
  const found = [];
  const env = await githubEnv();
  for (const repo of MFE_REPOS) {
    const r = await sh('gh', ['pr', 'list', '-R', `${GH_ORG}/${repo}`, '--state', 'all', '--limit', '200',
      '--json', 'number,title,headRefName,body,author,state,isDraft,updatedAt,url,isCrossRepository'], { env });
    if (r.code !== 0) throw new Error(`Não consegui listar os PRs de ${repo}: ${lastLine(r.err)}`);
    for (const pr of JSON.parse(r.out || '[]')) {
      const haystack = `${pr.title} ${pr.headRefName} ${pr.body || ''}`;
      if (!pr.isCrossRepository && ids.some((id) => mentionsId(haystack, id)) && pr.state !== 'CLOSED') {
        found.push({ repo, number: pr.number, title: pr.title, branch: pr.headRefName, author: pr.author?.login, state: pr.state, draft: pr.isDraft, updatedAt: pr.updatedAt, url: pr.url });
      }
    }
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function prepareWorktree(run) {
  const pr = run.pr;
  const repoDir = join(REPOS, pr.repo);
  const wt = join(WORKTREES, `deskcheck-${run.id}`);
  const env = await githubEnv();
  const git = (...a) => sh('git', ['-C', repoDir, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...a], { env });
  if (!existsSync(join(repoDir, '.git'))) {
    mkdirSync(REPOS, { recursive: true });
    log(run, `Clonando ${pr.repo} em ${REPOS} (só na primeira vez nesta máquina)...`);
    const c = await sh('gh', ['repo', 'clone', `${GH_ORG}/${pr.repo}`, repoDir, '--', '--quiet'], { env, timeoutMs: 15 * 60_000 });
    if (c.code !== 0) throw new Error(`Não consegui clonar ${pr.repo}: ${lastLine(c.err)}`);
  }
  const f = await git('fetch', '-q', 'origin', `pull/${pr.number}/head`);
  if (f.code !== 0) throw new Error(`Não consegui baixar o PR #${pr.number}: ${lastLine(f.err)}`);
  if (existsSync(wt)) await git('worktree', 'remove', '--force', wt);
  const w = await git('worktree', 'add', '--detach', wt, 'FETCH_HEAD');
  if (w.code !== 0) throw new Error(`Não consegui criar a worktree: ${lastLine(w.err)}`);
  const common = (await sh('git', ['-C', wt, 'rev-parse', '--git-common-dir'])).out.trim();
  const exclude = join(common.startsWith('/') ? common : join(wt, common), 'info/exclude');
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  for (const p of ['.deskcheck/', '.local-harness/']) if (!current.includes(p)) appendFileSync(exclude, `\n${p}\n`);
  run.worktree = wt;
  run.commit = (await sh('git', ['-C', wt, 'rev-parse', '--short', 'HEAD'])).out.trim();
}

function dataInstructions(mode, envObj) {
  if (mode === 'mock') {
    return `O usuário escolheu **dados mockados**: suba a tela localmente com os mocks do repositório (conforme \`${LOCAL_GUIDE}\`), sem depender de API real ou login.`;
  }
  return `O padrão é testar com **dados reais** no ambiente **${envObj.label}** (${envObj.base}): conecte às APIs reais do ambiente, como descrito em \`${LOCAL_GUIDE}\`. **Não use \`--headless\`** quando puder pedir login: se a tela exigir autenticação/SSO, rode \`harness/bin/deskcheck login --url ${envObj.base}\` para o usuário fazer login no Chrome e fechar a janela, e depois continue automaticamente. Para testar diferentes papéis/permissões em ${envObj.label}, você pode alterar temporariamente **apenas o próprio usuário logado** com \`harness/bin/deskcheck role set\` e \`role restore\` (só em ambiente de teste, nunca em PRD); o backup fica em \`user-original.json\` e a esteira restaura o perfil original ao final mesmo em caso de erro.`;
}

function agentPrompt(run) {
  const mode = run.dataMode === 'mock' ? 'mock' : 'real';
  const envObj = pickEnv(run.env);
  const vars = {
    id: run.id, type: run.card.type, title: run.card.title, assignee: run.card.assignedTo || '—',
    dir: join(DC_ROOT, String(run.id)), root: DC_ROOT, harness: HARNESS, node: NODE_BIN,
    pr: run.pr.number, repo: run.pr.repo, branch: run.pr.branch, author: run.pr.author, worktree: run.worktree,
    dataMode: mode === 'mock' ? 'dados mockados' : `dados reais (${envObj.label})`,
    env: envObj.label,
    envBase: envObj.base,
    adminUsersUrl: envObj.adminUsers,
    appUsersUrl: envObj.appUsers, localGuide: LOCAL_GUIDE,
    dataInstructions: dataInstructions(mode, envObj),
  };
  return readFileSync(join(HARNESS, 'desk-check.md'), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function simulatedResult(run) {
  const tcs = run.card.testCases;
  return {
    screen: 'http://localhost:3100', verdict: 'rejected', summary: 'Execução simulada: nenhum cenário rodou de verdade.',
    scenarios: tcs.slice(0, 3).map((tc, i) => ({ id: `S${i + 1}`, tc: tc.id, status: i === 1 ? 'fail' : 'pass', notes: i === 1 ? 'Exemplo de falha simulada.' : 'Simulado.' })),
    defects: tcs[1] ? [{ title: '[FRONT] Example defect (simulated)', scenario: 'S2', tc: tcs[1].id, steps: '1. Open the screen.\n2. Do the action.', expected: 'What the TC expects.', actual: 'What happened.' }] : [],
    acWithoutTc: [], notTested: [],
  };
}

const RUN_COMMAND = /deskcheck(\.mjs)? run\b/;
const LOGIN_COMMAND = /deskcheck(\.mjs)? login\b/;

function formatToolUse(p) {
  const name = p.name || 'tool';
  const input = p.input || {};
  if (name === 'Bash' && input.command) return `Bash: ${String(input.command).replace(/\s+/g, ' ').trim().slice(0, 180)}`;
  const target = input.file_path || input.path || input.pattern || input.url || '';
  if (target) return `${name}: ${String(target).split('/').slice(-2).join('/')}`;
  return name;
}

function repairPrompt(run, previous) {
  const dir = join(DC_ROOT, String(run.id));
  return [
    'NÃO execute nenhum comando de teste, não suba servidor e não altere arquivos.',
    `O desk check do card ${run.id} já terminou. A sua resposta final não trouxe um bloco \`\`\`json válido.`,
    `Responda APENAS com um bloco \`\`\`json no formato de "Resposta final" de ${join(HARNESS, 'desk-check.md')}, usando o que já está em ${dir} (results.json, report.md) e a resposta anterior abaixo.`,
    '',
    'Resposta anterior:',
    String(previous || '').slice(-6000),
  ].join('\n');
}

function streamJsonText(raw) {
  let out = '';
  for (const line of String(raw).split('\n')) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'result' && ev.result) out = ev.result;
      else if (ev.type === 'assistant') for (const p of ev.message?.content || []) if (p.type === 'text' && p.text.trim()) out = p.text;
    } catch { continue; }
  }
  return out || raw;
}

async function runAgent(run) {
  if (SIMULATE) {
    for (const key of ['sim.install', 'sim.screen', 'sim.scenarios']) {
      await sleep(700); say(run, key);
    }
    step(run, 'scenarios');
    for (const [i, tc] of run.card.testCases.slice(0, 3).entries()) {
      await sleep(400); say(run, 'sim.tc', { scenario: `S${i + 1}`, tc: tc.id });
    }
    return simulatedResult(run);
  }
  const agent = findAgent(run.agent);
  const lastMessage = join(tmpdir(), `deskcheck-${run.id}-${Date.now()}.txt`);
  const dirs = [run.worktree, DC_ROOT, HARNESS];
  let text = '', buffer = '';
  const onLine = (l) => {
    const t = l.trim();
    if (t.length < 3) return;
    if (LOGIN_COMMAND.test(t)) say(run, 'login.waiting', {}, 'warn');
    if (RUN_COMMAND.test(t)) step(run, 'scenarios');
    log(run, t.slice(0, 260), '', 'agent');
  };
  const onStreamJson = (l) => {
    let ev;
    try { ev = JSON.parse(l); } catch { return; }
    if (ev.type === 'assistant') for (const p of ev.message?.content || []) {
      if (p.type === 'text' && p.text.trim()) { text = p.text; log(run, p.text.trim().slice(0, 260), '', 'agent'); }
      if (p.type === 'tool_use') {
        if (LOGIN_COMMAND.test(p.input?.command || '')) say(run, 'login.waiting', {}, 'warn');
        if (RUN_COMMAND.test(p.input?.command || '')) step(run, 'scenarios');
        log(run, formatToolUse(p), '', 'tool');
      }
    }
    if (ev.type === 'result' && ev.result) text = ev.result;
  };
  const onEventsJson = (l) => {
    const parsed = parseItemEvent(l);
    if (!parsed) return;
    if (parsed.command && LOGIN_COMMAND.test(parsed.command)) say(run, 'login.waiting', {}, 'warn');
    if (parsed.command && RUN_COMMAND.test(parsed.command)) step(run, 'scenarios');
    if (parsed.fullText) text = parsed.fullText;
    log(run, parsed.text, parsed.level, parsed.kind === 'error' ? 'phase' : parsed.kind);
  };
  const handler = agent.output === 'stream-json' ? onStreamJson : agent.output === 'events-json' ? onEventsJson : onLine;
  const binPath = resolveBin(agent, ENV.PATH) || agent.bin;
  const r = await sh(binPath, agent.args({ prompt: agentPrompt(run), cwd: run.worktree, dirs, lastMessage }), {
    cwd: run.worktree, env: AGENT_ENV, timeoutMs: AGENT_TIMEOUT_MS,
    onData: (chunk) => {
      if (agent.output === 'text') text += chunk;
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop();
      lines.forEach(handler);
    },
  });
  if (existsSync(lastMessage)) { text += '\n' + readFileSync(lastMessage, 'utf8'); rmSync(lastMessage, { force: true }); }
  let result = extractJson(text);
  if (!result && r.code !== 124) {
    log(run, 'O resumo final veio sem JSON válido: pedindo ao agente para reescrever só o resumo.', 'warn');
    let fixed = '';
    const retry = await sh(binPath, agent.args({ prompt: repairPrompt(run, text), cwd: run.worktree, dirs, lastMessage }), {
      cwd: run.worktree, env: AGENT_ENV, timeoutMs: 5 * 60_000, onData: (chunk) => { fixed += chunk; },
    });
    if (existsSync(lastMessage)) { fixed += '\n' + readFileSync(lastMessage, 'utf8'); rmSync(lastMessage, { force: true }); }
    result = extractJson(agent.output === 'stream-json' ? streamJsonText(fixed) : fixed);
    if (!result) throw new Error(`${agent.name} terminou sem o resumo esperado, mesmo depois de uma nova tentativa (código ${retry.code}). ${lastLine(retry.err)}`);
  }
  if (!result) throw new Error(`${agent.name} terminou sem o resumo esperado (código ${r.code}). ${lastLine(r.err)}`);
  return result;
}

async function checkUntouched(run) {
  if (SIMULATE) return;
  const st = await sh('git', ['-C', run.worktree, 'status', '--porcelain']);
  const changed = st.out.split('\n').filter((l) => l.trim() && !/\.(deskcheck|local-harness)\//.test(l));
  if (changed.length) {
    run.changedFiles = changed.map((l) => l.slice(3));
    say(run, 'code.changed', { count: changed.length, files: run.changedFiles.slice(0, 3).join(', ') }, 'warn');
  } else say(run, 'code.untouched', {}, 'ok');
}

function finish(run, status) {
  const now = new Date().toISOString();
  if (run.stepTimes) for (const st of Object.values(run.stepTimes)) if (st && !st.finishedAt) st.finishedAt = now;
  run.status = status;
  run.finishedAt = now;
  emit();
  save(run);
}

async function start(run) {
  try {
    step(run, 'card'); say(run, 'card.reading');
    run.card = await withChrome(() => readCard(run));
    Object.assign(run, { type: run.card.type, title: run.card.title });
    ensurePt(run).catch(() => {});
    const tcs = run.card.testCases.length;
    say(run, 'card.read', { type: run.card.type, state: run.card.state, assignee: run.card.assignedTo || '—', tcs, acs: run.card.acceptanceCriteria.length }, tcs ? 'ok' : 'warn');
    if (!tcs) { say(run, 'card.noTestCases', {}, 'warn'); return finish(run, 'blocked'); }

    step(run, 'pr'); say(run, 'pr.searching');
    run.prs = SIMULATE ? [{ repo: MFE_REPOS[1], number: 0, title: `[${run.id}] PR simulado`, branch: `feature/${run.id}`, author: 'colega', state: 'OPEN', draft: false, updatedAt: new Date().toISOString(), url: '#' }] : await findPrs(run);
    if (!run.prs.length) { say(run, 'pr.none', {}, 'warn'); return finish(run, 'blocked'); }
    if (run.prs.length > 1) { run.status = 'waiting'; say(run, 'pr.many', { count: run.prs.length }, 'warn'); return; }
    await continueWith(run, run.prs[0]);
  } catch (e) { log(run, String(e.message || e), 'bad'); finish(run, 'error'); }
}

async function restoreRoleIfPending(run) {
  if (SIMULATE) return;
  const file = join(DC_ROOT, String(run.id), 'user-original.json');
  if (!existsSync(file)) return;
  let backup;
  try { backup = JSON.parse(readFileSync(file, 'utf8')); } catch { log(run, `NÃO consegui ler ${file}: confira o papel do usuário na tela de usuários e a cópia ${file}.bak.`, 'bad'); return; }
  if (backup.restored) return;
  log(run, `Restaurando o papel original do usuário (${(backup.original?.roles || []).join(', ')})...`, 'warn');
  const r = await withChrome(() => sh(join(HARNESS, 'bin', 'deskcheck'), ['role', 'restore', String(run.id), '--root', DC_ROOT], { timeoutMs: 5 * 60_000 }));
  if (r.code === 0) log(run, lastLine(r.out) || 'Papel original restaurado.', 'ok');
  else log(run, `NÃO consegui restaurar o papel original: ${lastLine(r.err) || lastLine(r.out)}. Rode: harness/bin/deskcheck role restore ${run.id} --root ${DC_ROOT}`, 'bad');
}

async function continueWith(run, pr) {
  try {
    run.pr = pr; run.status = 'running';
    say(run, 'pr.chosen', { number: pr.number, repo: pr.repo, branch: pr.branch, author: pr.author }, 'ok');
    step(run, 'screen');
    if (!SIMULATE) { await prepareWorktree(run); say(run, 'worktree.ready', { commit: run.commit }, 'ok'); }
    const agent = findAgent(run.agent);
    say(run, SIMULATE ? 'agent.simulate' : 'agent.start', { agent: agent.name, dataMode: run.dataMode || 'real' });
    try { run.result = await withChrome(() => runAgent(run)); } finally { await restoreRoleIfPending(run); }
    await checkUntouched(run);
    step(run, 'report');
    run.shots = screenshots(run.id);
    await ensurePt(run);
    const res = run.result, count = (s) => (res.scenarios || []).filter((c) => c.status === s).length;
    say(run, 'verdict', { verdict: res.verdict, pass: count('pass'), fail: count('fail'), warn: count('warn'), blocked: count('blocked'), defects: (res.defects || []).length }, count('fail') ? 'warn' : 'ok');
    say(run, 'nothingWritten', {}, 'ok');
    run.step = STEPS.length; finish(run, 'done');
  } catch (e) { log(run, String(e.message || e), 'bad'); finish(run, 'error'); }
}


function newRun(id, agentId, dataMode = 'real', env = 'dev') {
  const mode = dataMode === 'mock' ? 'mock' : 'real';
  const envId = pickEnv(env).id;
  const run = { key: seq++, id: Number(id), link: workItemUrl(id), type: '', title: `Card ${id}`, step: 0, stepTimes: {}, status: 'running', agent: agentId, dataMode: mode, env: envId, startedAt: new Date().toISOString(), log: [] };
  runs.unshift(run); start(run);
  return run;
}

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((done) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { done(JSON.parse(b || '{}')); } catch { done({}); } }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.md': 'text/plain; charset=utf-8' };

function pickAgent(requested) {
  const id = requested || DEFAULT_AGENT;
  const a = listAgents(ENV.PATH).find((x) => x.id === id);
  if (!a) return { error: `Agente desconhecido: ${id}. Opções: ${AGENTS.map((x) => x.id).join(', ')}.`, code: 'agent.unknown', params: { id, options: AGENTS.map((x) => x.id).join(', ') } };
  if (!a.available && !SIMULATE) return { error: `${a.name} não está instalado nesta máquina. Para instalar: ${a.install}.`, code: 'agent.notInstalled', params: { name: a.name, install: a.install } };
  return { id: a.id };
}

const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const LOCAL_ORIGINS = new Set([...LOCAL_HOSTS].map((h) => `http://${h}`));

function requestRefusal(req) {
  if (!LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase())) return 'host';
  if (req.method === 'GET' || req.method === 'HEAD') return '';
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGINS.has(String(origin).toLowerCase())) return 'origin';
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return 'origin';
  if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return 'content-type';
  return '';
}

export const server = createServer(async (req, res) => {
  const refused = requestRefusal(req);
  if (refused) { res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'Requisição recusada.', code: `forbidden.${refused}` })); }
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); return res.end(readFileSync(join(WEB, 'index.html'))); }
  const asset = /^\/vendor\/([\w.-]+\.js)$/.exec(url.pathname);
  if (req.method === 'GET' && asset && existsSync(join(WEB, 'vendor', asset[1]))) {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'max-age=86400' });
    return res.end(readFileSync(join(WEB, 'vendor', asset[1])));
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res); req.on('close', () => clients.delete(res));
    return res.write(`data: ${JSON.stringify(runs.map(view))}\n\n`);
  }
  if (url.pathname === '/api/doctor') {
    const r = await sh(process.execPath, [join(ROOT, 'bin', 'doctor.mjs'), '--json', ...(url.searchParams.get('full') ? [] : ['--quick'])], { timeoutMs: 120_000 });
    try { return json(res, 200, JSON.parse(r.out)); } catch { return json(res, 500, { error: lastLine(r.err) || 'doctor falhou' }); }
  }
  if (url.pathname === '/api/config') return json(res, 200, { simulate: SIMULATE, steps: STEPS, defaultAgent: DEFAULT_AGENT, defaultDataMode: 'real', defaultEnv: Object.keys(ENVS)[0] || '', envs: ENVS, repoPrefix: CONFIG.repoPrefix, markFields: CONFIG.markFields, configProblems: SIMULATE ? [] : configProblems() });
  if (url.pathname === '/api/agents') return json(res, 200, listAgents(ENV.PATH));
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const { url: targetUrl } = await readBody(req);
    const cleanUrl = typeof targetUrl === 'string' && /^https?:\/\//i.test(targetUrl.trim()) ? targetUrl.trim() : '';
    if (SIMULATE) return json(res, 200, { ok: true, simulated: true, url: cleanUrl || 'https://dev.azure.com' });
    const args = ['login', ...(cleanUrl ? ['--url', cleanUrl] : [])];
    withChrome(() => sh(DC, args, { cwd: ROOT })).catch(() => {});
    return json(res, 200, { ok: true, url: cleanUrl || 'https://dev.azure.com' });
  }
  if (req.method === 'POST' && url.pathname === '/api/reload') {
    const active = runs.filter((r) => r.status === 'running' || r.status === 'waiting');
    const activeIds = new Set(active.map((r) => r.id));
    runs.length = 0;
    for (const r of active) runs.push(r);
    if (existsSync(DC_ROOT)) {
      const loaded = [];
      for (const d of readdirSync(DC_ROOT)) {
        const f = join(DC_ROOT, d, RUN_FILE);
        if (!existsSync(f)) continue;
        try {
          const r = JSON.parse(readFileSync(f, 'utf8'));
          if (activeIds.has(r.id)) continue;
          r.shots = screenshots(r.id);
          r.pt = pickRunPt(r, ptCache);
          loaded.push(r);
        } catch {}
      }
      loaded.sort((a, b) => String(b.finishedAt || b.startedAt || '').localeCompare(String(a.finishedAt || a.startedAt || '')));
      for (const r of loaded) { r.key = seq++; runs.push(r); }
    }
    emit();
    if (!SIMULATE) (async () => { for (const r of runs) await ensurePt(r); })().catch(() => {});
    return json(res, 200, { ok: true, count: runs.length });
  }
  const report = /^\/report\/(\d+)\/(.+)$/.exec(url.pathname);
  if (req.method === 'GET' && report) {
    const base = join(DC_ROOT, report[1]);
    const file = normalize(join(base, decodeURIComponent(report[2])));
    if (!file.startsWith(base + '/') || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'Relatório não encontrado.', code: 'report.notFound' });
    const type = MIME[extname(file).toLowerCase()];
    if (!type) return json(res, 404, { error: 'Relatório não encontrado.', code: 'report.notFound' });
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox allow-scripts allow-popups; default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; form-action 'none'" });
    return res.end(readFileSync(file));
  }
  if (req.method === 'POST' && url.pathname === '/api/runs') {
    const { link, agent, dataMode, env } = await readBody(req);
    const m = /(\d{5,7})/.exec(String(link || ''));
    if (!m) return json(res, 400, { error: 'Não achei o número do card nesse link.', code: 'link.noNumber' });
    if (runs.some((r) => r.id === Number(m[1]) && (r.status === 'running' || r.status === 'waiting'))) return json(res, 409, { error: `O card ${m[1]} já está em desk check.`, code: 'card.running', params: { id: m[1] } });
    const picked = pickAgent(agent);
    if (picked.error) return json(res, 400, picked);
    return json(res, 201, view(newRun(m[1], picked.id, dataMode, env)));
  }
  const remove = /^\/api\/runs\/(\d+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && remove) {
    const idx = runs.findIndex((r) => r.key === Number(remove[1]));
    if (idx < 0) return json(res, 404, { error: 'Desk check não encontrado.', code: 'run.notFound' });
    const run = runs[idx];
    if (run.status === 'running') return json(res, 409, { error: 'Não dá para excluir enquanto o desk check está rodando.', code: 'run.running' });
    runs.splice(idx, 1);
    const sameId = runs.some((r) => r.id === run.id);
    if (!sameId) {
      const target = normalize(join(DC_ROOT, String(run.id)));
      if (target.startsWith(DC_ROOT + '/') && existsSync(target)) rmSync(target, { recursive: true, force: true });
    }
    emit();
    return json(res, 200, { ok: true, id: run.id });
  }
  const choose = /^\/api\/runs\/(\d+)\/choose$/.exec(url.pathname);
  if (req.method === 'POST' && choose) {
    const run = runs.find((r) => r.key === Number(choose[1]));
    const { number, repo } = await readBody(req);
    const pr = run?.prs?.find((p) => p.number === number && (!repo || p.repo === repo));
    if (!run || run.status !== 'waiting' || !pr) return json(res, 400, { error: 'Escolha inválida.', code: 'choice.invalid' });
    continueWith(run, pr);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'Não encontrado.', code: 'notFound' });
});

loadHistory();
server.listen(PORT, '127.0.0.1', () => {
  const available = listAgents(ENV.PATH).filter((a) => a.available).map((a) => a.name).join(', ') || 'nenhum';
  console.log(`Esteira de Desk Check em http://localhost:${PORT}${SIMULATE ? ' (simulação)' : ''} · agentes: ${available} · só leitura: nada é gravado no Azure nem no GitHub`);
  if (process.argv.includes('--open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '']] : [process.platform === 'darwin' ? 'open' : 'xdg-open', []];
    spawn(cmd, [...args, `http://localhost:${PORT}`], { stdio: 'ignore' }).on('error', () => {});
  }
  if (!SIMULATE) sh(process.execPath, [join(ROOT, 'bin', 'doctor.mjs'), '--quick'], { timeoutMs: 60_000 }).then((r) => console.log(`\nAmbiente:\n${r.out.trim()}`));
});
