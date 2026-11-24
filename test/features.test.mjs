import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { chromeCandidates } from '../src/cdp.mjs';
import { buildDraftPlan } from '../src/explore.mjs';
import { coverage, reportHtml, reportJunit, reportMarkdown, azurePreviewHtml } from '../src/report.mjs';
import { parseDecideScore, parseDecideYesNo, runDecisionCheck } from '../src/decide.mjs';
import { runPlan, validatePlan } from '../src/runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'deskcheck.mjs');
const hasChrome = chromeCandidates().some((p) => existsSync(p));
const fixtures = `${pathToFileURL(path.join(here, 'fixtures')).href}/`;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');

test('plano: reference e notTestable são validados', () => {
  assert.deepEqual(validatePlan({ scenarios: [{ id: 'S1', title: 't', steps: [], reference: 'a.png' }], notTestable: [{ ref: 'AC-1', reason: 'x' }] }), []);
  assert.match(validatePlan({ scenarios: [{ id: 'S1', title: 't', steps: [], reference: {} }] }).join(), /reference/);
  assert.match(validatePlan({ scenarios: [{ id: 'S1', title: 't', steps: [] }], notTestable: [{ ref: 'AC-1' }] }).join(), /notTestable/);
});

test('cobertura: pior status por critério, não testável com motivo e sem cenário', () => {
  const card = { acceptanceCriteria: [{ id: 'AC-1', text: 'a' }, { id: 'AC-2', text: 'b' }, { id: 'AC-3', text: 'c' }], testCases: [{ id: 9, title: 't' }] };
  const results = {
    notTestable: [{ ref: 'AC-2', reason: 'precisa do CMS' }, { ref: 'tc 9', reason: 'CMS' }],
    scenarios: [
      { id: 'S1', ac: ['AC-1'], tc: [], status: 'pass', verdict: null },
      { id: 'S2', ac: ['AC-1'], tc: [], status: 'pass', verdict: 'warn' },
    ],
  };
  const c = coverage(results, card);
  assert.equal(c.acs[0].status, 'warn');
  assert.deepEqual(c.acs[0].scenarios, ['S1', 'S2']);
  assert.equal(c.acs[1].status, 'nottestable');
  assert.equal(c.acs[1].reason, 'precisa do CMS');
  assert.equal(c.acs[2].status, 'none');
  assert.equal(c.tcs[0].status, 'nottestable');
});

test('run: referência copiada, cópia JPEG para o relatório e sem print final repetido; verdict pela CLI', { skip: !hasChrome && 'sem Chrome', timeout: 120_000 }, async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-feat-'));
  writeFileSync(path.join(out, 'figma.png'), PNG);
  const plan = {
    title: 'Demo',
    notTestable: [{ ref: 'AC-9', reason: 'fora do escopo' }],
    scenarios: [{ id: 'S1', title: 'Lista', reference: { file: 'figma.png', label: 'Figma: lista' }, steps: [{ do: 'goto', url: 'demo.html' }, { do: 'screenshot', label: 'lista' }] }],
  };
  const r = await runPlan(plan, { baseUrl: fixtures, outDir: out, planDir: out, profileDir: path.join(out, 'chrome') });
  const sc = r.scenarios[0];
  assert.deepEqual(sc.shots.map((s) => s.label), ['lista'], 'não deve haver print "final" repetido');
  assert.ok(existsSync(path.join(out, 'shots', 'web', sc.shots[0].file.replace('.png', '.jpg'))), 'cópia JPEG');
  assert.equal(sc.references[0].label, 'Figma: lista');
  assert.ok(existsSync(path.join(out, 'shots', sc.references[0].file)));
  assert.deepEqual(r.notTestable, [{ ref: 'AC-9', reason: 'fora do escopo' }]);
  const html = reportHtml(r, null, out);
  assert.match(html, /data:image\/jpeg;base64,/);
  assert.match(html, /Referência/);
  assert.match(html, /data-cmode="diff"/);
  assert.match(html, /data-diff-canvas/);
  assert.match(html, /@media print\{[\s\S]*:root\[data-theme="dark"\][\s\S]*color-scheme:light/);

  writeFileSync(path.join(out, 'results.json'), JSON.stringify(r));
  const outp = execFileSync(process.execPath, [bin, 'verdict', 'S1', '--status', 'warn', '--note', 'texto cortado', '--dir', out], { encoding: 'utf8' });
  assert.match(outp, /S1: warn/);
  const saved = JSON.parse(readFileSync(path.join(out, 'results.json'), 'utf8'));
  assert.equal(saved.scenarios[0].verdict, 'warn');
  assert.equal(saved.scenarios[0].note, 'texto cortado');
  assert.ok(existsSync(path.join(out, 'report.html')));
  execFileSync(process.execPath, [bin, 'verdict', 'S1', '--status', 'auto', '--dir', out]);
  assert.equal(JSON.parse(readFileSync(path.join(out, 'results.json'), 'utf8')).scenarios[0].verdict, null);
});

