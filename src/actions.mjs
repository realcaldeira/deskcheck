import { createHash, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DeskcheckError, isLocalUrl } from './cdp.mjs';
import { describeStep, finalStatus } from './runner.mjs';

export const MAX_AGE_MS = 60 * 60 * 1000;

export const DEFECT_TEXT_FIELD = process.env.DESKCHECK_DEFECT_FIELD || 'Microsoft.VSTS.TCM.ReproSteps';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newCode = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const sha = (s) => createHash('sha256').update(s).digest('hex');
const fileSha = (p) => sha(readFileSync(p));

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function attachmentsOf(dir, files) {
  return files.map((f) => {
    const p = path.join(dir, 'shots', f.file);
    if (!existsSync(p)) throw new DeskcheckError(`print não encontrado: ${p}`);
    return { file: f.file, label: f.label, uploadName: f.uploadName || f.file, sha256: fileSha(p) };
  });
}

function digest(action) {
  return sha(stable({ kind: action.kind, target: action.target, payload: action.payload, createdAt: action.createdAt }));
}

export function savePending(dir, { kind, target, preview, payload }) {
  const pdir = path.join(dir, 'pending');
  mkdirSync(pdir, { recursive: true });
  let code;
  do code = newCode();
  while (existsSync(path.join(pdir, `${code}.json`)));
  const action = { code, kind, target, createdAt: new Date().toISOString(), preview, payload };
  action.hash = digest(action);
  writeFileSync(path.join(pdir, `${code}.json`), JSON.stringify(action, null, 2));
  return action;
}

