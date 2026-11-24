import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyAction, buildDefect, buildEvidence, buildMark, findPending, listPending, savePending, verifyPending } from '../src/actions.mjs';
import { createAzure } from '../src/azure.mjs';

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-'));
  mkdirSync(path.join(dir, 'shots'));
  writeFileSync(path.join(dir, 'shots', 'S1-01-ok.png'), 'png1');
  writeFileSync(path.join(dir, 'shots', 'S2-01-falha.png'), 'png2');
  const card = {
    id: 500, type: 'User Story', title: 'Filters', areaPath: 'Area\\Squad', iterationPath: 'Iter\\Sprint 3',
    tags: ['[FRONT]'], fronts: ['FRONT'], acceptanceCriteria: [], testCases: [{ id: 900, title: 'TC', state: 'Design' }],
  };
  const results = {
    __dir: dir, baseUrl: 'http://localhost:3000', viewport: { width: 1440, height: 900 },
    scenarios: [
      { id: 'S1', title: 'Opens', ac: ['AC-1'], tc: [900], status: 'pass', verdict: null, steps: [{ n: 1, do: 'screenshot', desc: 'Print', status: 'pass', shot: 'S1-01-ok.png' }], shots: [{ file: 'S1-01-ok.png', label: 'ok' }] },
      { id: 'S2', title: 'Filter', ac: ['AC-2'], tc: [], status: 'fail', verdict: null, error: 'texto não aparece', steps: [{ n: 1, do: 'click', desc: 'Clicar em Apply', status: 'fail', shot: 'S2-01-falha.png' }], shots: [{ file: 'S2-01-falha.png', label: 'falha' }] },
    ],
  };
  return { dir, card, results };
}

function fakeTransport() {
  const calls = [];
  const t = async (method, url, opts) => {
    calls.push({ method, url, opts });
    if (url.includes('/attachments')) return { status: 201, type: 'application/json', text: JSON.stringify({ url: 'https://att/1?x=y' }) };
    if (url.includes('/comments')) return { status: 200, type: 'application/json', text: '{"id":7}' };
    if (url.includes('$Defect')) return { status: 200, type: 'application/json', text: '{"id":777}' };
    return { status: 200, type: 'application/json', text: '{"id":1}' };
  };
  return { t, calls };
}

test('Defect: Identified Tests, Area/Iteration/tags da história, pai e título com frente', () => {
  const { card, results } = fixture();
  const a = buildDefect({ card, results, scenarioId: 'S2' });
  const f = a.payload.fields;
  assert.equal(f['System.Title'], '[FRONT] Filter: texto não aparece');
  assert.equal(f['Custom.StepIdentifiedDefectStandard'], 'Tests');
  assert.equal(f['System.AreaPath'], 'Area\\Squad');
  assert.equal(f['System.IterationPath'], 'Iter\\Sprint 3');
  assert.equal(f['System.Tags'], '[FRONT]');
  assert.equal(a.payload.parentId, 500);
  assert.match(f[a.payload.textField], /\{\{att:S2-01-falha\.png\}\}/);
  assert.match(f[a.payload.textField], /Environment:<\/b> Local · http:\/\/localhost:3000/);

  results.baseUrl = 'https://app.example.com/dashboard';
  results.readonly = true;
  const remote = buildDefect({ card, results, scenarioId: 'S2' });
  assert.match(remote.payload.fields[remote.payload.textField], /Environment:<\/b> Remote \(read-only\) · https:\/\/app\.example\.com/);
});

test('Defect não é criado para cenário que passou', () => {
  const { card, results } = fixture();
  assert.throws(() => buildDefect({ card, results, scenarioId: 'S1' }), /passou/);
});

test('Evidência segue o padrão "Evidence of test:" e não fecha TC com cenário falho', () => {
  const { card, results } = fixture();
  const a = buildEvidence({ card, results, tcId: 900, close: true });
  assert.match(a.payload.html, /^<div>Evidence of test:<\/div><div><img src="\{\{att:S1-01-ok\.png\}\}"/);
  results.scenarios[0].status = 'fail';
  assert.throws(() => buildEvidence({ card, results, tcId: 900, close: true }), /não fecho/);
});

