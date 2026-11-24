import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { finalStatus, statusIcon, summarize } from './runner.mjs';

const LABEL = {
  pass: 'Passou',
  warn: 'Ressalva',
  fail: 'Falhou',
  blocked: 'Bloqueado',
  skipped: 'Não executado',
  nottestable: 'Não testável',
  none: 'Sem cenário',
};
const LABEL_LONG = { ...LABEL, warn: 'Passou com ressalva' };
const SEVERITY = { fail: 4, blocked: 3, warn: 2, pass: 1 };

export function verdictOf(results) {
  const s = summarize(results.scenarios);
  if (s.fail) return { kind: 'fail', text: `Reprovado: ${s.fail} de ${s.total} cenário${s.total > 1 ? 's' : ''} com falha` };
  if (s.blocked) return { kind: 'blocked', text: `Incompleto: ${s.blocked} cenário${s.blocked > 1 ? 's' : ''} não pôde ser executado` };
  if (s.warn) return { kind: 'warn', text: `Aprovado com ${s.warn} ressalva${s.warn > 1 ? 's' : ''}` };
  return { kind: 'pass', text: `Aprovado: ${s.total} de ${s.total} cenário${s.total > 1 ? 's' : ''} passaram` };
}

const refKey = (r) => String(r).trim().toUpperCase().replace(/^TC\s*/, 'TC ');