export function listPending(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const dirs = existsSync(path.join(root, 'pending')) ? [root] : readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
  for (const d of dirs) {
    const pdir = path.join(d, 'pending');
    if (!existsSync(pdir)) continue;
    for (const f of readdirSync(pdir).filter((x) => x.endsWith('.json'))) {
      try {
        const a = JSON.parse(readFileSync(path.join(pdir, f), 'utf8'));
        out.push({ ...a, dir: d, file: path.join(pdir, f) });
      } catch {

      }
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findPending(root, code) {
  const c = String(code || '').trim().toUpperCase();
  const hit = listPending(root).find((a) => a.code === c);
  if (!hit) throw new DeskcheckError(`ação ${c} não encontrada (já aplicada, descartada ou de outra pasta). Veja: deskcheck pending`);
  return hit;
}

export function verifyPending(a, now = Date.now()) {
  const { dir: _dir, file: _file, ...stored } = a;
  if (digest(stored) !== a.hash) throw new DeskcheckError(`a ação ${a.code} foi alterada depois de criada. Descarte e crie de novo.`);
  if (now - Date.parse(a.createdAt) > MAX_AGE_MS) throw new DeskcheckError(`a ação ${a.code} tem mais de 1 hora. Crie de novo para o usuário rever a prévia.`);
  for (const att of a.payload.attachments || []) {
    const p = path.join(a.dir, 'shots', att.file);
    if (!existsSync(p) || fileSha(p) !== att.sha256) throw new DeskcheckError(`o print ${att.file} mudou ou sumiu depois da prévia. Crie a ação de novo.`);
  }
  return a;
}

export function discardPending(root, code) {
  const a = findPending(root, code);
  rmSync(a.file);
  return a;
}

function scenarioById(results, id) {
  const sc = results.scenarios.find((s) => s.id === id);
  if (!sc) throw new DeskcheckError(`cenário ${id} não está em results.json (rode deskcheck run).`);
  return sc;
}

export function buildDefect({ card, results, scenarioId, title, expected, actual, steps, front, textField = DEFECT_TEXT_FIELD, shots }) {
  if (!card) throw new DeskcheckError('card.json não encontrado nesta pasta: rode deskcheck card <id> antes.');
  const sc = scenarioById(results, scenarioId);
  const st = finalStatus(sc);
  if (st === 'pass') throw new DeskcheckError(`o cenário ${sc.id} passou; Defect é para cenário com falha (ou ajuste o verdict em results.json).`);
  const fr = (front || card.fronts[0] || '').toUpperCase();
  if (!fr) throw new DeskcheckError('a história não tem tag de frente ([FRONT], [BACK]…): passe --front FRONT.');
  const baseTitle = title || `${sc.title}: ${sc.note || sc.error || 'falhou no desk check'}`;
  const fullTitle = `[${fr}] ${baseTitle.replace(/^\[[A-Z]+\]\s*/, '')}`.slice(0, 250);
  const stepList = steps?.length ? steps : sc.steps.filter((x) => x.status !== 'skipped' && x.do !== 'screenshot').map((x) => x.desc);
  const files = (shots?.length ? sc.shots.filter((s) => shots.includes(s.file)) : sc.shots.filter((s) => /falha/.test(s.file)).concat(sc.shots).slice(0, 2)).filter(
    (v, i, arr) => arr.findIndex((x) => x.file === v.file) === i,
  );
  const attachments = attachmentsOf(results.__dir, files.map((f) => ({ ...f, uploadName: `defect-${card.id}-${f.file}` })));
  const refs = [...sc.ac, ...sc.tc.map((t) => `TC ${t}`)].join(', ');
  const envLabel = !results.baseUrl || isLocalUrl(results.baseUrl) ? 'Local' : results.readonly ? 'Remote (read-only)' : 'Remote';
  const html = [
    `<div><b>Desk check</b> · ${esc(sc.id)} ${esc(sc.title)}${refs ? ` (${esc(refs)})` : ''}</div>`,
    `<div><b>Steps to reproduce:</b><ol>${stepList.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>`,
    `<div><b>Expected:</b> ${esc(expected || sc.expected || '-')}</div>`,
    `<div><b>Actual:</b> ${esc(actual || sc.note || sc.error || '-')}</div>`,
    `<div><b>Environment:</b> ${envLabel} · ${esc(results.baseUrl || '-')} · ${results.viewport.width}x${results.viewport.height}</div>`,
    attachments.length ? `<div><b>Evidence:</b></div>${attachments.map((a) => `<div><img src="{{att:${a.file}}}" alt="${esc(a.label)}"><br></div>`).join('')}` : '',
  ].join('');
  const fields = {
    'System.Title': fullTitle,
    'System.AreaPath': card.areaPath,
    'System.IterationPath': card.iterationPath,
    'System.Tags': card.tags.join('; '),
    'Custom.StepIdentifiedDefectStandard': 'Tests',
    [textField]: html,
  };
  return {
    kind: 'defect',
    target: { parentId: card.id, scenario: sc.id },
    preview: [
      `Criar Defect filho da ${card.type} ${card.id} (${card.title})`,
      `  Título: ${fullTitle}`,
      `  Area: ${card.areaPath}`,
      `  Iteration: ${card.iterationPath}`,
      `  Tags: ${card.tags.join('; ') || '-'}`,
      '  Identified (Step Identified Defect): Tests',
      `  Passos: ${stepList.length} · Esperado: ${expected || sc.expected || '-'}`,
      `  Obtido: ${actual || sc.note || sc.error || '-'}`,
      `  Prints anexados: ${attachments.map((a) => a.file).join(', ') || 'nenhum'}`,
    ].join('\n'),
    payload: { type: 'Defect', parentId: card.id, fields, textField, attachments },
  };
}

export function buildEvidence({ card, results, tcId, scenarioIds, shots, close }) {
  const tc = Number(tcId);
  const scs = (scenarioIds?.length ? scenarioIds : results.scenarios.filter((s) => s.tc.includes(tc)).map((s) => s.id)).map((id) => scenarioById(results, id));
  if (!scs.length) throw new DeskcheckError(`nenhum cenário ligado ao TC ${tc}: passe --scenario S1[,S2].`);
  const notOk = scs.filter((s) => !['pass', 'warn'].includes(finalStatus(s)));
  if (close && notOk.length) throw new DeskcheckError(`não fecho o TC ${tc}: o(s) cenário(s) ${notOk.map((s) => s.id).join(', ')} não passaram.`);
  let files = scs.flatMap((s) => s.shots);
  if (shots?.length) files = files.filter((f) => shots.includes(f.file));
  else {

    const marked = scs.flatMap((s) => s.steps.filter((x) => x.shot && x.status !== 'fail' && x.status !== 'blocked').map((x) => s.shots.find((f) => f.file === x.shot)).filter(Boolean));
    files = marked.length ? marked : scs.map((s) => s.shots.at(-1)).filter(Boolean);
  }
  if (!files.length) throw new DeskcheckError(`sem prints para o TC ${tc}.`);
  const attachments = attachmentsOf(results.__dir, files.map((f) => ({ ...f, uploadName: `tc-${tc}-${f.file}` })));

  const html = `<div>Evidence of test:</div>${attachments.map((a) => `<div><img src="{{att:${a.file}}}" alt=Image><br></div>`).join('')}`;
  const tcInfo = card?.testCases?.find((t) => t.id === tc);
  return {
    kind: 'evidence',
    target: { tcId: tc, scenarios: scs.map((s) => s.id) },
    preview: [
      `Evidência no Test Case ${tc}${tcInfo ? ` (${tcInfo.title}, estado ${tcInfo.state})` : ''}`,
      `  Comentário: "Evidence of test:" + ${attachments.length} print(s): ${attachments.map((a) => a.file).join(', ')}`,
      `  Cenários: ${scs.map((s) => `${s.id} (${finalStatus(s)})`).join(', ')}`,
      close ? `  Depois: mudar o estado para Closed${tcInfo && tcInfo.state !== 'Design' ? ` (hoje está em ${tcInfo.state})` : ''}` : '  Estado do TC: não muda',
    ].join('\n'),
    payload: { tcId: tc, html, close: Boolean(close), attachments },
  };
}

export const DEFAULT_MARK_FIELDS = [{ label: 'Desk Check', ref: 'Custom.DeskCheckStandard', value: true }];

export function buildMark({ card, results, force, fields = DEFAULT_MARK_FIELDS }) {
  if (!card) throw new DeskcheckError('card.json não encontrado nesta pasta: rode deskcheck card <id> antes.');
  const bad = results.scenarios.filter((s) => ['fail', 'blocked'].includes(finalStatus(s)) && !s.defects?.length);
  if (bad.length && !force) {
    throw new DeskcheckError(`não marco o Desk Check: ${bad.map((s) => s.id).join(', ')} falharam sem Defect aberto. Abra os Defects (deskcheck defect) ou use --force.`);
  }
  const list = (fields?.length ? fields : DEFAULT_MARK_FIELDS).filter((f) => f?.ref);
  const ops = list.map((f) => ({ op: 'add', path: `/fields/${f.ref}`, value: f.value }));
  return {
    kind: 'mark',
    target: { id: card.id },
    preview: [
      `Marcar Desk Check na ${card.type} ${card.id} (${card.title})`,
      ...list.map((f) => `  ${f.label || f.ref} (${f.ref}): ${f.value === true ? 'True' : f.value}`),
      ...(bad.length ? [`  Atenção: ${bad.length} cenário(s) com falha sem Defect (--force)`] : []),
    ].join('\n'),
    payload: { id: card.id, ops },
  };
}

async function uploadAll(az, a) {
  const urls = {};
  for (const att of a.payload.attachments || []) {
    const buf = readFileSync(path.join(a.dir, 'shots', att.file));
    urls[att.file] = `${await az.uploadAttachment(att.uploadName, buf)}?fileName=${encodeURIComponent(att.uploadName)}`;
  }
  return urls;
}
const fillAtt = (html, urls) => html.replace(/\{\{att:([^}]+)\}\}/g, (_, f) => urls[f] || '');

export async function applyAction(az, a, { validateOnly = false } = {}) {
  verifyPending(a);
  const p = a.payload;
  if (validateOnly) {

    if (a.kind === 'defect') {
      const ops = Object.entries(p.fields).map(([k, v]) => ({ op: 'add', path: `/fields/${k}`, value: fillAtt(String(v), {}) }));
      ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: az.apiUrl(p.parentId) } });
      await az.createWorkItem(p.type, ops, { validateOnly: true });
    } else if (a.kind === 'mark') await az.updateWorkItem(p.id, p.ops, { validateOnly: true });
    else if (a.kind === 'evidence') {
      await az.getWorkItem(p.tcId, { expand: '' });
      if (p.close) await az.updateWorkItem(p.tcId, [{ op: 'add', path: '/fields/System.State', value: 'Closed' }], { validateOnly: true });
    }
    return { validated: true };
  }
  let result;
  if (a.kind === 'defect') {
    const urls = await uploadAll(az, a);
    const ops = Object.entries(p.fields).map(([k, v]) => ({ op: 'add', path: `/fields/${k}`, value: k === p.textField ? fillAtt(v, urls) : v }));
    ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: az.apiUrl(p.parentId) } });
    for (const u of Object.values(urls)) ops.push({ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: u.split('?')[0] } });
    const created = await az.createWorkItem(p.type, ops);
    result = { id: created.id, url: az.link(created.id) };
  } else if (a.kind === 'evidence') {
    const urls = await uploadAll(az, a);
    const c = await az.addComment(p.tcId, fillAtt(p.html, urls));
    if (p.close) await az.updateWorkItem(p.tcId, [{ op: 'add', path: '/fields/System.State', value: 'Closed' }]);
    result = { commentId: c.id, url: az.link(p.tcId), closed: p.close };
  } else if (a.kind === 'mark') {
    await az.updateWorkItem(p.id, p.ops);
    result = { url: az.link(p.id) };
  } else throw new DeskcheckError(`tipo de ação desconhecido: ${a.kind}`);

  const adir = path.join(a.dir, 'applied');
  mkdirSync(adir, { recursive: true });
  const { dir: _d, file: _f, ...stored } = a;
  writeFileSync(path.join(adir, `${a.code}.json`), JSON.stringify({ ...stored, appliedAt: new Date().toISOString(), result }, null, 2));
  rmSync(a.file);
  return result;
}

export function markDefectInResults(resultsPath, scenarioId, defectId) {
  const r = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const sc = r.scenarios.find((s) => s.id === scenarioId);
  if (sc) {
    sc.defects = [...new Set([...(sc.defects || []), defectId])];
    const tmp = `${resultsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(r, null, 2));
    renameSync(tmp, resultsPath);
  }
}

export { describeStep };