test('Marcar Desk Check exige Defect para cada falha (ou --force) e preenche os campos de Details do Azure', () => {
  const { card, results } = fixture();
  assert.throws(() => buildMark({ card, results }), /sem Defect/);
  results.scenarios[1].defects = [777];
  const m = buildMark({ card, results });
  const byPath = Object.fromEntries(m.payload.ops.map((o) => [o.path, o.value]));
  assert.equal(byPath['/fields/Custom.DeskCheckStandard'], true);
  assert.equal(m.payload.ops.length, 1);
  const custom = buildMark({ card, results, fields: [{ label: 'Desk Check', ref: 'Custom.DeskCheckStandard', value: true }, { label: 'Reviewed with', ref: 'Custom.ReviewTool', value: 'deskcheck' }] });
  assert.deepEqual(custom.payload.ops.map((o) => o.path), ['/fields/Custom.DeskCheckStandard', '/fields/Custom.ReviewTool']);
  assert.match(custom.preview, /Reviewed with \(Custom\.ReviewTool\): deskcheck/);
});

test('montar ações não chama o Azure; cliente sem allowWrite recusa escrita', async () => {
  const { dir, card, results } = fixture();
  const { t, calls } = fakeTransport();
  savePending(dir, buildDefect({ card, results, scenarioId: 'S2' }));
  savePending(dir, buildEvidence({ card, results, tcId: 900 }));
  assert.equal(calls.length, 0);
  const ro = createAzure(t);
  await assert.rejects(ro.createWorkItem('Defect', []), /escrita bloqueada/);
  await assert.rejects(ro.updateWorkItem(1, []), /escrita bloqueada/);
  await assert.rejects(ro.addComment(1, 'x'), /escrita bloqueada/);
  await assert.rejects(ro.uploadAttachment('a.png', Buffer.from('x')), /escrita bloqueada/);
  assert.equal(calls.length, 0);
});

test('nenhum módulo além de actions.applyAction chama as funções de escrita', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of ['bin/deskcheck.mjs', 'src/card.mjs', 'src/runner.mjs', 'src/report.mjs', 'src/report/html.mjs', 'src/report/quality.mjs', 'src/report/markdown.mjs', 'src/report/azure-preview.mjs', 'src/decide.mjs']) {
    const src = readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /\.(createWorkItem|updateWorkItem|addComment|uploadAttachment)\(/, f);
  }
  const bin = readFileSync(path.join(root, 'bin/deskcheck.mjs'), 'utf8');

  const uses = [...bin.matchAll(/allowWrite: !validateOnly/g)].length;
  assert.equal(uses, 1);
});

test('apply grava o Defect com pai, anexo e print no texto', async () => {
  const { dir, card, results } = fixture();
  const saved = savePending(dir, buildDefect({ card, results, scenarioId: 'S2' }));
  const a = findPending(dir, saved.code);
  const { t, calls } = fakeTransport();
  const r = await applyAction(createAzure(t, { allowWrite: true }), a);
  assert.equal(r.id, 777);
  const create = calls.find((c) => c.url.includes('$Defect'));
  const ops = create.opts.json;
  assert.ok(ops.some((o) => o.value?.rel === 'System.LinkTypes.Hierarchy-Reverse' && o.value.url.endsWith('/workItems/500')));
  assert.ok(ops.some((o) => o.value?.rel === 'AttachedFile'));
  assert.ok(ops.some((o) => typeof o.value === 'string' && o.value.includes('https://att/1?fileName=defect-500-S2-01-falha.png')));
  assert.equal(listPending(dir).length, 0);
});

test('ação alterada, velha ou com print trocado é recusada', () => {
  const { dir, card, results } = fixture();
  const saved = savePending(dir, buildEvidence({ card, results, tcId: 900 }));
  const file = path.join(dir, 'pending', `${saved.code}.json`);
  const a = findPending(dir, saved.code);
  assert.throws(() => verifyPending(a, Date.parse(a.createdAt) + 61 * 60 * 1000), /mais de 1 hora/);
  writeFileSync(path.join(dir, 'shots', 'S1-01-ok.png'), 'outro');
  assert.throws(() => verifyPending(findPending(dir, saved.code)), /print .* mudou/);
  const j = JSON.parse(readFileSync(file, 'utf8'));
  j.payload.close = true;
  writeFileSync(file, JSON.stringify(j));
  assert.throws(() => verifyPending(findPending(dir, saved.code)), /alterada/);
});