test('explore: títulos, controles com nome acessível, data-testid e print', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-explore-'));
  const json = execFileSync(process.execPath, [bin, 'explore', `${fixtures}demo.html`, '--out', out, '--profile', path.join(out, 'chrome'), '--json'], { encoding: 'utf8' });
  const r = JSON.parse(json);
  assert.equal(r.readonly, false);
  assert.ok(r.headings.some((h) => h.text === 'Pending for final review'));
  assert.ok(r.controls.some((c) => c.role === 'button' && c.name === 'Apply'));
  assert.ok(r.controls.some((c) => c.role === 'combobox' && c.name === 'Filter by status'));
  assert.equal(r.testids.row, 3);
  assert.ok(existsSync(path.join(out, 'explore.png')));
});

test('press: aceita combinações com modificadores (ex.: Shift+Tab, Ctrl+A)', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-press-'));
  const plan = {
    title: 'Press modifiers',
    scenarios: [
      {
        id: 'S1',
        title: 'Selecionar e apagar com modificador',
        steps: [
          { do: 'goto', url: 'demo.html' },
          { do: 'fill', label: 'Search partner', value: 'Alpha' },
          { do: 'press', key: `${process.platform === 'darwin' ? 'Meta' : 'Ctrl'}+A Backspace` },
          { do: 'expectValue', label: 'Search partner', value: '' },
        ],
      },
    ],
  };
  const r = await runPlan(plan, { baseUrl: fixtures, outDir: out, profileDir: path.join(out, 'chrome') });
  assert.equal(r.scenarios[0].status, 'pass', r.scenarios[0].error);
});

test('evidências: marcações automáticas dos passos e auditoria visual determinística (overflow, imagem quebrada, texto cortado, a11y)', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-audit-'));
  const htmlPage = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; font: 14px sans-serif; }
    .wide { width: 1600px; height: 20px; background: #eee; }
    .clip { width: 70px; overflow: hidden; white-space: nowrap; }
  </style>
  <div class="wide">Estoura largura</div>
  <div class="clip">Texto muito longo que fica cortado na caixa estreita</div>
  <img src="nao-existe-404.png" alt="Logo quebrado" width="40" height="40">
  <button type="button" id="ok-btn">Confirmar</button>
  <button type="button" style="width:24px;height:24px"></button>`;
  writeFileSync(path.join(out, 'audit.html'), htmlPage);
  const plan = {
    title: 'Auditoria visual',
    viewport: { width: 1000, height: 600 },
    scenarios: [
      {
        id: 'S1',
        title: 'Detecta problemas visuais e anota elementos',
        steps: [
          { do: 'goto', url: 'audit.html' },
          { do: 'click', role: 'button', name: 'Confirmar' },
          { do: 'expectText', text: 'Confirmar' },
          { do: 'screenshot', label: 'tela auditada' },
        ],
      },
    ],
  };
  const r = await runPlan(plan, { baseUrl: `${pathToFileURL(out).href}/`, outDir: out, profileDir: path.join(out, 'chrome') });
  const sc = r.scenarios[0];
  assert.equal(sc.status, 'pass', sc.error);
  assert.ok(sc.shots[0].marks?.length >= 1, 'deve gravar marcações automáticas no print');
  assert.ok(sc.audit, 'deve executar auditoria visual automática');
  assert.ok(sc.audit.horizontalOverflow?.overflowPx > 100, 'deve detectar overflow horizontal');
  assert.equal(sc.audit.brokenImages.length, 1, 'deve detectar imagem quebrada');
  assert.ok(sc.audit.clippedText.length >= 1, 'deve detectar texto cortado');
  assert.ok(sc.audit.unnamedControls.length >= 1, 'deve detectar botão sem nome acessível');
  const html = reportHtml(r, null, out);
  assert.match(html, /Saúde visual/);
  assert.match(html, /Auditoria visual automática/);
  assert.match(html, /data-marks-toggle/);
});

test('auditoria visual: modal aberto não gera falso positivo de sobreposição nos botões de fundo', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-modal-'));
  const htmlPage = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 24px; font: 14px sans-serif; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none; place-items: center; }
    .backdrop.open { display: grid; }
    .dialog { background: #fff; padding: 24px; border-radius: 12px; }
  </style>
  <button type="button" id="open">Abrir modal</button>
  <button type="button" id="bg">Botão de fundo</button>
  <div class="backdrop" id="bd"><div class="dialog" role="dialog" aria-modal="true"><p>Conteúdo do modal</p><button type="button" id="close">Fechar</button></div></div>
  <script>document.getElementById('open').onclick = () => document.getElementById('bd').classList.add('open');</script>`;
  writeFileSync(path.join(out, 'modal.html'), htmlPage);
  const plan = {
    title: 'Modal audit',
    viewport: { width: 1000, height: 600 },
    scenarios: [
      {
        id: 'S1',
        title: 'Abre modal sem falso positivo de sobreposição',
        steps: [
          { do: 'goto', url: 'modal.html' },
          { do: 'click', role: 'button', name: 'Abrir modal' },
          { do: 'expectText', text: 'Conteúdo do modal' },
          { do: 'screenshot', label: 'modal aberto' },
        ],
      },
    ],
  };
  const r = await runPlan(plan, { baseUrl: `${pathToFileURL(out).href}/`, outDir: out, profileDir: path.join(out, 'chrome') });
  const sc = r.scenarios[0];
  assert.equal(sc.status, 'pass', sc.error);
  assert.equal(sc.audit.overlappedControls.length, 0, `falso positivo: ${JSON.stringify(sc.audit.overlappedControls)}`);
  assert.equal(sc.audit.total, 0);
});

