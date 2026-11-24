#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = existsSync(path.join(here, '..', 'src', 'cdp.mjs')) ? path.join(here, '..', 'src') : path.join(here, '..', 'lib');
const imp = (f) => import(pathToFileURL(path.join(src, f)).href);

const { DEFAULT_PROFILE, DeskcheckError, loginWindow, withChrome } = await imp('cdp.mjs');
const { DEFAULT_ORG, DEFAULT_PROJECT, browserTransport, createAzure, orgUrl } = await imp('azure.mjs');
const { cardMarkdown, fetchCard } = await imp('card.mjs');
const { runPlan, statusIcon, summarize, validatePlan } = await imp('runner.mjs');
const { reportHtml, reportMarkdown, verdictOf } = await imp('report.mjs');
const { explore, exploreSummary } = await imp('explore.mjs');
const { applyAction, buildDefect, buildEvidence, buildMark, discardPending, findPending, listPending, markDefectInResults, savePending } = await imp('actions.mjs');

const HELP = `deskcheck — desk check de User Story / Technical Story / Bug (Azure DevOps), sem token.

Leitura (sem risco):
  deskcheck login [--url <endereço>]     abre o Chrome do deskcheck para logar (padrão: dev.azure.com)
  deskcheck whoami                       confere o login no Azure
  deskcheck card <id>                    lê a história, critérios de aceite, Test Cases e Defects
                                         → .deskcheck/<id>/card.json, card.md e plan.template.json
  deskcheck run --plan <plan.json> [--url <tela>] [--only S1,S2] [--headless] [--slow <ms>] [--no-open]
                                         roda os cenários NA TELA (Chrome visível, painel com o passo atual e
                                         destaque do elemento) e abre o relatório no fim; grava results.json,
                                         report.md, report.html e shots/. --headless esconde (padrão em CI/sem tela)
                                         fora de localhost é SOMENTE LEITURA: POST/PUT/PATCH/DELETE barrados na rede
  deskcheck explore <url> [--out <pasta>] [--headed]
                                         lê a tela antes do plano: títulos, controles (papel + nome acessível),
                                         data-testid, texto e print → explore.json e explore.png
  deskcheck verdict <cenário> --status pass|warn|fail|blocked|auto [--note "o que viu"] [--dir <pasta>]
                                         registra o veredito revisado (auto volta ao resultado automático)
  deskcheck role <backup|set|restore|status> <id> --url <tela de usuários> [--roles a,b]
                                         troca o papel do PRÓPRIO usuário em ambiente de teste, com backup e restauração conferida
  deskcheck report [--dir <pasta>] [--open]
                                         regera o relatório

Escrita no Azure (2 etapas; a 1ª só mostra a prévia):
  deskcheck defect <usId> --scenario S2 [--title ..] [--expected ..] [--actual ..] [--front FRONT]
  deskcheck evidence <tcId> [--scenario S1,S3] [--shots a.png,b.png] [--close]
  deskcheck mark <usId> [--force]        marca o campo Desk Check na história
  deskcheck pending                      lista as ações esperando OK
  deskcheck discard <código>             descarta uma ação
  deskcheck apply <código> [--validate-only]
                                         GRAVA no Azure. Só rode depois do OK explícito do usuário para esta ação.

Opções gerais:
  --root <pasta>      pasta dos desk checks (padrão ./.deskcheck)
  --dir <pasta>       pasta de um desk check (padrão <root>/<id>)
  --org <org>         organização (padrão ${DEFAULT_ORG}, ou DESKCHECK_ORG)
  --project <proj>    projeto (padrão ${DEFAULT_PROJECT}, ou DESKCHECK_PROJECT)
  --profile <pasta>   perfil do Chrome que guarda os logins (padrão ${DEFAULT_PROFILE})
  --headed            mostra a janela do Chrome também em card, whoami e apply (o run já mostra)
  --readonly          força o modo somente leitura (fora de localhost ele já liga sozinho)
  --allow-writes      libera escritas só para localhost e hosts de teste (dev, stg, uat...); o resto segue barrado na rede
  --json              saída em JSON

Precisa de Node 22+ e de Google Chrome, Chromium ou Edge (ou CHROME_PATH).`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (inline !== undefined) out[k] = inline;
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else {
        out[k] = next;
        i++;
      }
    }
  }
  return out;
}