export function coverage(results, card) {
  if (!card) return null;
  const nt = new Map((results.notTestable || []).map((n) => [refKey(n.ref), n.reason]));
  const worst = (scs) => scs.map(finalStatus).sort((a, b) => (SEVERITY[b] || 0) - (SEVERITY[a] || 0))[0];
  const row = (key, text, scs) => {
    if (scs.length) return { key, text, status: worst(scs), scenarios: scs.map((s) => s.id) };
    if (nt.has(refKey(key))) return { key, text, status: 'nottestable', reason: nt.get(refKey(key)), scenarios: [] };
    return { key, text, status: 'none', scenarios: [] };
  };
  const acs = card.acceptanceCriteria.map((a) => row(a.id, a.text, results.scenarios.filter((s) => s.ac.includes(a.id))));
  const tcs = card.testCases.map((t) => row(`TC ${t.id}`, t.title, results.scenarios.filter((s) => s.tc.includes(t.id))));
  return {
    acs,
    tcs,
    acMissing: acs.filter((r) => r.status === 'none'),
    tcMissing: tcs.filter((r) => r.status === 'none'),
    notTestable: [...acs, ...tcs].filter((r) => r.status === 'nottestable'),
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const headOf = (results, card) => (card ? `${card.type} ${card.id} · ${card.title}` : results.title || (results.workItem ? `Item ${results.workItem}` : 'Desk check'));
const when = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');

export function reportMarkdown(results, card) {
  const v = verdictOf(results);
  const s = summarize(results.scenarios);
  const L = [`# Desk check · ${headOf(results, card)}`, ''];
  if (card) L.push(`Card: ${card.url}`);
  L.push(`Tela: ${results.baseUrl || '-'} · ${results.viewport.width}×${results.viewport.height} · ${when(results.finishedAt)}${results.readonly ? ' · somente leitura (escritas barradas na rede)' : ''}`, '');
  L.push(`**${statusIcon(v.kind)} ${v.text}** (${s.pass} ok · ${s.warn} ressalvas · ${s.fail} falhas · ${s.blocked} bloqueados)`, '');
  L.push('| Cenário | Critério / TC | Resultado | Observação |', '|---|---|---|---|');
  for (const sc of results.scenarios) {
    const st = finalStatus(sc);
    const refs = [...sc.ac, ...sc.tc.map((t) => `TC ${t}`)].join(', ') || '-';
    const notes = sc.note || (sc.error ? `passo ${sc.failedStep}: ${sc.error}` : '');
    const defects = sc.defects?.length ? ` (Defect ${sc.defects.join(', ')})` : '';
    L.push(`| ${sc.id} · ${md(sc.title)} | ${refs} | ${statusIcon(st)} ${LABEL_LONG[st]}${sc.verdict && sc.verdict !== sc.status ? ' (revisado)' : ''}${defects} | ${md(notes) || '-'} |`);
  }
  L.push('');
  const cov = coverage(results, card);
  if (cov) {
    if (cov.notTestable.length) {
      L.push('## Não testável', '');
      for (const r of cov.notTestable) L.push(`- ${r.key}: ${r.text.split('\n')[0]} — ${r.reason}`);
      L.push('');
    }
    if (cov.acMissing.length || cov.tcMissing.length) {
      L.push('## Sem cenário', '');
      for (const r of [...cov.acMissing, ...cov.tcMissing]) L.push(`- ${r.key}: ${r.text.split('\n')[0]}`);
      L.push('');
    }
  }
  for (const sc of results.scenarios) {
    const st = finalStatus(sc);
    L.push(`## ${statusIcon(st)} ${sc.id} · ${sc.title}`, '');
    if (sc.expected) L.push(`Esperado: ${sc.expected}`, '');
    for (const step of sc.steps) {
      if (step.status === 'skipped') continue;
      L.push(`${step.n}. ${statusIcon(step.status)} ${step.desc}${step.detail ? ` → ${step.detail}` : ''}${step.error ? ` — **${step.error}**` : ''}${step.shot ? ` (print: shots/${step.shot})` : ''}`);
    }
    if (sc.note) L.push('', `Observação: ${sc.note}`);
    for (const r of sc.references || []) L.push(r.file ? `Referência: shots/${r.file} (${r.label})` : `Referência não encontrada: ${r.missing}`);
    if (sc.console.length) L.push('', `Erros no console (${sc.console.length}):`, ...sc.console.slice(0, 8).map((c) => `- ${c.text.split('\n')[0].slice(0, 200)}`));
    if (sc.network.length) L.push('', `Requisições com erro (${sc.network.length}):`, ...sc.network.slice(0, 8).map((n) => `- ${n.method || ''} ${n.url.slice(0, 160)} → ${n.status || n.error}`));
    if (sc.blockedRequests?.length) L.push('', `Escritas barradas pelo modo somente leitura (${sc.blockedRequests.length}, não chegaram ao servidor):`, ...sc.blockedRequests.slice(0, 8).map((n) => `- ${n.method} ${n.url.slice(0, 160)}`));
    L.push('');
  }
  return L.join('\n');
}

const ICON = {
  pass: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  fail: '<path d="M7 7l10 10M17 7L7 17"/>',
  warn: '<path d="M12 8v5"/><path d="M12 16.5v.01"/>',
  blocked: '<path d="M7 12h10"/>',
  skipped: '<path d="M8 12h8" opacity=".5"/>',
  nottestable: '<path d="M9.5 9.5a2.5 2.5 0 114 2c-.8.5-1.5 1-1.5 2"/><path d="M12 16.5v.01"/>',
  none: '<path d="M8 12h8"/>',
};
const icon = (st, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICON[st] || ICON.none}</svg>`;
const pill = (st, extra = '') => `<span class="pill s-${st}">${icon(st)}${esc(LABEL[st])}${extra}</span>`;

function img(dir, file) {
  const light = path.join(dir, 'shots', 'web', file.replace(/\.png$/i, '.jpg'));
  if (existsSync(light)) return `data:image/jpeg;base64,${readFileSync(light).toString('base64')}`;
  const p = path.join(dir, 'shots', file);
  if (!existsSync(p)) return '';
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.svg' ? 'image/svg+xml' : 'image/png';
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`;
}

function figure(src, rawLabel, tag) {
  if (!src) return '';
  const label = String(rawLabel || '').replace(/^falha\s+/i, 'Falha · ');
  return `<figure class="shot"><button type="button" class="zoom" data-zoom aria-label="Ampliar: ${esc(label)}"><img loading="lazy" src="${src}" alt="${esc(label)}"></button><figcaption>${tag ? `<span class="tag">${esc(tag)}</span>` : ''}${esc(label)}</figcaption></figure>`;
}

function scenarioHtml(sc, dir) {
  const st = finalStatus(sc);
  const revised = sc.verdict && sc.verdict !== sc.status;
  const refs = [...sc.ac.map((a) => `<span class="chip">${esc(a)}</span>`), ...sc.tc.map((t) => `<span class="chip">TC ${esc(t)}</span>`)].join('');
  const steps = sc.steps
    .filter((x) => x.status !== 'skipped')
    .map(
      (x) => `<li class="step s-${x.status}${x.setup ? ' setup' : ''}"><span class="dot">${icon(x.status, 'ico sm')}</span><div class="step-body"><span class="step-text">${esc(x.desc)}</span>${x.detail ? `<span class="step-detail">→ ${esc(x.detail)}</span>` : ''}${x.error ? `<div class="step-error">${esc(x.error)}</div>` : ''}</div>${x.ms !== undefined ? `<span class="ms">${x.ms < 1000 ? `${x.ms} ms` : `${(x.ms / 1000).toFixed(1)} s`}</span>` : ''}</li>`,
    )
    .join('');
  const skipped = sc.steps.filter((x) => x.status === 'skipped').length;
  const refsImgs = (sc.references || []).filter((r) => r.file);
  const missingRefs = (sc.references || []).filter((r) => r.missing);
  const screen = refsImgs.length ? sc.shots.find((sh) => !/falha/.test(sh.file)) || sc.shots[0] : null;
  const shots = sc.shots.filter((sh) => sh !== screen).map((sh) => figure(img(dir, sh.file), sh.label)).join('');
  let compare = '';
  if (refsImgs.length) {
    compare = `<div class="compare">${refsImgs.map((r) => figure(img(dir, r.file), r.label, 'Referência')).join('')}${screen ? figure(img(dir, screen.file), screen.label, 'Tela') : ''}</div>`;
  }
  const logs = [
    sc.console.length ? `<details><summary>Erros no console <b>${sc.console.length}</b></summary><ul class="mono">${sc.console.map((c) => `<li>${esc(c.text.slice(0, 400))}</li>`).join('')}</ul></details>` : '',
    sc.network.length ? `<details><summary>Requisições com erro <b>${sc.network.length}</b></summary><ul class="mono">${sc.network.map((n) => `<li><span class="code">${esc(n.status || n.error)}</span> ${esc(n.method || '')} ${esc(n.url)}</li>`).join('')}</ul></details>` : '',
    sc.blockedRequests?.length ? `<details><summary>Escritas barradas (somente leitura) <b>${sc.blockedRequests.length}</b></summary><ul class="mono">${sc.blockedRequests.map((n) => `<li><span class="code">${esc(n.method)}</span> ${esc(n.url)}</li>`).join('')}</ul></details>` : '',
  ].join('');
  return `<article id="${esc(sc.id)}" class="scenario s-${st}" data-status="${st}">
  <header class="sc-head">
    <div class="sc-title"><span class="sc-id">${esc(sc.id)}</span><h3>${esc(sc.title)}</h3></div>
    ${pill(st, revised ? '<span class="rev" title="Veredito revisado depois de olhar os prints">revisado</span>' : '')}
  </header>
  ${refs ? `<div class="chips">${refs}</div>` : ''}
  ${sc.expected ? `<p class="expected"><span class="lbl">Esperado</span>${esc(sc.expected)}</p>` : ''}
  ${sc.note ? `<div class="note n-${st}"><span class="lbl">Observação</span>${esc(sc.note)}</div>` : ''}
  ${sc.defects?.length ? `<p class="defects">Defect aberto: ${sc.defects.map((d) => `<b>${esc(d)}</b>`).join(', ')}</p>` : ''}
  ${compare}
  <ol class="steps">${steps}</ol>
  ${skipped ? `<p class="muted small">${skipped} passo${skipped > 1 ? 's' : ''} não executado${skipped > 1 ? 's' : ''} depois da falha.</p>` : ''}
  ${missingRefs.map((r) => `<p class="muted small">Referência não encontrada: ${esc(r.missing)}</p>`).join('')}
  ${shots ? `<div class="gallery">${shots}</div>` : ''}
  ${logs ? `<div class="logs">${logs}</div>` : ''}
</article>`;
}

function coverageHtml(cov, kind, title) {
  const rows = cov[kind];
  if (!rows.length) return '';
  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  const summary = ['pass', 'warn', 'fail', 'blocked', 'nottestable', 'none'].filter((k) => counts[k]).map((k) => `<span class="mini s-${k}">${icon(k, 'ico sm')}${counts[k]} ${esc(LABEL[k].toLowerCase())}</span>`).join('');
  return `<section class="panel cov">
  <div class="panel-head"><h2>${esc(title)}</h2><div class="minis">${summary}</div></div>
  <div class="cov-list">${rows
    .map(
      (r) => `<div class="cov-row s-${r.status}"><span class="cov-key">${esc(r.key)}</span><div class="cov-text"><span>${esc(r.text.split('\n')[0])}</span>${r.reason ? `<span class="reason">${esc(r.reason)}</span>` : ''}</div><div class="cov-res">${pill(r.status)}${r.scenarios.length ? `<span class="links">${r.scenarios.map((id) => `<a href="#${esc(id)}">${esc(id)}</a>`).join(' ')}</span>` : ''}</div></div>`,
    )
    .join('')}</div>
</section>`;
}

export function reportHtml(results, card, dir) {
  const v = verdictOf(results);
  const s = summarize(results.scenarios);
  const cov = coverage(results, card);
  const host = (() => {
    try {
      return new URL(results.baseUrl).host || results.baseUrl;
    } catch {
      return results.baseUrl || '';
    }
  })();
  const seg = ['pass', 'warn', 'fail', 'blocked'].filter((k) => s[k]).map((k) => `<span class="seg s-${k}" style="flex:${s[k]}" title="${s[k]} ${esc(LABEL[k].toLowerCase())}"></span>`).join('');
  const tiles = ['pass', 'warn', 'fail', 'blocked'].map((k) => `<div class="tile s-${k}${s[k] ? '' : ' zero'}"><span class="tile-n">${s[k] || 0}</span><span class="tile-l">${esc(k === 'warn' ? 'Ressalvas' : k === 'pass' ? 'Passaram' : k === 'fail' ? 'Falharam' : 'Bloqueados')}</span></div>`).join('');
  const filters = [['all', 'Todos', s.total], ['fail', 'Falhas', s.fail], ['warn', 'Ressalvas', s.warn], ['blocked', 'Bloqueados', s.blocked], ['pass', 'Passaram', s.pass]]
    .filter(([k, , n]) => k === 'all' || n)
    .map(([k, l, n], i) => `<button type="button" class="filter${i === 0 ? ' on' : ''}" data-filter="${k}" aria-pressed="${i === 0}">${esc(l)} <span>${n}</span></button>`)
    .join('');
  const meta = [
    card ? `<a class="meta-chip" href="${esc(card.url)}" target="_blank" rel="noopener">${esc(card.type)} ${esc(card.id)} ↗</a>` : '',
    card?.state ? `<span class="meta-chip">${esc(card.state)}</span>` : '',
    results.readonly ? '<span class="meta-chip ro">Somente leitura</span>' : '',
    host ? `<span class="meta-chip">${esc(host)}</span>` : '',
    `<span class="meta-chip">${results.viewport.width}×${results.viewport.height}</span>`,
    `<span class="meta-chip">${esc(when(results.finishedAt))}</span>`,
  ].join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Desk check ${esc(card?.id ?? results.workItem ?? '')}</title>
<style>
:root{--bg:#f6f5f2;--surface:#fff;--surface-2:#f1efea;--fg:#1c1b19;--muted:#6d6a63;--line:#e3e0d9;--accent:#2f5fd0;
--pass:#1d7a45;--pass-bg:#e4f3ea;--warn:#9a6200;--warn-bg:#fbf0d9;--fail:#c0352b;--fail-bg:#fbe7e4;--blocked:#5b55b5;--blocked-bg:#ecebfa;--na:#6d6a63;--na-bg:#eeece7;
--shadow:0 1px 2px rgba(28,27,25,.06),0 4px 16px rgba(28,27,25,.05);--r:14px;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121211;--surface:#1b1b19;--surface-2:#232320;--fg:#ecebe6;--muted:#a19e96;--line:#2f2f2b;--accent:#7ea2ff;
--pass:#62cf8b;--pass-bg:#16301f;--warn:#f0bf55;--warn-bg:#352a12;--fail:#ff8a7b;--fail-bg:#3a1c18;--blocked:#aaa6ff;--blocked-bg:#24224a;--na:#a19e96;--na-bg:#262622;--shadow:none;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#121211;--surface:#1b1b19;--surface-2:#232320;--fg:#ecebe6;--muted:#a19e96;--line:#2f2f2b;--accent:#7ea2ff;
--pass:#62cf8b;--pass-bg:#16301f;--warn:#f0bf55;--warn-bg:#352a12;--fail:#ff8a7b;--fail-bg:#3a1c18;--blocked:#aaa6ff;--blocked-bg:#24224a;--na:#a19e96;--na-bg:#262622;--shadow:none;color-scheme:dark}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 72px}
.s-pass{--c:var(--pass);--cb:var(--pass-bg)}.s-warn{--c:var(--warn);--cb:var(--warn-bg)}.s-fail{--c:var(--fail);--cb:var(--fail-bg)}.s-blocked{--c:var(--blocked);--cb:var(--blocked-bg)}
.s-skipped,.s-nottestable,.s-none{--c:var(--na);--cb:var(--na-bg)}
.ico{width:14px;height:14px;flex:none}.ico.sm{width:12px;height:12px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 6px}
h1{font-size:clamp(22px,3vw,30px);line-height:1.2;margin:0 0 12px;font-weight:700;letter-spacing:-.01em;text-wrap:balance}
.meta{display:flex;flex-wrap:wrap;gap:6px}
.meta-chip{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;padding:3px 10px;border-radius:999px;background:var(--surface);border:1px solid var(--line);color:var(--muted);text-decoration:none}
a.meta-chip{color:var(--accent);font-weight:600}.meta-chip.ro{color:var(--pass);border-color:color-mix(in srgb,var(--pass) 35%,transparent);background:var(--pass-bg);font-weight:600}
.theme{flex:none;border:1px solid var(--line);background:var(--surface);color:var(--muted);border-radius:999px;width:36px;height:36px;cursor:pointer;display:grid;place-items:center}
.theme:hover{color:var(--fg)}
.hero{margin:22px 0;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:20px;display:grid;grid-template-columns:1fr auto;gap:20px;align-items:center;position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0 auto 0 0;width:5px;background:var(--c)}
.verdict{display:flex;gap:14px;align-items:center}
.badge{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;background:var(--cb);color:var(--c);flex:none}.badge .ico{width:24px;height:24px}
.verdict h2{margin:0;font-size:20px;line-height:1.25;color:var(--c)}
.verdict p{margin:2px 0 0;color:var(--muted);font-size:13.5px}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(84px,1fr));gap:8px}
.tile{background:var(--cb);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column}
.tile.zero{background:var(--surface-2)}.tile.zero .tile-n{color:var(--muted)}
.tile-n{font-size:24px;font-weight:700;line-height:1.1;color:var(--c);font-variant-numeric:tabular-nums}
.tile-l{font-size:12px;color:var(--muted)}
.bar{grid-column:1/-1;display:flex;gap:3px;height:8px;border-radius:999px;overflow:hidden;background:var(--surface-2)}
.seg{background:var(--c)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:18px 20px;margin:0 0 18px}
.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.panel h2{font-size:16px;margin:0}
.minis{display:flex;flex-wrap:wrap;gap:6px}
.mini{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--c);background:var(--cb);border-radius:999px;padding:2px 8px;font-weight:600}
.cov-list{display:flex;flex-direction:column}
.cov-row{display:grid;grid-template-columns:76px 1fr auto;gap:12px;align-items:center;padding:9px 0;border-top:1px solid var(--line)}
.cov-row:first-child{border-top:0}
.cov-key{font:600 12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.cov-text{display:flex;flex-direction:column;font-size:14px}
.reason{font-size:12.5px;color:var(--muted)}
.cov-res{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.links{display:flex;gap:4px}.links a{font:600 12px ui-monospace,Menlo,monospace;text-decoration:none;background:var(--surface-2);border-radius:6px;padding:1px 6px;color:var(--fg)}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:650;padding:3px 10px;border-radius:999px;background:var(--cb);color:var(--c);white-space:nowrap}
.rev{font-weight:500;opacity:.8;border-left:1px solid currentColor;padding-left:6px;margin-left:2px}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:26px 0 12px}
.toolbar h2{font-size:18px;margin:0}
.filters{display:flex;gap:6px;flex-wrap:wrap}
.filter{border:1px solid var(--line);background:var(--surface);color:var(--fg);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.filter span{color:var(--muted);font-variant-numeric:tabular-nums;margin-left:2px}
.filter.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}.filter.on span{color:inherit;opacity:.7}
.scenario{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:18px 20px 18px 24px;margin:0 0 14px;position:relative;scroll-margin-top:16px}
.scenario::before{content:"";position:absolute;left:0;top:14px;bottom:14px;width:4px;border-radius:0 4px 4px 0;background:var(--c)}
.scenario[hidden]{display:none}
.sc-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.sc-title{display:flex;gap:10px;align-items:baseline;min-width:0}
.sc-id{font:700 13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);flex:none}
.sc-title h3{margin:0;font-size:16.5px;line-height:1.35}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 0}
.chip{font:600 11.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);color:var(--muted);border-radius:6px;padding:2px 7px}
.lbl{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:2px}
.expected{margin:12px 0 0;font-size:14px}
.note{margin:12px 0 0;font-size:14px;background:var(--cb);border-radius:10px;padding:10px 12px}
.note.n-pass{background:var(--surface-2)}
.note .lbl{color:var(--c)}
.defects{font-size:13.5px;margin:10px 0 0}
.steps{list-style:none;margin:14px 0 0;padding:0;position:relative}
.step{display:grid;grid-template-columns:22px 1fr auto;gap:10px;align-items:start;padding:5px 0;position:relative}
.step:not(:last-child)::after{content:"";position:absolute;left:10px;top:24px;bottom:-6px;width:2px;background:var(--line)}
.dot{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:var(--cb);color:var(--c);position:relative;z-index:1}
.step.setup .step-text{color:var(--muted)}
.step-body{display:flex;flex-direction:column;font-size:14px;padding-top:1px;min-width:0}
.step-detail{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.step-error{margin-top:4px;font-size:13px;color:var(--fail);background:var(--fail-bg);border-radius:8px;padding:6px 9px;overflow-wrap:anywhere}
.step.s-warn .step-error{color:var(--warn);background:var(--warn-bg)}.step.s-blocked .step-error{color:var(--blocked);background:var(--blocked-bg)}
.ms{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums;padding-top:3px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-top:14px}
.compare{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:14px;padding:12px;background:var(--surface-2);border-radius:12px}
.shot{margin:0}
.zoom{display:block;width:100%;padding:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface-2);cursor:zoom-in}
.zoom img{display:block;width:100%;height:auto;transition:transform .2s ease}
.zoom:hover img{transform:scale(1.015)}
.zoom:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
figcaption{font-size:12.5px;color:var(--muted);margin-top:5px;display:flex;gap:6px;align-items:center}
.tag{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:var(--fg);color:var(--bg);border-radius:4px;padding:1px 5px}
.logs{margin-top:12px;display:flex;flex-direction:column;gap:6px}
details{background:var(--surface-2);border-radius:10px;padding:8px 12px}
summary{cursor:pointer;font-size:13px;color:var(--muted)}summary b{color:var(--fg);font-weight:600}
.mono{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;padding-left:18px;margin:8px 0 2px}
.code{font-weight:700}
.muted{color:var(--muted)}.small{font-size:12.5px}
footer{margin-top:28px;color:var(--muted);font-size:12.5px;text-align:center}
dialog.lb{border:0;padding:0;background:transparent;max-width:min(96vw,1600px);max-height:96vh}
dialog.lb::backdrop{background:rgba(10,10,9,.82)}
.lb-inner{display:flex;flex-direction:column;gap:8px;align-items:center}
.lb img{max-width:min(96vw,1600px);max-height:86vh;border-radius:10px;display:block;background:#222}
.lb-bar{display:flex;gap:10px;align-items:center;color:#eee;font-size:13px}
.lb button{border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#fff;border-radius:999px;padding:6px 12px;font:inherit;cursor:pointer}
@media (max-width:760px){.hero{grid-template-columns:1fr}.tiles{grid-template-columns:repeat(2,1fr)}.cov-row{grid-template-columns:1fr;gap:4px}.cov-res{justify-content:flex-start}.sc-head{flex-direction:column}}
@media print{body{background:#fff}.theme,.filters,dialog{display:none!important}.scenario,.panel,.hero{box-shadow:none;break-inside:avoid}.scenario[hidden]{display:block}details{display:none}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <p class="eyebrow">Desk check</p>
      <h1>${esc(card ? card.title : headOf(results, card))}</h1>
      <div class="meta">${meta}</div>
    </div>
    <button type="button" class="theme" id="theme" aria-label="Alternar tema claro/escuro" title="Alternar tema"><svg class="ico" style="width:18px;height:18px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg></button>
  </div>

  <section class="hero s-${v.kind}" aria-label="Veredito">
    <div class="verdict"><span class="badge">${icon(v.kind)}</span><div><h2>${esc(v.text)}</h2><p>${s.total} cenário${s.total > 1 ? 's' : ''} · ${results.readonly ? 'escritas barradas na rede' : 'execução local'}${card?.acceptanceCriteria?.length ? ` · ${card.acceptanceCriteria.length} critérios de aceite` : ''}</p></div></div>
    <div class="tiles">${tiles}</div>
    <div class="bar" aria-hidden="true">${seg}</div>
  </section>

  ${cov ? coverageHtml(cov, 'acs', 'Critérios de aceite') + coverageHtml(cov, 'tcs', 'Test Cases') : ''}

  <div class="toolbar"><h2>Cenários</h2><div class="filters" role="group" aria-label="Filtrar cenários">${filters}</div></div>
  ${results.scenarios.map((sc) => scenarioHtml(sc, dir)).join('\n')}

  <footer>Gerado pelo deskcheck · ${esc(when(results.finishedAt))}${results.baseUrl ? ` · ${esc(results.baseUrl)}` : ''}</footer>
</div>

<dialog class="lb" id="lb" aria-label="Imagem ampliada">
  <div class="lb-inner"><img id="lb-img" alt=""><div class="lb-bar"><button type="button" id="lb-prev" aria-label="Anterior">←</button><span id="lb-cap"></span><button type="button" id="lb-next" aria-label="Próxima">→</button><button type="button" id="lb-close">Fechar</button></div></div>
</dialog>

<script>
(() => {
  const root = document.documentElement;
  const KEY = 'deskcheck-theme';
  try { const t = localStorage.getItem(KEY); if (t) root.dataset.theme = t; } catch (e) {}
  document.getElementById('theme').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem(KEY, root.dataset.theme); } catch (e) {}
  });

  const cards = [...document.querySelectorAll('.scenario')];
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    const f = b.dataset.filter;
    cards.forEach((c) => { c.hidden = f !== 'all' && c.dataset.status !== f; });
  }));

  const lb = document.getElementById('lb'), lbImg = document.getElementById('lb-img'), lbCap = document.getElementById('lb-cap');
  const zooms = [...document.querySelectorAll('[data-zoom]')];
  let at = 0;
  const show = (i) => {
    at = (i + zooms.length) % zooms.length;
    const im = zooms[at].querySelector('img');
    lbImg.src = im.src; lbImg.alt = im.alt;
    lbCap.textContent = (at + 1) + ' / ' + zooms.length + ' · ' + im.alt;
  };
  zooms.forEach((z, i) => z.addEventListener('click', () => { show(i); if (typeof lb.showModal === 'function') lb.showModal(); else window.open(z.querySelector('img').src); }));
  document.getElementById('lb-prev').addEventListener('click', () => show(at - 1));
  document.getElementById('lb-next').addEventListener('click', () => show(at + 1));
  document.getElementById('lb-close').addEventListener('click', () => lb.close());
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
  document.addEventListener('keydown', (e) => {
    if (!lb.open) return;
    if (e.key === 'ArrowLeft') show(at - 1);
    if (e.key === 'ArrowRight') show(at + 1);
  });
})();
</script>
</body>
</html>`;
}