test('alta confiança: Shadow DOM aberto, espera botão disabled habilitar e fill substitui input[type=number]', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-shadow-'));
  const page = `<!doctype html><meta charset="utf-8"><div id="host"></div><p id="res"></p>
  <script>
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="qty" type="number" aria-label="Quantidade" value="999"><button id="go" disabled>Salvar</button>';
    const btn = root.getElementById('go');
    setTimeout(() => { btn.disabled = false; }, 350);
    btn.onclick = () => { document.getElementById('res').textContent = 'OK:' + root.getElementById('qty').value; };
  </script>`;
  writeFileSync(path.join(out, 'shadow.html'), page);
  const plan = {
    title: 'Shadow DOM + Actionability',
    scenarios: [
      {
        id: 'S1',
        title: 'Preenche input number no Shadow DOM e clica após habilitar',
        steps: [
          { do: 'goto', url: 'shadow.html' },
          { do: 'fill', label: 'Quantidade', value: '42' },
          { do: 'click', role: 'button', name: 'Salvar' },
          { do: 'expectText', text: 'OK:42' },
        ],
      },
    ],
  };
  const r = await runPlan(plan, { baseUrl: `${pathToFileURL(out).href}/`, outDir: out, profileDir: path.join(out, 'chrome') });
  assert.equal(r.scenarios[0].status, 'pass', r.scenarios[0].error);
});