const hasDisplay = () => !process.env.CI && (process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));

function openOnScreen(target) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : ['xdg-open', [target]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
  }
}

const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
const print = (s) => process.stdout.write(`${s}\n`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function excludeLocally(root) {
  let d = path.resolve(path.dirname(root));
  for (let i = 0; i < 8; i++) {
    const ex = path.join(d, '.git', 'info', 'exclude');
    if (existsSync(path.join(d, '.git', 'info'))) {
      const rel = `${path.relative(d, path.resolve(root)).split(path.sep).join('/')}/`;
      const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
      if (!cur.split('\n').includes(rel)) writeFileSync(ex, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${rel}\n`);
      return;
    }
    const up = path.dirname(d);
    if (up === d) return;
    d = up;
  }
}

function resolveDir(args, id) {
  if (typeof args.dir === 'string') return path.resolve(args.dir);
  const root = path.resolve(typeof args.root === 'string' ? args.root : '.deskcheck');
  if (id) return path.join(root, String(id));
  const dirs = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, 'results.json'))) : [];
  if (dirs.length === 1) return path.join(root, dirs[0].name);
  throw new DeskcheckError(dirs.length ? `há ${dirs.length} desk checks em ${root}: passe --dir.` : `nenhum results.json em ${root}: passe --dir ou rode deskcheck run.`);
}

function loadDir(dir) {
  const rp = path.join(dir, 'results.json');
  const cp = path.join(dir, 'card.json');
  const results = existsSync(rp) ? readJson(rp) : null;
  if (results) results.__dir = dir;
  return { results, card: existsSync(cp) ? readJson(cp) : null, resultsPath: rp };
}

function writeReports(dir, results, card) {
  const { __dir, ...clean } = results;
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify(clean, null, 2));
  writeFileSync(path.join(dir, 'report.md'), reportMarkdown(clean, card));
  writeFileSync(path.join(dir, 'report.html'), reportHtml(clean, card, dir));
}

function templatePlan(card) {
  const scenarios = [];
  let n = 0;
  for (const tc of card.testCases) {
    scenarios.push({
      id: `S${++n}`,
      title: tc.title,
      tc: [tc.id],
      ac: [],
      expected: tc.steps.map((s) => s.expected).filter(Boolean).join(' / '),
      steps: [{ do: 'goto', url: '/' }, { do: 'expectText', text: 'TODO' }, { do: 'screenshot', label: 'evidência' }],
    });
  }
  for (const ac of card.acceptanceCriteria) {
    scenarios.push({
      id: `S${++n}`,
      title: ac.text.split('\n')[0].slice(0, 90),
      ac: [ac.id],
      tc: [],
      expected: ac.text,
      steps: [{ do: 'goto', url: '/' }, { do: 'expectText', text: 'TODO' }, { do: 'screenshot', label: 'evidência' }],
    });
  }
  return {
    workItem: card.id,
    title: card.title,
    baseUrl: 'http://localhost:3000',
    viewport: { width: 1440, height: 900 },
    beforeEach: [],
    scenarios,
  };
}

async function azure(args, { allowWrite = false } = {}, fn) {
  const org = typeof args.org === 'string' ? args.org : DEFAULT_ORG;
  const project = typeof args.project === 'string' ? args.project : DEFAULT_PROJECT;
  const profileDir = typeof args.profile === 'string' ? path.resolve(args.profile) : DEFAULT_PROFILE;
  return withChrome({ profileDir, headless: !args.headed }, async (cdp) => {
    const transport = await browserTransport(cdp, { org });
    return fn(createAzure(transport, { org, project, allowWrite }));
  });
}

function showPending(a) {
  print(`\n${a.preview}\n`);
  print(`Código: ${a.code}  (vale 1 hora)`);
  print(`Nada foi gravado no Azure. Mostre a prévia ao usuário; só depois do OK dele para ESTA ação rode:`);
  print(`  deskcheck apply ${a.code}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...pos] = args._;
  if (!cmd || args.help || args.h || cmd === 'help') {
    print(HELP);
    process.exit(cmd || args.help || args.h ? 0 : 1);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22 || typeof WebSocket !== 'function') throw new DeskcheckError(`precisa de Node 22 ou mais novo (este é ${process.versions.node}).`);
  const profileDir = typeof args.profile === 'string' ? path.resolve(args.profile) : DEFAULT_PROFILE;
  const root = path.resolve(typeof args.root === 'string' ? args.root : '.deskcheck');

  switch (cmd) {
    case 'login': {
      const url = typeof args.url === 'string' ? args.url : `${orgUrl(typeof args.org === 'string' ? args.org : DEFAULT_ORG)}/`;
      await loginWindow(url, profileDir);
      print('Confira com: deskcheck whoami');
      return;
    }
    case 'whoami': {
      const me = await azure(args, {}, (az) => az.whoami());
      print(args.json ? JSON.stringify(me) : `Logado no Azure DevOps como ${me.name}.`);
      return;
    }
    case 'card': {
      const id = Number(pos[0]);
      if (!id) throw new DeskcheckError('uso: deskcheck card <id>');
      const card = await azure(args, {}, (az) => fetchCard(az, id));
      const dir = resolveDir(args, id);
      mkdirSync(dir, { recursive: true });
      if (!args.dir) excludeLocally(root);
      writeFileSync(path.join(dir, 'card.json'), JSON.stringify(card, null, 2));
      const md = cardMarkdown(card);
      writeFileSync(path.join(dir, 'card.md'), md);
      const tpl = path.join(dir, 'plan.template.json');
      if (!existsSync(path.join(dir, 'plan.json'))) writeFileSync(tpl, JSON.stringify(templatePlan(card), null, 2));
      if (args.json) print(JSON.stringify(card, null, 2));
      else {
        print(md);
        print(`Arquivos: ${path.join(dir, 'card.md')} · card.json${existsSync(tpl) ? ' · plan.template.json (copie para plan.json e complete)' : ''}`);
      }
      return;
    }
    case 'run': {
      if (typeof args.plan !== 'string') throw new DeskcheckError('uso: deskcheck run --plan <plan.json> [--url <tela>]');
      const planPath = path.resolve(args.plan);
      if (!existsSync(planPath)) throw new DeskcheckError(`plano não encontrado: ${planPath}`);
      let plan;
      try {
        plan = readJson(planPath);
      } catch (e) {
        throw new DeskcheckError(`plano com JSON inválido: ${e.message}`);
      }
      const errs = validatePlan(plan);
      if (errs.length) throw new DeskcheckError(`plano inválido:\n- ${errs.join('\n- ')}`);
      const dir = typeof args.out === 'string' ? path.resolve(args.out) : typeof args.dir === 'string' ? path.resolve(args.dir) : path.dirname(planPath);
      mkdirSync(dir, { recursive: true });
      const only = list(args.only);
      const viewport = args.width || args.height ? { ...(args.width ? { width: Number(args.width) } : {}), ...(args.height ? { height: Number(args.height) } : {}) } : undefined;
      const headed = args.headless ? false : args.headed ? true : hasDisplay();
      const fresh = await runPlan(plan, {
        baseUrl: typeof args.url === 'string' ? args.url : undefined,
        outDir: dir,
        planDir: path.dirname(planPath),
        headed,
        slowMo: args.slow !== undefined ? Math.max(0, Number(args.slow) || 0) : undefined,
        only,
        profileDir,
        viewport,
        readonly: args.readonly ? true : args['allow-writes'] ? false : 'auto',
        log: (s) => process.stderr.write(s),
      });
      const { results: prev, card } = loadDir(dir);
      let results = fresh;
      if (only.length && prev) {
        const byId = new Map(fresh.scenarios.map((s) => [s.id, s]));
        const merged = prev.scenarios.map((s) => byId.get(s.id) || s);
        for (const s of fresh.scenarios) if (!merged.includes(s)) merged.push(s);
        results = { ...fresh, startedAt: prev.startedAt, scenarios: merged, summary: summarize(merged) };
      }
      writeReports(dir, results, card);
      if (args.json) {
        print(JSON.stringify(results, null, 2));
        return;
      }
      const v = verdictOf(results);
      print(`\n${statusIcon(v.kind)} ${v.text}`);
      for (const sc of results.scenarios) print(`  ${statusIcon(sc.verdict || sc.status)} ${sc.id} ${sc.title}${sc.error ? ` — passo ${sc.failedStep}: ${sc.error}` : ''}`);
      print(`\nRelatório: ${path.join(dir, 'report.html')} · report.md · results.json · shots/`);
      if (headed && !args['no-open']) openOnScreen(path.join(dir, 'report.html'));
      print('Abra os prints em shots/ e confira o que as asserções não cobrem; ajuste "verdict"/"note" em results.json e rode deskcheck report.');
      return;
    }
    case 'explore': {
      const url = pos[0];
      if (!url) throw new DeskcheckError('uso: deskcheck explore <url> [--out <pasta>]');
      const outDir = path.resolve(typeof args.out === 'string' ? args.out : path.join(root, 'explore'));
      mkdirSync(outDir, { recursive: true });
      const r = await explore(url, {
        outDir,
        headed: Boolean(args.headed),
        profileDir,
        width: Number(args.width) || 1440,
        height: Number(args.height) || 900,
        readonly: args.readonly ? true : args['allow-writes'] ? false : undefined,
      });
      if (args.json) return print(JSON.stringify(r, null, 2));
      print(exploreSummary(r));
      print(`\nArquivos: ${path.join(outDir, 'explore.json')} · explore.png`);
      return;
    }
    case 'verdict': {
      const id = pos[0];
      const status = String(args.status || '');
      if (!id || !['pass', 'warn', 'fail', 'blocked', 'auto'].includes(status)) {
        throw new DeskcheckError('uso: deskcheck verdict <cenário> --status pass|warn|fail|blocked|auto [--note "..."] [--dir <pasta>]');
      }
      const dir = resolveDir(args);
      const { results, card } = loadDir(dir);
      if (!results) throw new DeskcheckError(`sem results.json em ${dir}`);
      const sc = results.scenarios.find((x) => x.id === id);
      if (!sc) throw new DeskcheckError(`cenário ${id} não está em ${dir}/results.json`);
      sc.verdict = status === 'auto' ? null : status;
      if (typeof args.note === 'string') sc.note = args.note;
      results.summary = summarize(results.scenarios);
      writeReports(dir, results, card);
      print(`${id}: ${status === 'auto' ? `volta ao automático (${sc.status})` : status}${typeof args.note === 'string' ? ' · observação gravada' : ''}`);
      print(`${statusIcon(verdictOf(results).kind)} ${verdictOf(results).text}`);
      return;
    }
    case 'role': {
      const action = pos[0];
      if (!['backup', 'set', 'restore', 'status'].includes(action)) throw new DeskcheckError('uso: deskcheck role <backup|set|restore|status> <id> --url <tela de usuários> [--roles a,b] [--role-title <id>] [--dir <pasta>]');
      const dir = typeof args.dir === 'string' ? path.resolve(args.dir) : path.join(path.resolve(typeof args.root === 'string' ? args.root : '.deskcheck'), String(pos[1] || ''));
      if (typeof args.dir !== 'string' && !pos[1]) throw new DeskcheckError('informe o id do card ou --dir.');
      const roles = await imp('roles.mjs');
      if (action === 'status') {
        const st = roles.roleStatus(dir);
        print(args.json ? JSON.stringify(st) : st.text);
        if (st.state === 'pending') process.exitCode = 3;
        return;
      }
      const saved = roles.readBackup(dir);
      const url = typeof args.url === 'string' ? args.url : saved?.url;
      if (!url) throw new DeskcheckError('informe --url com a tela de usuários (ex.: https://<ambiente de teste>/admin/users).');
      const out = await roles.withRoleSession(url, { profileDir: typeof args.profile === 'string' ? path.resolve(args.profile) : DEFAULT_PROFILE, log: (s) => process.stderr.write(s) }, ({ session, fetchImpl }) => {
        if (action === 'backup') return roles.backupRole({ dir, url, session, fetchImpl });
        if (action === 'set') return roles.setRole({ dir, url, session, fetchImpl, roles: String(args.roles || '').split(',').map((x) => x.trim()).filter(Boolean), roleTitleId: typeof args['role-title'] === 'string' ? args['role-title'] : undefined });
        return roles.restoreRole({ dir, session, fetchImpl });
      });
      if (action === 'backup') print(out.created ? `Backup salvo em ${path.join(dir, roles.ROLE_FILE)}: ${out.backup.original.roles.join(', ')}` : `Backup anterior mantido (restauração pendente): ${out.backup.original.roles.join(', ')}`);
      else if (action === 'set') print(`Papel trocado para ${out.now.roles.join(', ')} (original guardado: ${out.backup.original.roles.join(', ')}). Rode "deskcheck role restore" ao terminar.`);
      else print(out.already ? 'Já estava restaurado.' : `Papel original restaurado e conferido: ${out.now.roles.join(', ')}`);
      return;
    }
    case 'report': {
      const dir = resolveDir(args, pos[0]);
      const { results, card } = loadDir(dir);
      if (!results) throw new DeskcheckError(`sem results.json em ${dir}`);
      for (const sc of results.scenarios) {
        if (sc.verdict && !['pass', 'fail', 'warn', 'blocked'].includes(sc.verdict)) throw new DeskcheckError(`verdict inválido em ${sc.id}: use pass, fail, warn ou blocked`);
      }
      results.summary = summarize(results.scenarios);
      writeReports(dir, results, card);
      print(args.json ? JSON.stringify(results.summary) : `${statusIcon(verdictOf(results).kind)} ${verdictOf(results).text}\nRelatório: ${path.join(dir, 'report.html')}`);
      if (args.open) openOnScreen(path.join(dir, 'report.html'));
      return;
    }
    case 'defect': {
      const usId = Number(pos[0]);
      if (!usId || typeof args.scenario !== 'string') throw new DeskcheckError('uso: deskcheck defect <usId> --scenario S2');
      const dir = resolveDir(args, usId);
      const { results, card } = loadDir(dir);
      if (!results) throw new DeskcheckError(`sem results.json em ${dir}: rode deskcheck run antes.`);
      const action = buildDefect({
        card,
        results,
        scenarioId: args.scenario,
        title: typeof args.title === 'string' ? args.title : undefined,
        expected: typeof args.expected === 'string' ? args.expected : undefined,
        actual: typeof args.actual === 'string' ? args.actual : undefined,
        steps: typeof args.steps === 'string' ? args.steps.split('|').map((s) => s.trim()).filter(Boolean) : undefined,
        front: typeof args.front === 'string' ? args.front : undefined,
        textField: typeof args['text-field'] === 'string' ? args['text-field'] : undefined,
        shots: list(args.shots),
      });
      showPending(savePending(dir, action));
      return;
    }
    case 'evidence': {
      const tcId = Number(pos[0]);
      if (!tcId) throw new DeskcheckError('uso: deskcheck evidence <tcId> [--scenario S1] [--close]');
      let dir;
      if (args.dir) dir = path.resolve(args.dir);
      else {
        const hits = existsSync(root)
          ? readdirSync(root, { withFileTypes: true })
              .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, 'results.json')))
              .map((d) => path.join(root, d.name))
              .filter((d) => {
                const { results, card } = loadDir(d);
                return results.scenarios.some((s) => s.tc.includes(tcId)) || card?.testCases?.some((t) => t.id === tcId);
              })
          : [];
        if (hits.length !== 1) throw new DeskcheckError(hits.length ? `TC ${tcId} aparece em mais de um desk check: passe --dir.` : `não achei o TC ${tcId} em ${root}: passe --dir.`);
        dir = hits[0];
      }
      const { results, card } = loadDir(dir);
      const action = buildEvidence({ card, results, tcId, scenarioIds: list(args.scenario), shots: list(args.shots), close: Boolean(args.close) });
      showPending(savePending(dir, action));
      return;
    }
    case 'mark': {
      const usId = Number(pos[0]);
      if (!usId) throw new DeskcheckError('uso: deskcheck mark <usId>');
      const dir = resolveDir(args, usId);
      const { results, card } = loadDir(dir);
      if (!results) throw new DeskcheckError(`sem results.json em ${dir}: rode deskcheck run antes.`);
      showPending(savePending(dir, buildMark({ card, results, force: Boolean(args.force) })));
      return;
    }
    case 'pending': {
      const all = listPending(typeof args.dir === 'string' ? path.resolve(args.dir) : root);
      if (args.json) return print(JSON.stringify(all.map(({ preview, code, kind, createdAt, target }) => ({ code, kind, createdAt, target, preview })), null, 2));
      if (!all.length) return print('Nenhuma ação esperando OK.');
      for (const a of all) print(`${a.code} · ${a.kind} · ${a.createdAt.slice(11, 16)}\n${a.preview}\n`);
      return;
    }
    case 'discard': {
      const a = discardPending(typeof args.dir === 'string' ? path.resolve(args.dir) : root, pos[0]);
      print(`Ação ${a.code} descartada.`);
      return;
    }
    case 'apply': {
      if (!pos[0]) throw new DeskcheckError('uso: deskcheck apply <código>');
      const a = findPending(typeof args.dir === 'string' ? path.resolve(args.dir) : root, pos[0]);
      const validateOnly = Boolean(args['validate-only']);
      const result = await azure(args, { allowWrite: !validateOnly }, (az) => applyAction(az, a, { validateOnly }));
      if (validateOnly) return print(`Ação ${a.code} validada pelo Azure sem gravar nada. Para gravar (após o OK): deskcheck apply ${a.code}`);
      if (hasDisplay() && !args['no-open'] && result.url) openOnScreen(result.url);
      if (a.kind === 'defect') {
        const rp = path.join(a.dir, 'results.json');
        markDefectInResults(rp, a.target.scenario, result.id);
        const { results, card } = loadDir(a.dir);
        writeReports(a.dir, results, card);
        print(`Defect ${result.id} criado: ${result.url}`);
      } else if (a.kind === 'evidence') print(`Evidência comentada no TC ${a.payload.tcId}${result.closed ? ' e TC fechado' : ''}: ${result.url}`);
      else print(`Desk Check marcado: ${result.url}`);
      return;
    }
    default:
      throw new DeskcheckError(`comando desconhecido: ${cmd}. Veja deskcheck --help`);
  }
}

main().catch((e) => {
  process.stderr.write(`deskcheck: ${e instanceof DeskcheckError ? e.message : e.stack || e.message || e}\n`);
  process.exit(1);
});