test('alta confiança: expectRequest valida contrato da API, --strict rebaixa imagem quebrada e relatório traz índice de confiança', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, async () => {
  const page = `<!doctype html><meta charset="utf-8">
    <button id="load">Filtrar</button><p id="out">idle</p>
    <img id="broken" src="/missing-404.png" alt="quebrada" width="32" height="32">
    <script>
      document.getElementById('load').onclick = async () => {
        const r = await fetch('/api/partners?status=approve');
        document.getElementById('out').textContent = 'status ' + r.status;
      };
    </script>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/') return res.end(page);
    if (req.url.startsWith('/api/partners')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end('{"items":[1,2]}');
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-strict-'));
  try {
    const plan = {
      title: 'API + Strict',
      strict: true,
      scenarios: [
        {
          id: 'S1',
          title: 'Dispara chamada esperada e strict sinaliza imagem quebrada',
          steps: [
            { do: 'click', role: 'button', name: 'Filtrar' },
            { do: 'expectRequest', method: 'GET', urlContains: 'status=approve', status: 200 },
            { do: 'expectText', text: 'status 200' },
          ],
        },
      ],
    };
    const r = await runPlan(plan, { baseUrl: base, outDir: out, profileDir: path.join(out, 'chrome') });
    const sc = r.scenarios[0];
    assert.equal(sc.status, 'warn', `esperava warn em modo strict, veio ${sc.status}`);
    assert.ok(sc.strictReasons?.some((x) => /imagem/i.test(x)));
    assert.ok(sc.requests?.some((req) => req.url.includes('status=approve') && req.status === 200));
    const md = reportMarkdown(r, null);
    const html = reportHtml(r, null, out);
    assert.match(md, /Confiança:/);
    assert.match(html, /Confiança/);
    assert.match(html, /Requisições registradas/);
  } finally {
    server.close();
  }
});

test('upload de arquivo, diálogos nativos (alert/confirm) e iframe same-origin', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, async () => {
  const childPage = `<!doctype html><meta charset="utf-8">
    <label for="frame-note">Nota interna</label>
    <input id="frame-note" type="text" value="">
    <button id="frame-save">Salvar no frame</button>
    <p id="frame-out"></p>
    <script>
      document.getElementById('frame-save').onclick = () => {
        document.getElementById('frame-out').textContent = 'Frame salvo: ' + document.getElementById('frame-note').value;
      };
    </script>`;
  const mainPage = `<!doctype html><meta charset="utf-8">
    <label for="doc-file">Anexo PDF</label>
    <input id="doc-file" type="file" style="display:none">
    <p id="file-out">sem arquivo</p>
    <button id="ask">Excluir item</button>
    <p id="dlg-out">nenhum</p>
    <iframe src="/frame" width="420" height="160" style="border:1px solid #ccc;display:block;margin-top:16px"></iframe>
    <script>
      document.getElementById('doc-file').addEventListener('change', (e) => {
        const names = [...e.target.files].map((f) => f.name).join(', ');
        document.getElementById('file-out').textContent = 'Arquivo: ' + names;
      });
      document.getElementById('ask').onclick = () => {
        const ok = window.confirm('Deseja confirmar?');
        document.getElementById('dlg-out').textContent = ok ? 'confirmado' : 'cancelado';
      };
    </script>`;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/frame') return res.end(childPage);
    return res.end(mainPage);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-up-dlg-'));
  const sampleFile = path.join(out, 'comprovante.txt');
  writeFileSync(sampleFile, 'conteudo-teste');
  try {
    const plan = {
      title: 'Upload + Dialog + Iframe',
      scenarios: [
        {
          id: 'S1',
          title: 'Envia arquivo oculto, responde confirm e interage no iframe',
          steps: [
            { do: 'upload', label: 'Anexo PDF', file: 'comprovante.txt' },
            { do: 'expectText', text: 'Arquivo: comprovante.txt' },
            { do: 'dialog', action: 'dismiss' },
            { do: 'click', role: 'button', name: 'Excluir item' },
            { do: 'expectText', text: 'cancelado' },
            { do: 'dialog', action: 'accept' },
            { do: 'click', role: 'button', name: 'Excluir item' },
            { do: 'expectText', text: 'confirmado' },
            { do: 'fill', label: 'Nota interna', value: 'Aprovado' },
            { do: 'click', role: 'button', name: 'Salvar no frame' },
            { do: 'expectText', text: 'Frame salvo: Aprovado' },
          ],
        },
      ],
    };
    const r = await runPlan(plan, { baseUrl: base, outDir: out, planDir: out, profileDir: path.join(out, 'chrome') });
    assert.equal(r.scenarios[0].status, 'pass', r.scenarios[0].error || '');
    assert.equal(r.scenarios[0].dialogs?.length, 2);
    assert.equal(r.scenarios[0].dialogs[0].action, 'dismiss');
    assert.equal(r.scenarios[0].dialogs[1].action, 'accept');
  } finally {
    server.close();
  }
});

test('retries recupera cenário flaky e reportJunit + --fail-on-error integram com CI', { skip: !hasChrome && 'sem Chrome', timeout: 60_000 }, async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/flaky') {
      hits++;
      return res.end(`<!doctype html><meta charset="utf-8"><p>${hits >= 2 ? 'Carregou OK' : 'Erro temporario'}</p>`);
    }
    return res.end('<!doctype html><meta charset="utf-8"><p>Tela fixa</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-ci-'));
  try {
    const flakyPlan = {
      title: 'Flaky + Retry',
      retries: 1,
      scenarios: [
        { id: 'S1', title: 'Recupera na segunda tentativa', steps: [{ do: 'goto', url: '/flaky' }, { do: 'expectText', text: 'Carregou OK', timeout: 1000 }] },
      ],
    };
    const r = await runPlan(flakyPlan, { baseUrl: base, outDir: out, profileDir: path.join(out, 'chrome') });
    assert.equal(r.scenarios[0].status, 'pass');
    assert.equal(r.scenarios[0].flaky, true);
    assert.equal(r.scenarios[0].attempts, 2);
    const html = reportHtml(r, null, out);
    assert.match(html, /flaky · 2 tentativas/);

    const failPlanPath = path.join(out, 'fail-plan.json');
    const junitPath = path.join(out, 'junit.xml');
    writeFileSync(failPlanPath, JSON.stringify({
      title: 'CI Fail',
      scenarios: [
        { id: 'S1', title: 'Passa', steps: [{ do: 'expectText', text: 'Tela fixa' }] },
        { id: 'S2', title: 'Falha CI', steps: [{ do: 'expectText', text: 'Texto inexistente', timeout: 500 }] },
      ],
    }));
    let exitCode = 0;
    try {
      await execFileAsync(process.execPath, [bin, 'run', '--plan', failPlanPath, '--url', base, '--dir', out, '--profile', path.join(out, 'chrome-ci'), '--headless', '--fail-on-error', '--junit', junitPath]);
    } catch (err) {
      exitCode = err.code;
    }
    assert.equal(exitCode, 1);
    const xml = readFileSync(junitPath, 'utf8');
    assert.match(xml, /<testsuite[^>]*tests="2"[^>]*failures="1"/);
    assert.match(xml, /<failure message=/);
    const junitDirect = reportJunit(r, null);
    assert.match(junitDirect, /tests="1" failures="0"/);
  } finally {
    server.close();
  }
});

test('explore --draft gera rascunho de plano válido', () => {
  const draft = buildDraftPlan({
    url: 'http://localhost:3000/partners?tab=all',
    title: 'Partners',
    viewport: { width: 1280, height: 800 },
    headings: [{ level: 'H1', text: 'Partners list' }],
    testids: { row: 3, 'filter-bar': 1 },
    controls: [
      { role: 'searchbox', name: 'Search partner' },
      { role: 'button', name: 'Apply' },
    ],
  });
  assert.deepEqual(validatePlan(draft), []);
  assert.equal(draft.baseUrl, 'http://localhost:3000');
  assert.equal(draft.beforeEach[0].url, '/partners?tab=all');
  assert.equal(draft.scenarios.length, 2);
});

test('annotate + preview-azure: desenha marcações manuais sem alterar o PNG e gera prévia HTML estilo Azure Boards', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-ann-'));
  const shotsDir = path.join(out, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  writeFileSync(path.join(shotsDir, 'S1-01-ok.png'), PNG);
  writeFileSync(path.join(shotsDir, 'S2-01-clip.png'), PNG);
  const card = {
    id: 10042,
    url: 'https://dev.azure.com/org/proj/_workitems/edit/10042',
    type: 'User Story',
    title: '[FRONT] For You Widget',
    state: 'Waiting Tests',
    assignedTo: 'Dev User',
    areaPath: 'Proj\\Squad',
    iterationPath: 'Proj\\Squad\\Sprint 004',
    fronts: ['FRONT'],
    tags: [],
    parent: { id: 200001, type: 'Feature', title: '[Q4] Portal | Home', state: 'Execution', url: 'https://dev.azure.com/org/proj/_workitems/edit/200001' },
    acceptanceCriteria: [{ id: 'AC-1', text: 'Shows heading' }, { id: 'AC-2', text: 'Cards not clipped' }],
    testCases: [{ id: 253001, title: 'Heading check', state: 'Design' }, { id: 253002, title: 'Clip check', state: 'Design' }],
    defects: [],
  };
  const results = {
    version: 1,
    workItem: 10042,
    title: card.title,
    baseUrl: 'http://localhost:3000',
    viewport: { width: 1440, height: 900 },
    finishedAt: '2026-11-24T10:00:00.000Z',
    scenarios: [
      { id: 'S1', title: 'Heading OK', ac: ['AC-1'], tc: [253001], status: 'pass', verdict: null, note: 'OK', steps: [{ n: 1, do: 'screenshot', desc: 'Print', status: 'pass', shot: 'S1-01-ok.png' }], shots: [{ file: 'S1-01-ok.png', label: 'Hero OK' }], console: [], network: [] },
      { id: 'S2', title: 'Tablet clipped', ac: ['AC-2'], tc: [253002], status: 'fail', verdict: null, error: 'Clipped at 768px', expected: 'Cards visible', note: 'Cut in half at 768px', steps: [{ n: 1, do: 'expectEval', desc: 'Check height', status: 'fail', error: 'Clipped at 768px' }], shots: [{ file: 'S2-01-clip.png', label: 'Tablet 768px' }], console: [], network: [] },
    ],
  };
  writeFileSync(path.join(out, 'card.json'), JSON.stringify(card));
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(results));

  const annOut = execFileSync(
    process.execPath,
    [bin, 'annotate', 'S2', '--box', '5.5,28.6,87.5,5.8', '--label', 'Cards cortados em 768px', '--kind', 'fail', '--dir', out],
    { encoding: 'utf8' },
  );
  assert.match(annOut, /marcação #1 \(fail\) adicionada/);
  assert.deepEqual(readFileSync(path.join(shotsDir, 'S2-01-clip.png')), PNG, 'PNG original permanece intocado');

  const repHtml = readFileSync(path.join(out, 'report.html'), 'utf8');
  assert.match(repHtml, /s-mark-tip/);
  assert.match(repHtml, /Cards cortados em 768px/);

  const prevOut = execFileSync(
    process.execPath,
    [bin, 'preview-azure', '--scope', 'frontend', '--branch', 'origin/develop (2a53bc7)', '--repo', 'web-app', '--dir', out],
    { encoding: 'utf8' },
  );
  assert.match(prevOut, /azure-preview\.html/);
  const azHtml = readFileSync(path.join(out, 'azure-preview.html'), 'utf8');
  assert.match(azHtml, /PRÉVIA LOCAL DE PUBLICAÇÃO NO AZURE DEVOPS/);
  assert.match(azHtml, /Somente Frontend/);
  assert.match(azHtml, /Feature/);
  assert.match(azHtml, /200001/);
  assert.match(azHtml, /Cards cortados em 768px/);
  assert.match(azHtml, /Evidence of test:/);

  const direct = azurePreviewHtml(JSON.parse(readFileSync(path.join(out, 'results.json'), 'utf8')), card, out, { scope: 'frontend' });
  assert.match(direct, /DEF-01/);

  execFileSync(process.execPath, [bin, 'annotate', 'S2', '--clear', '--dir', out]);
  const cleared = JSON.parse(readFileSync(path.join(out, 'results.json'), 'utf8'));
  assert.equal(cleared.scenarios[1].shots[0].marks, undefined);
});

test('decide: parser de SIM/NÃO, score e runDecisionCheck sem depender de rede', async () => {
  const yn = parseDecideYesNo('NÃO  (prob. de sim: 3%, confiança: 97%)');
  assert.equal(yn.answer, 'NÃO');
  assert.equal(yn.yesProb, 3);
  assert.equal(yn.confidence, 97);

  const sc = parseDecideScore('score 2.58  (confiança: 66%)\n  0. baixa 1%\n  1. media 6%\n  2. alta 26%\n  3. muito_alta 66%');
  assert.equal(sc.score, 2.58);
  assert.equal(sc.topLabel, 'muito_alta');
  assert.equal(sc.highPct, 92);

  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-dec-'));
  writeFileSync(path.join(out, 'card.md'), '# US 1');
  writeFileSync(path.join(out, 'report.md'), '# Report');
  const calls = [];
  const res = await runDecisionCheck({
    dir: out,
    results: { scenarios: [] },
    scope: 'frontend',
    runner: async (args) => {
      calls.push(args);
      return args.includes('--score')
        ? 'score 2.66 (confiança: 75%)\n  0. baixa 2%\n  1. media 5%\n  2. alta 18%\n  3. muito_alta 75%'
        : 'NÃO (prob. de sim: 4%, confiança: 96%)';
    },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /somente|frontend/i);
  assert.equal(res.approve.answer, 'NÃO');
  assert.equal(res.approve.confidence, 96);
  assert.equal(res.accuracy.highPct, 93);
});
