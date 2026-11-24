import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { finalStatus, summarize } from '../runner.mjs';
import { esc, headOf, verdictOf, when } from './quality.mjs';

const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function imgSrc(dir, file) {
  if (!file) return '';
  const light = path.join(dir, 'shots', 'web', file.replace(/\.png$/i, '.jpg'));
  if (existsSync(light)) return `data:image/jpeg;base64,${readFileSync(light).toString('base64')}`;
  const full = path.join(dir, 'shots', file);
  if (!existsSync(full)) return '';
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.svg' ? 'image/svg+xml' : 'image/png';
  return `data:${mime};base64,${readFileSync(full).toString('base64')}`;
}

function marksHtml(marks) {
  if (!Array.isArray(marks) || !marks.length) return '';
  const items = marks
    .map((m, i) => {
      const kind = m.kind === 'ok' || m.kind === 'assert' ? 'ok' : m.kind === 'warn' ? 'warn' : m.kind === 'dashed' ? 'err-dashed' : m.status === 'fail' || m.kind === 'fail' ? 'err' : 'info';
      const pin = m.pin || (m.step ? `#${m.step}` : String(i + 1));
      const pinCls = m.pinPos === 'right' ? 'ann-pin ann-pin-right' : 'ann-pin';
      const tipPos = m.pos === 'right' ? 'ann-tip-right' : m.pos === 'bottom-left' ? 'ann-tip-bottom-left' : 'ann-tip-bottom';
      return `<div class="ann-box ann-${kind}" style="left:${m.x}%;top:${m.y}%;width:${m.w}%;height:${m.h}%"><span class="${pinCls}">${esc(pin)}</span>${m.label ? `<span class="ann-tip ${tipPos}">${esc(m.label)}</span>` : ''}</div>`;
    })
    .join('');
  return `<div class="ann-layer" aria-hidden="true">${items}</div>`;
}

function scopeLabel(scope) {
  if (scope === 'frontend') return 'Somente Frontend';
  if (scope === 'backend') return 'Somente Backend';
  return 'Full Stack / Geral';
}

function buildDefectItems(results, card, pending = []) {
  const front = (card?.fronts?.[0] || 'FRONT').toUpperCase();
  const failed = (results.scenarios || []).filter((s) => ['fail', 'blocked'].includes(finalStatus(s)));
  const pendingByScenario = new Map(pending.filter((a) => a.kind === 'defect').map((a) => [a.target?.scenario, a]));
  return failed.map((sc, idx) => {
    const p = pendingByScenario.get(sc.id);
    const id = `DEF-${String(idx + 1).padStart(2, '0')}`;
    const rawTitle = p?.payload?.fields?.['System.Title'] || `[${front}] ${sc.title}`;
    const refs = [...(sc.ac || []), ...(sc.tc || []).map((t) => `TC ${t}`)].join(' · ') || sc.id;
    const stepItems = (sc.steps || []).filter((x) => x.status !== 'skipped' && x.do !== 'screenshot').map((x) => `<li>${esc(x.desc)}</li>`).join('');
    const actual = sc.note || sc.error || 'Scenario did not meet acceptance criteria.';
    const expected = sc.expected || 'Expected behavior as defined in the user story acceptance criteria.';
    const bodyHtml = p?.payload?.fields?.[p.payload.textField]
      ? p.payload.fields[p.payload.textField].replace(/<div><img[^>]*><br><\/div>/gi, '')
      : `<p><b>Steps to reproduce</b></p><ol>${stepItems || '<li>Open the target screen and reproduce the scenario.</li>'}</ol><p><b>Actual result</b></p><p>${esc(actual)}</p><p><b>Expected result</b></p><p>${esc(expected)}</p>`;
    const shots = (sc.shots || []).filter((sh) => !/falha/.test(sh.file) || (sc.shots || []).length === 1);
    const orderedShots = shots.length ? shots : sc.shots || [];
    return {
      id,
      scenarioId: sc.id,
      title: rawTitle,
      refs,
      actual,
      expected,
      bodyHtml,
      shots: orderedShots.slice(0, 3),
      pendingCode: p?.code || null,
      existingDefect: sc.defects?.[0] || null,
    };
  });
}

function buildTcItems(results, card) {
  const tcs = card?.testCases || [];
  const sev = { fail: 4, blocked: 3, warn: 2, pass: 1 };
  return tcs.map((tc) => {
    const scs = (results.scenarios || []).filter((s) => (s.tc || []).includes(tc.id));
    const status = scs.length ? scs.map(finalStatus).sort((a, b) => (sev[b] || 0) - (sev[a] || 0))[0] : 'none';
    const shots = scs.flatMap((s) =>
      (s.shots || [])
        .filter((sh) => !/falha/.test(sh.file) || s.shots.length === 1)
        .map((sh) => ({ ...sh, scenarioId: s.id })),
    );
    const acs = [...new Set(scs.flatMap((s) => s.ac || []))].join(', ');
    const targetState =
      status === 'pass' ? `${tc.state || 'Design'} → Closed` : status === 'warn' ? `${tc.state || 'Design'} → Closed (confirmar ressalva)` : `Manter em ${tc.state || 'Design'}`;
    const snippetLines = [
      '<div>Evidence of test:</div>',
      ...shots.map(
        (sh, i) =>
          `<div><img src="https://dev.azure.com/_apis/wit/attachments/<ATTACHMENT-ID>?fileName=${tc.id}-${String(i + 1).padStart(2, '0')}-${sh.file.replace(/\.png$/i, '.jpg')}" alt="Image"><br></div>`,
      ),
    ];
    return {
      id: tc.id,
      title: tc.title,
      state: tc.state || 'Design',
      status,
      targetState,
      scs: scs.map((s) => s.id),
      acs,
      shots,
      snippet: snippetLines.join('\n'),
    };
  });
}

function buildStoryComment(results, card, defects, { scope, branch }) {
  const s = summarize(results.scenarios || []);
  const scopePrefix = scope === 'frontend' ? 'Frontend desk check' : scope === 'backend' ? 'Backend desk check' : 'Desk check';
  const passed = (results.scenarios || []).filter((sc) => ['pass', 'warn'].includes(finalStatus(sc)));
  const lines = [
    `${scopePrefix} completed${branch ? ` on ${branch}` : ''} for ${card ? `${card.type} ${card.id}` : headOf(results, card)} (${s.pass} passed, ${s.warn} warning, ${s.fail} failed, ${s.blocked} blocked).`,
    '',
  ];
  if (passed.length) {
    lines.push('Passed:');
    for (const sc of passed) {
      const refs = [...(sc.ac || []), ...(sc.tc || []).map((t) => `TC ${t}`)].join(' / ');
      lines.push(`- ${sc.id}${refs ? ` (${refs})` : ''}: ${sc.title}${finalStatus(sc) === 'warn' && sc.note ? ` [Note: ${sc.note}]` : ''}`);
    }
    lines.push('');
  }
  if (defects.length) {
    lines.push(`Blocking defects identified (${card?.type || 'Story'} kept in ${card?.state || 'Waiting Tests'}):`);
    defects.forEach((d, i) => lines.push(`${i + 1}. ${d.title} (${d.refs})`));
  } else {
    lines.push('No blocking defects found.');
  }
  return lines.join('\n');
}

export function azurePreviewHtml(results, card, dir, { scope = 'full', branch = '', repo = '', pending = [] } = {}) {
  const v = verdictOf(results);
  const s = summarize(results.scenarios || []);
  const defects = buildDefectItems(results, card, pending);
  const tcs = buildTcItems(results, card);
  const tcPass = tcs.filter((t) => t.status === 'pass').length;
  const tcWarn = tcs.filter((t) => t.status === 'warn').length;
  const tcFail = tcs.filter((t) => ['fail', 'blocked'].includes(t.status)).length;
  const storyComment = buildStoryComment(results, card, defects, { scope, branch });
  const decision = results.decision || null;
  const passPct = s.total ? Math.round((s.pass / s.total) * 1000) / 10 : 0;
  const warnPct = s.total ? Math.round((s.warn / s.total) * 1000) / 10 : 0;
  const failPct = s.total ? Math.round(((s.fail + s.blocked) / s.total) * 1000) / 10 : 0;
  const area = card?.areaPath || '-';
  const iteration = card?.iterationPath || '-';
  const storyId = card?.id || results.workItem || '';
  const storyUrl = card?.url || '#';
  const storyType = card?.type || 'User Story';
  const storyTitle = card?.title || results.title || 'Desk check';
  const storyState = card?.state || 'Waiting Tests';
  const assignee = card?.assignedTo || '-';

  const chipMap = {
    pass: ['c-pass', 'Passou'],
    warn: ['c-partial', 'Ressalva'],
    fail: ['c-fail', 'Falhou'],
    blocked: ['c-fail', 'Bloqueado'],
    none: ['c-info', 'Sem cenário'],
  };

  const spotlightCards = defects
    .map((d) => {
      const sh = d.shots[0];
      const src = sh ? imgSrc(dir, sh.file) : '';
      if (!src) return '';
      const marksJson = sh.marks?.length ? esc(JSON.stringify(sh.marks)) : '';
      return `<div class="spot-card">
        <figure class="zoomable" style="border:none;border-radius:0" data-marks="${marksJson}" data-caption="${esc(`${d.id} · ${d.title}`)}">
          <div class="img-frame">
            <span class="img-tag img-tag-err">${esc(d.id)} · ${esc(d.scenarioId)}</span>
            <img src="${src}" alt="${esc(d.title)}">
            ${marksHtml(sh.marks)}
            <span class="zoom-hint">Ampliar</span>
          </div>
        </figure>
        <div class="spot-meta">
          <b>${esc(d.title)}</b>
          <small>${esc(d.actual)}</small>
        </div>
      </div>`;
    })
    .filter(Boolean)
    .join('\n');

  const defectCards = defects.length
    ? defects
        .map((d, idx) => {
          const shotsHtml = d.shots
            .map((sh) => {
              const src = imgSrc(dir, sh.file);
              if (!src) return '';
              const marksJson = sh.marks?.length ? esc(JSON.stringify(sh.marks)) : '';
              return `<figure class="zoomable" data-marks="${marksJson}" data-caption="${esc(`${d.id} · ${sh.label || sh.file}`)}">
                <div class="img-frame">
                  <span class="img-tag img-tag-err">${sh.marks?.length ? 'ERRO MARCADO' : 'EVIDÊNCIA'}</span>
                  <img src="${src}" alt="${esc(sh.label || sh.file)}">
                  ${marksHtml(sh.marks)}
                  <span class="zoom-hint">Ampliar</span>
                </div>
                <figcaption>${esc(sh.label || sh.file)}</figcaption>
              </figure>`;
            })
            .join('');
          const gridCls = d.shots.length >= 3 ? 'evidence evidence-3' : d.shots.length === 1 ? 'evidence evidence-1' : 'evidence';
          return `<article class="wi-card stagger" style="--d:${idx}" id="${esc(d.id)}">
            <div class="wi-head">
              <div class="wi-type-bar">
                <span class="wi-icon" aria-hidden="true">!</span>
                <span class="wi-kind">${esc(d.id)} · ${d.existingDefect ? `DEFECT #${esc(d.existingDefect)}` : 'DEFECT NOVO (PLANEJADO)'}</span>
                <span class="chip c-fail">${esc(d.refs)}</span>
                ${d.pendingCode ? `<span class="chip c-info">Código pendente: ${esc(d.pendingCode)}</span>` : ''}
              </div>
              <div class="wi-title-row">
                <h3 class="wi-title">${esc(d.title)}</h3>
                <button class="copy-btn" data-label="Título copiado" data-copy="${esc(d.title)}">${COPY_ICON}<span>Copiar título</span></button>
              </div>
            </div>
            <div class="wi-fields">
              <div><span class="fk">Parent</span><span class="fv">${storyId ? `<a href="${esc(storyUrl)}" target="_blank" rel="noreferrer">${esc(storyType)} ${esc(storyId)} ↗</a>` : '-'}</span></div>
              <div><span class="fk">State</span><span class="fv"><span class="dot dot-new"></span>New</span></div>
              <div><span class="fk">Step Identified</span><span class="fv"><code>Tests</code> <small class="muted">Custom.StepIdentifiedDefectStandard</small></span></div>
              <div><span class="fk">Cenário</span><span class="fv"><code>${esc(d.scenarioId)}</code></span></div>
              <div class="span2"><span class="fk">Area Path</span><span class="fv"><code>${esc(area)}</code></span></div>
              <div class="span2"><span class="fk">Iteration Path</span><span class="fv"><code>${esc(iteration)}</code></span></div>
            </div>
            <div class="wi-body-wrap">
              <div class="wi-body-bar">
                <span class="section-lbl">Description · inglês (pronto para o Azure)</span>
                <button class="copy-btn" data-label="HTML do Defect copiado" data-copy="${esc(d.bodyHtml)}">${COPY_ICON}<span>Copiar HTML</span></button>
              </div>
              <div class="wi-body">${d.bodyHtml}</div>
              ${shotsHtml ? `<div class="${gridCls}">${shotsHtml}</div>` : ''}
            </div>
          </article>`;
        })
        .join('\n')
    : '<div class="cardinfo"><b>Nenhum Defect a abrir.</b><div class="trad" style="margin-top:6px">Todos os cenários passaram sem falhas bloqueantes.</div></div>';

  const tcRows = tcs
    .map((tc) => {
      const [cls, lbl] = chipMap[tc.status] || chipMap.none;
      return `<tr class="tc-row" data-status="${esc(tc.status)}">
        <td class="tc">${card?.url ? `<a href="${esc(card.url.replace(/\/edit\/\d+/, `/edit/${tc.id}`))}" target="_blank" rel="noreferrer">${tc.id}</a>` : tc.id}</td>
        <td><div class="en">${esc(tc.title)}</div><div class="trad">${esc(tc.acs || '-')} · Cenário ${esc(tc.scs.join(', ') || 'sem cenário')}</div></td>
        <td><span class="chip ${cls}">${lbl}</span></td>
        <td class="ev"><b>${esc(tc.targetState)}</b></td>
      </tr>`;
    })
    .join('\n');

  const tcDetails = tcs
    .map((tc, idx) => {
      const [cls, lbl] = chipMap[tc.status] || chipMap.none;
      const shotsHtml = tc.shots
        .map((sh) => {
          const src = imgSrc(dir, sh.file);
          if (!src) return '';
          const marksJson = sh.marks?.length ? esc(JSON.stringify(sh.marks)) : '';
          return `<figure class="zoomable tc-shot" data-marks="${marksJson}" data-caption="${esc(`TC ${tc.id} · ${sh.label || sh.file}`)}">
            <div class="img-frame">
              ${sh.marks?.some((m) => m.kind === 'fail' || m.status === 'fail') ? '<span class="img-tag img-tag-err">ERRO MARCADO</span>' : sh.marks?.some((m) => m.kind === 'warn') ? '<span class="img-tag img-tag-warn">RESSALVA</span>' : ''}
              <img src="${src}" alt="${esc(sh.label || sh.file)}">
              ${marksHtml(sh.marks)}
              <span class="zoom-hint">Ampliar</span>
            </div>
            <figcaption><code>${esc(sh.file)}</code><span>${esc(sh.label || '')}</span></figcaption>
          </figure>`;
        })
        .join('');
      return `<div class="tc-card stagger" style="--d:${idx}" data-status="${esc(tc.status)}">
        <div class="tc-card-head">
          <div class="tc-title-group">
            <span class="tc-badge">TC ${tc.id}</span>
            <b>${esc(tc.title)}</b>
            <span class="chip ${cls}">${lbl}</span>
          </div>
          <div class="tc-actions">
            <span class="state-pill">${esc(tc.targetState)}</span>
            <button class="copy-btn" data-label="Comentário do TC ${tc.id} copiado" data-copy="${esc(tc.snippet)}">${COPY_ICON}<span>Copiar HTML</span></button>
          </div>
        </div>
        <div class="discussion-preview">
          <div class="disc-bubble">
            <div class="disc-author">Discussion · comentário exato no padrão do time (prints limpos no JPG; caixas existem só na prévia HTML)</div>
            <div class="disc-text">Evidence of test:</div>
            ${shotsHtml ? `<div class="tc-shots-grid">${shotsHtml}</div>` : '<div class="trad">Sem prints vinculados a este TC.</div>'}
          </div>
          <details class="code-toggle">
            <summary>Ver HTML exato para colar no Discussion</summary>
            <pre class="code-box">${esc(tc.snippet)}</pre>
          </details>
        </div>
      </div>`;
    })
    .join('\n');

  const gaugePct = decision?.approve?.confidence ?? (s.total ? Math.round(((s.pass + s.warn) / s.total) * 100) : 0);
  const gaugeOffset = Math.max(0, Math.round(214 * (1 - gaugePct / 100)));
  const gaugeTitle = decision ? `Segunda opinião · ${decision.approve.answer === 'SIM' ? 'Aprovar' : 'Reprovar'}` : `Aprovação · ${s.pass + s.warn}/${s.total}`;
  const gaugeSub = decision?.accuracy?.highPct != null ? `Assertividade: <b>${esc(decision.accuracy.topLabel || 'alta')} (${decision.accuracy.highPct}%)</b>` : `${s.fail} falha(s) · ${s.warn} ressalva(s)`;

  const treeParent = card?.parent
    ? `<li class="tree-parent"><div class="tree-left"><span class="badge-type bt-parent">${esc(card.parent.type)}</span><b>${card.parent.id}</b> · ${esc(card.parent.title)}</div><div><span class="state-pill">${esc(card.parent.state)}</span></div></li>`
    : '';

  const treeDefects = defects
    .map(
      (d) => `<li class="tree-plan" data-jump-tab="defects" data-jump-id="${esc(d.id)}">
        <div class="tree-left"><span class="badge-type bt-def">Defect</span><span class="plan-pill">Planejado · Novo</span><span>${esc(d.title)}</span></div>
        <div><span class="chip c-fail">${esc(d.refs)}</span> <span class="state-pill">Identified: Tests</span></div>
      </li>`,
    )
    .join('\n');

  const treeTcs = tcs
    .map((tc) => {
      const [cls, lbl] = chipMap[tc.status] || chipMap.none;
      return `<li class="tree-tc">
        <div class="tree-left"><span class="badge-type bt-tc">Test Case</span><b>${tc.id}</b> · ${esc(tc.title)}</div>
        <div><span class="chip ${cls}">${lbl}</span> <span class="state-pill">${esc(tc.targetState)}</span></div>
      </li>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="pt-BR" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prévia Azure DevOps · ${esc(storyId || storyTitle)}</title>
<style>
  :root {
    --ink:#1b1a19; --ink-soft:#323130; --muted:#605e5c; --line:#e4e2df; --line-soft:#f1efed;
    --bg:#f4f6f9; --card:#ffffff; --card-alt:#faf9f8; --code-bg:#f3f2f1;
    --pass:#0f7b0f; --passbg:#dff6dd; --pass-border:#9fd89f;
    --fail:#c50f1f; --failbg:#fde7e9; --fail-border:#f1aeb5;
    --partial:#8a6100; --partialbg:#fff4ce; --partial-border:#f0d57a;
    --accent:#0f6cbd; --accent-hi:#115ea3; --accentbg:#ebf3fc; --accent-border:#b4d6fa;
    --defect:#d13438; --story:#0078d4; --tc:#773b93; --parent:#773b93;
    --shadow-sm:0 1px 3px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.04);
    --shadow-md:0 8px 24px rgba(15,23,42,.08), 0 2px 6px rgba(15,23,42,.04);
    --shadow-lg:0 16px 40px rgba(15,23,42,.14);
    --glass:rgba(255,255,255,.86);
    --hero-grad:linear-gradient(135deg,#0f6cbd 0%,#0b4f8c 55%,#1d3557 100%);
    --radius:10px;
  }
  [data-theme="dark"] {
    --ink:#f3f2f1; --ink-soft:#d2d0ce; --muted:#a19f9d; --line:#2e3239; --line-soft:#25282e;
    --bg:#12151a; --card:#1b1f27; --card-alt:#20252f; --code-bg:#262c38;
    --pass:#54b054; --passbg:rgba(84,176,84,.16); --pass-border:rgba(84,176,84,.36);
    --fail:#ff6b78; --failbg:rgba(255,107,120,.15); --fail-border:rgba(255,107,120,.38);
    --partial:#f7c948; --partialbg:rgba(247,201,72,.15); --partial-border:rgba(247,201,72,.36);
    --accent:#58a6ff; --accent-hi:#79b8ff; --accentbg:rgba(88,166,255,.15); --accent-border:rgba(88,166,255,.35);
    --defect:#f85149; --story:#3897f0; --tc:#b37feb; --parent:#b37feb;
    --shadow-sm:0 1px 3px rgba(0,0,0,.35);
    --shadow-md:0 10px 28px rgba(0,0,0,.42);
    --shadow-lg:0 20px 50px rgba(0,0,0,.6);
    --glass:rgba(27,31,39,.88);
    --hero-grad:linear-gradient(135deg,#0d2a4a 0%,#14213d 55%,#1b1f2e 100%);
  }
  * { box-sizing:border-box }
  html { scroll-behavior:smooth }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif; transition:background .3s, color .3s }
  a { color:var(--accent); text-decoration:none } a:hover { text-decoration:underline }
  code { background:var(--code-bg); border-radius:5px; padding:1.5px 6px; font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace }
  @keyframes fadeUp { from { opacity:0; transform:translateY(14px) } to { opacity:1; transform:translateY(0) } }
  @keyframes pulseRing { 0% { box-shadow:0 0 0 0 rgba(245,158,11,.55) } 70% { box-shadow:0 0 0 7px rgba(245,158,11,0) } 100% { box-shadow:0 0 0 0 rgba(245,158,11,0) } }
  @keyframes errPulse { 0%,100% { box-shadow:0 0 0 2px rgba(220,38,38,.45), 0 0 14px rgba(220,38,38,.35) } 50% { box-shadow:0 0 0 5px rgba(220,38,38,.18), 0 0 22px rgba(220,38,38,.55) } }
  @keyframes floatOrb { 0%,100% { transform:translate(0,0) scale(1) } 50% { transform:translate(18px,-12px) scale(1.06) } }
  @keyframes dashDraw { from { stroke-dashoffset:214 } to { stroke-dashoffset:var(--target-offset) } }
  @keyframes barGrow { from { transform:scaleX(0) } to { transform:scaleX(1) } }
  @keyframes toastIn { from { opacity:0; transform:translateY(14px) scale(.96) } to { opacity:1; transform:translateY(0) scale(1) } }
  .stagger { opacity:0; animation:fadeUp .46s cubic-bezier(.22,1,.36,1) forwards; animation-delay:calc(var(--d, 0) * 65ms) }
  .preview-banner { background:linear-gradient(90deg,#fff4ce,#ffebb3,#fff4ce); border-bottom:1px solid #f0d57a; color:#523b00; padding:8px 20px; font-size:12.5px; display:flex; align-items:center; justify-content:center; gap:9px; flex-wrap:wrap }
  [data-theme="dark"] .preview-banner { background:linear-gradient(90deg,#2b2310,#382d12,#2b2310); border-bottom-color:#5b4818; color:#f7d97e }
  .pulse-dot { width:8px; height:8px; border-radius:50%; background:#d97706; animation:pulseRing 2.2s infinite }
  header.hero { position:relative; overflow:hidden; background:var(--hero-grad); color:#fff; padding:26px 20px 24px }
  .hero-orb { position:absolute; border-radius:50%; pointer-events:none; filter:blur(42px); opacity:.28; animation:floatOrb 11s ease-in-out infinite }
  .orb-1 { width:320px; height:320px; background:#38bdf8; top:-130px; right:-40px }
  .orb-2 { width:240px; height:240px; background:#a78bfa; bottom:-120px; left:8%; animation-delay:-4s }
  header.hero .inner { position:relative; max-width:1160px; margin:auto; z-index:1 }
  .hero-top-row { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; flex-wrap:wrap }
  .crumb { font-size:12px; color:rgba(255,255,255,.76) }
  .hero-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap }
  .theme-btn { display:inline-flex; align-items:center; gap:7px; padding:6px 12px; border-radius:999px; border:1px solid rgba(255,255,255,.26); background:rgba(255,255,255,.12); color:#fff; font:inherit; font-size:12px; font-weight:600; cursor:pointer; backdrop-filter:blur(8px); transition:background .2s, transform .15s }
  .theme-btn:hover { background:rgba(255,255,255,.22); transform:translateY(-1px) }
  .theme-btn.ann-active { background:rgba(239,68,68,.28); border-color:rgba(252,165,165,.6) }
  .hero-main { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; flex-wrap:wrap }
  h1 { font-size:23px; margin:0 0 6px; letter-spacing:-.3px; line-height:1.25; display:flex; align-items:center; gap:10px; flex-wrap:wrap }
  .story-tag { background:rgba(255,255,255,.18); border:1px solid rgba(255,255,255,.32); color:#fff; border-radius:6px; font-size:12px; padding:3px 9px; font-weight:700 }
  .verdict-pill { background:rgba(239,68,68,.24); border:1px solid rgba(252,165,165,.55); color:#fee2e2; border-radius:999px; font-size:12px; padding:3px 11px; font-weight:700 }
  .verdict-pill.vp-pass { background:rgba(34,197,94,.24); border-color:rgba(134,239,172,.55); color:#dcfce7 }
  .scope-pill { background:rgba(56,189,248,.2); border:1px solid rgba(125,211,252,.5); color:#e0f2fe; border-radius:999px; font-size:11.5px; padding:3px 10px; font-weight:700 }
  .sub { color:rgba(255,255,255,.84); font-size:13px } .sub a { color:#bae6fd; font-weight:600 }
  .meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px }
  .meta span { background:rgba(255,255,255,.11); border:1px solid rgba(255,255,255,.18); border-radius:6px; padding:4px 10px; font-size:12px; color:rgba(255,255,255,.94) }
  .meta code { background:rgba(0,0,0,.28); color:#e0f2fe }
  .gauge-box { display:flex; align-items:center; gap:12px; padding:10px 14px; border-radius:12px; background:rgba(255,255,255,.11); border:1px solid rgba(255,255,255,.22); backdrop-filter:blur(10px) }
  .gauge-ring { position:relative; width:58px; height:58px }
  .gauge-ring svg { transform:rotate(-90deg); width:58px; height:58px }
  .gauge-ring circle { fill:none; stroke-width:5.5 }
  .gauge-ring .track { stroke:rgba(255,255,255,.2) }
  .gauge-ring .fill { stroke:#fca5a5; stroke-linecap:round; stroke-dasharray:214; stroke-dashoffset:214; --target-offset:${gaugeOffset}; animation:dashDraw 1.2s cubic-bezier(.22,1,.36,1) .25s forwards }
  .gauge-val { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:13.5px; font-weight:800; color:#fff }
  .gauge-meta b { display:block; font-size:12.5px; color:#fff } .gauge-meta small { display:block; font-size:11.5px; color:rgba(255,255,255,.8); line-height:1.35 }
  .tabs-bar { position:sticky; top:0; z-index:40; background:var(--glass); backdrop-filter:blur(14px); border-bottom:1px solid var(--line) }
  nav.tabs { position:relative; max-width:1160px; margin:auto; padding:0 20px; display:flex; align-items:center; gap:4px; overflow-x:auto; scrollbar-width:none }
  nav.tabs::-webkit-scrollbar { display:none }
  nav.tabs button { position:relative; border:none; background:none; padding:13px 15px; font:inherit; font-size:13.5px; font-weight:600; color:var(--muted); cursor:pointer; white-space:nowrap }
  nav.tabs button:hover { color:var(--ink) } nav.tabs button.active { color:var(--accent) }
  .tab-count { background:var(--code-bg); color:var(--ink-soft); border-radius:999px; padding:1px 8px; font-size:11px; margin-left:6px }
  nav.tabs button.active .tab-count { background:var(--accentbg); color:var(--accent) }
  .tab-indicator { position:absolute; bottom:0; left:0; height:2.5px; border-radius:2px 2px 0 0; background:var(--accent); transition:transform .32s cubic-bezier(.22,1,.36,1), width .32s cubic-bezier(.22,1,.36,1) }
  .wrap { max-width:1160px; margin:0 auto; padding:26px 20px 72px }
  .panel { display:none } .panel.active { display:block }
  .summary { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:18px }
  .box { position:relative; overflow:hidden; background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:16px 14px; text-align:center; box-shadow:var(--shadow-sm); transition:transform .22s, box-shadow .22s }
  .box:hover { transform:translateY(-3px); box-shadow:var(--shadow-md) }
  .box::before { content:""; position:absolute; top:0; left:0; right:0; height:3px }
  .box.f::before { background:var(--fail) } .box.p::before { background:var(--pass) } .box.q::before { background:var(--partial) }
  .box .v { font-size:30px; font-weight:800; line-height:1.1 } .box .l { font-size:12px; color:var(--muted); margin-top:5px }
  .box.p .v { color:var(--pass) } .box.f .v { color:var(--fail) } .box.q .v { color:var(--partial) }
  .dist-card, .tree-card, .cardinfo { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:16px 18px; margin-bottom:18px; box-shadow:var(--shadow-sm) }
  .cardinfo { border-left:4px solid var(--accent) }
  .dist-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:9px; font-size:12.5px; flex-wrap:wrap }
  .dist-bar { display:flex; height:10px; border-radius:999px; overflow:hidden; background:var(--code-bg); gap:2px }
  .dist-seg { height:100%; transform-origin:left center; animation:barGrow .85s cubic-bezier(.22,1,.36,1) .15s both }
  .seg-pass { background:var(--pass) } .seg-warn { background:#d97706 } .seg-fail { background:var(--fail) }
  .dist-legend { display:flex; gap:16px; margin-top:8px; flex-wrap:wrap; font-size:12px; color:var(--muted) }
  .dist-legend i { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; vertical-align:middle }
  .spotlight-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:14px; align-items:start }
  .spot-card { background:var(--card); border:1px solid var(--line); border-top:3px solid var(--defect); border-radius:var(--radius); overflow:hidden; box-shadow:var(--shadow-sm); transition:transform .22s, box-shadow .22s }
  .spot-card:hover { transform:translateY(-3px); box-shadow:var(--shadow-md) }
  .spot-meta { padding:10px 12px } .spot-meta b { display:block; font-size:13px; margin-bottom:3px } .spot-meta small { color:var(--muted); font-size:12px; line-height:1.4; display:block }
  .tree-card h2 { margin:0 0 14px; font-size:15.5px; display:flex; align-items:center; gap:8px; flex-wrap:wrap }
  .tree, .tree-children { list-style:none; margin:0; padding:0 }
  .tree-children { margin:8px 0 0 22px; padding:0 0 0 16px; border-left:2px dashed var(--line) }
  .tree li, .tree-children li { padding:9px 12px; border-radius:7px; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; transition:transform .18s, box-shadow .18s }
  .tree li + li, .tree-children li + li { margin-top:6px }
  .tree-children li:hover { transform:translateX(3px); box-shadow:var(--shadow-sm) }
  .tree-parent { background:var(--card-alt); border:1px solid var(--line); border-left:4px solid var(--parent); margin-bottom:6px }
  .tree-root { background:var(--accentbg); border:1px solid var(--accent-border); border-left:4px solid var(--story) }
  .tree-plan { border:1.5px dashed var(--accent); background:var(--card-alt); cursor:pointer }
  .tree-tc { border:1px solid var(--line); background:var(--card) }
  .tree-left { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0 }
  .badge-type { font-size:10.5px; font-weight:700; padding:2px 7px; border-radius:4px; color:#fff }
  .bt-us { background:var(--story) } .bt-def { background:var(--defect) } .bt-tc, .bt-parent { background:var(--tc) }
  .plan-pill { font-size:11px; font-weight:700; color:var(--accent); background:var(--accentbg); border:1px solid var(--accent-border); border-radius:999px; padding:1px 8px }
  .chip { display:inline-flex; align-items:center; border-radius:999px; padding:2px 10px; font-size:11px; font-weight:700; white-space:nowrap }
  .c-pass { color:var(--pass); background:var(--passbg); border:1px solid var(--pass-border) }
  .c-fail { color:var(--fail); background:var(--failbg); border:1px solid var(--fail-border) }
  .c-partial { color:var(--partial); background:var(--partialbg); border:1px solid var(--partial-border) }
  .c-info { color:var(--accent); background:var(--accentbg); border:1px solid var(--accent-border) }
  .wi-card { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--defect); border-radius:var(--radius); margin-bottom:20px; overflow:hidden; box-shadow:var(--shadow-sm) }
  .wi-head { padding:15px 18px; border-bottom:1px solid var(--line); background:var(--card-alt) }
  .wi-type-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px }
  .wi-icon { width:20px; height:20px; border-radius:5px; display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:900; color:#fff; background:var(--defect) }
  .wi-kind { font-size:11px; font-weight:800; letter-spacing:.05em; color:var(--defect) }
  .wi-title-row { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; flex-wrap:wrap }
  .wi-title { margin:0; font-size:16px; line-height:1.35; flex:1; min-width:240px }
  .wi-fields { display:grid; grid-template-columns:repeat(2,1fr); gap:8px 18px; padding:12px 18px; background:var(--card); border-bottom:1px solid var(--line); font-size:12.5px }
  .wi-fields > div { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap }
  .wi-fields .span2 { grid-column:1 / -1 }
  .fk { color:var(--muted); min-width:118px; font-weight:600; font-size:12px } .fv { color:var(--ink) } .muted { color:var(--muted) }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px } .dot-new { background:#9ca3af }
  .wi-body-wrap { padding:16px 18px }
  .wi-body-bar { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; flex-wrap:wrap }
  .section-lbl { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:700 }
  .wi-body { font-size:13.5px; color:var(--ink-soft) } .wi-body p { margin:0 0 8px } .wi-body ol { margin:0 0 10px; padding-left:20px }
  .evidence { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; margin-top:14px }
  .evidence.evidence-1 { grid-template-columns:minmax(0,620px) } .evidence.evidence-3 { grid-template-columns:repeat(3,1fr) }
  .zoomable { margin:0; background:var(--card-alt); border:1px solid var(--line); border-radius:8px; overflow:hidden; cursor:zoom-in; transition:transform .22s, box-shadow .22s, border-color .22s }
  .zoomable:hover { transform:translateY(-2px); box-shadow:var(--shadow-md); border-color:var(--accent) }
  .img-frame { position:relative; overflow:hidden; background:#0f172a; line-height:0 }
  .zoomable img { width:100%; display:block; transition:transform .38s cubic-bezier(.22,1,.36,1) }
  .zoomable:hover img { transform:scale(1.02) }
  .img-tag { position:absolute; top:8px; right:8px; z-index:4; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:800; letter-spacing:.04em; line-height:1.4 }
  .img-tag-err { background:rgba(197,15,31,.92); color:#fff } .img-tag-warn { background:rgba(217,119,6,.92); color:#fff } .img-tag-ok { background:rgba(15,123,15,.9); color:#fff }
  .zoom-hint { position:absolute; right:8px; bottom:8px; z-index:4; padding:3px 9px; border-radius:999px; background:rgba(15,23,42,.78); color:#fff; font-size:11px; font-weight:600; line-height:1.3; opacity:0; transform:translateY(4px); transition:opacity .2s, transform .2s }
  .zoomable:hover .zoom-hint { opacity:1; transform:translateY(0) }
  .zoomable figcaption { padding:9px 11px; font-size:12px; color:var(--ink-soft); border-top:1px solid var(--line); line-height:1.45 }
  .tc-shot figcaption span { display:block; color:var(--muted); margin-top:2px }
  .tc-shot img { height:165px; object-fit:cover; object-position:top }
  .ann-layer { position:absolute; inset:0; z-index:3; pointer-events:none; transition:opacity .22s }
  body.hide-ann .ann-layer { opacity:0 }
  .ann-box { position:absolute; border-radius:4px }
  .ann-err { border:2.5px solid #ef4444; background:rgba(239,68,68,.13); animation:errPulse 2.4s ease-in-out infinite }
  .ann-err-dashed { border:2px dashed #ef4444; background:repeating-linear-gradient(-45deg,rgba(239,68,68,.12),rgba(239,68,68,.12) 6px,rgba(239,68,68,.03) 6px,rgba(239,68,68,.03) 12px) }
  .ann-warn { border:2.5px solid #f59e0b; background:rgba(245,158,11,.15) }
  .ann-ok { border:2px solid #22c55e; background:rgba(34,197,94,.08) }
  .ann-info { border:2px solid #3b82f6; background:rgba(59,130,246,.12) }
  .ann-pin { position:absolute; top:-10px; left:-10px; min-width:20px; height:20px; padding:0 5px; border-radius:999px; font-size:10.5px; font-weight:800; color:#fff; line-height:20px; text-align:center; box-shadow:0 2px 6px rgba(0,0,0,.35) }
  .ann-pin-right { left:auto; right:-10px }
  .ann-err .ann-pin, .ann-err-dashed .ann-pin { background:#dc2626 } .ann-warn .ann-pin { background:#d97706 } .ann-ok .ann-pin { background:#16a34a } .ann-info .ann-pin { background:#2563eb }
  .ann-tip { position:absolute; white-space:nowrap; font-size:10px; font-weight:700; line-height:1.25; padding:3px 7px; border-radius:4px; color:#fff; box-shadow:0 3px 10px rgba(0,0,0,.35); max-width:260px; overflow:hidden; text-overflow:ellipsis }
  .ann-err .ann-tip, .ann-err-dashed .ann-tip { background:rgba(185,28,28,.95) } .ann-warn .ann-tip { background:rgba(180,83,9,.95) } .ann-ok .ann-tip { background:rgba(21,128,61,.94) } .ann-info .ann-tip { background:rgba(37,99,235,.94) }
  .ann-tip-bottom { left:0; top:calc(100% + 5px) } .ann-tip-right { left:calc(100% + 6px); top:50%; transform:translateY(-50%) } .ann-tip-bottom-left { right:0; top:calc(100% + 5px) }
  .tc-shot .ann-tip, .spot-card .ann-tip { display:none }
  .lb-stage .ann-tip { display:block !important; font-size:12px; padding:4px 10px; max-width:440px }
  .filter-bar { display:flex; align-items:center; gap:8px; margin-bottom:14px; flex-wrap:wrap }
  .filter-bar span { font-size:12px; color:var(--muted); font-weight:600 }
  .f-pill { border:1px solid var(--line); background:var(--card); color:var(--ink-soft); border-radius:999px; padding:5px 13px; font:inherit; font-size:12px; font-weight:600; cursor:pointer; transition:all .18s }
  .f-pill.active { background:var(--accent); border-color:var(--accent); color:#fff }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:var(--radius); overflow:hidden; margin-bottom:20px }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); background:var(--card-alt); padding:10px 12px; border-bottom:1px solid var(--line) }
  td { padding:11px 12px; border-bottom:1px solid var(--line-soft); vertical-align:top } tr:last-child td { border-bottom:none }
  .tc { font-variant-numeric:tabular-nums; font-weight:700; white-space:nowrap } .en { font-size:13px; font-weight:600 } .trad { color:var(--muted); font-size:12px; margin-top:2px } .ev { font-size:12.5px }
  .tc-card { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--tc); border-radius:var(--radius); margin-bottom:16px; overflow:hidden }
  .tc-card.hidden, .tc-row.hidden { display:none }
  .tc-card-head { padding:12px 16px; background:var(--card-alt); border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap }
  .tc-title-group, .tc-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap }
  .tc-badge { background:var(--tc); color:#fff; border-radius:5px; padding:2px 8px; font-size:11px; font-weight:700 }
  .state-pill { font-size:11.5px; color:var(--muted); background:var(--code-bg); border:1px solid var(--line); border-radius:6px; padding:3px 9px }
  .discussion-preview { padding:14px 16px }
  .disc-bubble { background:var(--card-alt); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:10px }
  .disc-author { font-size:11.5px; color:var(--muted); margin-bottom:6px; font-weight:600 } .disc-text { font-size:13.5px; font-weight:600; margin-bottom:10px }
  .tc-shots-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:10px }
  details.code-toggle summary { cursor:pointer; font-size:12px; font-weight:600; color:var(--accent); list-style:none; display:inline-flex; align-items:center; gap:6px }
  details.code-toggle summary::before { content:"▸"; transition:transform .2s } details.code-toggle[open] summary::before { transform:rotate(90deg) }
  .code-box { margin:8px 0 0; padding:11px 13px; background:var(--code-bg); border:1px solid var(--line); border-radius:7px; font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-x:auto; color:var(--ink-soft); white-space:pre-wrap }
  .copy-btn { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:6px; padding:5px 11px; font:inherit; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; transition:all .16s }
  .copy-btn:hover { background:var(--accentbg); border-color:var(--accent); color:var(--accent) }
  .copy-btn.copied { background:var(--passbg); color:var(--pass); border-color:var(--pass-border) }
  .checklist { list-style:none; margin:0; padding:0 }
  .checklist li { padding:8px 0; border-bottom:1px solid var(--line-soft); display:flex; align-items:center; gap:10px; font-size:13.5px }
  .checklist li:last-child { border-bottom:none }
  .chk-ok { width:20px; height:20px; border-radius:50%; background:var(--passbg); color:var(--pass); display:inline-flex; align-items:center; justify-content:center; font-size:11px; font-weight:900; flex-shrink:0 }
  .lb { position:fixed; inset:0; background:rgba(9,13,22,.9); backdrop-filter:blur(8px); z-index:100; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px; opacity:0; pointer-events:none; transition:opacity .24s }
  .lb.on { opacity:1; pointer-events:auto }
  .lb-stage { position:relative; display:inline-block; line-height:0; transform:scale(.95); transition:transform .26s cubic-bezier(.22,1,.36,1) }
  .lb.on .lb-stage { transform:scale(1) }
  .lb img { max-width:88vw; max-height:78vh; border-radius:8px; box-shadow:var(--shadow-lg); display:block }
  .lb-bar { margin-top:14px; display:flex; align-items:center; gap:14px; color:#e2e8f0; flex-wrap:wrap; justify-content:center; font-size:13px; background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.16); padding:7px 14px; border-radius:999px }
  .lb-toggle { border:1px solid rgba(255,255,255,.28); background:rgba(239,68,68,.3); color:#fff; border-radius:999px; padding:3px 10px; font:inherit; font-size:11.5px; font-weight:700; cursor:pointer }
  .lb-toggle.off { background:rgba(255,255,255,.12) }
  .lb-nav { position:fixed; top:50%; transform:translateY(-50%); width:42px; height:42px; border-radius:50%; border:1px solid rgba(255,255,255,.22); background:rgba(15,23,42,.65); color:#fff; font-size:20px; cursor:pointer }
  .lb-prev { left:18px } .lb-next { right:18px }
  .lb-close { position:fixed; top:18px; right:20px; width:38px; height:38px; border-radius:50%; border:1px solid rgba(255,255,255,.22); background:rgba(15,23,42,.65); color:#fff; font-size:18px; cursor:pointer }
  .toast { position:fixed; right:22px; bottom:22px; z-index:120; display:none; align-items:center; gap:9px; padding:10px 16px; border-radius:9px; background:#1b1f27; color:#fff; font-size:13px; font-weight:600; box-shadow:var(--shadow-lg) }
  .toast.on { display:flex; animation:toastIn .26s cubic-bezier(.22,1,.36,1) }
  .toast-check { width:18px; height:18px; border-radius:50%; background:#16a34a; color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:11px }
  footer { margin-top:34px; color:var(--muted); font-size:12px; text-align:center }
  @media(max-width:860px) { .summary { grid-template-columns:repeat(2,1fr) } .wi-fields, .evidence, .evidence.evidence-3 { grid-template-columns:1fr } .lb-nav { display:none } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation:none !important; transition:none !important } .stagger { opacity:1 } .gauge-ring .fill { stroke-dashoffset:var(--target-offset) } }
</style>
</head>
<body>
<div class="preview-banner">
  <span class="pulse-dot" aria-hidden="true"></span>
  <span><b>PRÉVIA LOCAL DE PUBLICAÇÃO NO AZURE DEVOPS</b> — ${esc(when(results.finishedAt))} · Escopo: ${esc(scopeLabel(scope))} · Nada gravado no Azure.</span>
</div>
<header class="hero">
  <div class="hero-orb orb-1" aria-hidden="true"></div>
  <div class="hero-orb orb-2" aria-hidden="true"></div>
  <div class="inner">
    <div class="hero-top-row">
      <div class="crumb">${esc(iteration || area)}</div>
      <div class="hero-controls">
        <button class="theme-btn ann-active" id="annBtn" type="button" aria-pressed="true"><span>●</span><span id="annLabel">Marcações de erro: ON</span></button>
        <button class="theme-btn" id="themeBtn" type="button"><span id="themeIcon">☾</span><span id="themeLabel">Tema escuro</span></button>
      </div>
    </div>
    <div class="hero-main">
      <div>
        <h1>
          ${storyId ? `<span class="story-tag">${esc(storyType)} ${esc(storyId)}</span>` : ''}
          ${esc(storyTitle)}
          <span class="verdict-pill${v.kind === 'pass' ? ' vp-pass' : ''}">Desk Check: ${esc(v.kind === 'pass' ? 'Aprovado' : v.kind === 'warn' ? 'Ressalvas' : 'Reprovado')}</span>
          <span class="scope-pill">${esc(scopeLabel(scope))}</span>
        </h1>
        <div class="sub">
          ${card?.url ? `<a href="${esc(card.url)}" target="_blank" rel="noreferrer">Abrir no Azure DevOps ↗</a> · ` : ''}Responsável: <b>${esc(assignee)}</b> · Estado: <b>${esc(storyState)}</b>
        </div>
        <div class="meta">
          ${branch ? `<span>Branch: <b>${esc(branch)}</b></span>` : ''}
          ${repo ? `<span>Repo: <b>${esc(repo)}</b></span>` : ''}
          <span>Tela: <code>${esc(results.baseUrl || '-')}</code></span>
          <span>Cenários: <b>${s.total}</b> (${s.pass} ok · ${s.warn} ressalvas · ${s.fail + s.blocked} falhas)</span>
        </div>
      </div>
      <div class="gauge-box">
        <div class="gauge-ring">
          <svg viewBox="0 0 76 76"><circle class="track" cx="38" cy="38" r="34"/><circle class="fill" cx="38" cy="38" r="34"/></svg>
          <div class="gauge-val"><span class="count-up" data-target="${gaugePct}">0</span>%</div>
        </div>
        <div class="gauge-meta"><b>${esc(gaugeTitle)}</b><small>${gaugeSub}</small></div>
      </div>
    </div>
  </div>
</header>
<div class="tabs-bar">
  <nav class="tabs" role="tablist">
    <button class="active" data-tab="overview">Resumo &amp; Mapa de Erros</button>
    <button data-tab="defects">Defects a criar <span class="tab-count">${defects.length}</span></button>
    <button data-tab="tcs">Evidências nos TCs <span class="tab-count">${tcs.length}</span></button>
    <button data-tab="story">Comentário na US &amp; Checklist</button>
    <span class="tab-indicator" id="tabIndicator"></span>
  </nav>
</div>
<main class="wrap">
  <section class="panel active" id="tab-overview">
    <div class="summary">
      <div class="box f stagger" style="--d:0"><div class="v count-up" data-target="${defects.length}">0</div><div class="l">Defects a criar (Identified: Tests)</div></div>
      <div class="box p stagger" style="--d:1"><div class="v count-up" data-target="${tcPass}">0</div><div class="l">TCs prontos p/ Closed</div></div>
      <div class="box q stagger" style="--d:2"><div class="v count-up" data-target="${tcWarn}">0</div><div class="l">TCs com ressalva</div></div>
      <div class="box f stagger" style="--d:3"><div class="v count-up" data-target="${tcFail}">0</div><div class="l">TCs mantidos em Design</div></div>
    </div>
    <div class="dist-card stagger" style="--d:4">
      <div class="dist-head"><b>Distribuição dos cenários · ${s.total} executados</b><span class="muted">${s.pass} ok · ${s.warn} ressalvas · ${s.fail + s.blocked} falhas</span></div>
      <div class="dist-bar"><div class="dist-seg seg-pass" style="width:${passPct}%"></div><div class="dist-seg seg-warn" style="width:${warnPct}%"></div><div class="dist-seg seg-fail" style="width:${failPct}%"></div></div>
      <div class="dist-legend"><span><i style="background:var(--pass)"></i>Passou (${passPct}%)</span><span><i style="background:#d97706"></i>Ressalva (${warnPct}%)</span><span><i style="background:var(--fail)"></i>Falhou (${failPct}%)</span></div>
    </div>
    ${spotlightCards ? `<div class="tree-card stagger" style="--d:5"><h2>Onde estão os erros em tela <span class="muted" style="font-size:12px;font-weight:500">(clique para ampliar com as marcações)</span></h2><div class="spotlight-grid">${spotlightCards}</div></div>` : ''}
    <div class="tree-card stagger" style="--d:6">
      <h2>Árvore proposta no Azure Boards</h2>
      <ul class="tree">${treeParent}<li class="tree-root"><div class="tree-left"><span class="badge-type bt-us">${esc(storyType)}</span><b>${esc(storyId)}</b> · ${esc(storyTitle)}</div><div><span class="state-pill">${esc(storyState)}</span></div></li></ul>
      <ul class="tree-children">${treeDefects}${treeTcs}</ul>
    </div>
  </section>
  <section class="panel" id="tab-defects">${defectCards}</section>
  <section class="panel" id="tab-tcs">
    <div class="filter-bar">
      <span>Filtrar TCs:</span>
      <button class="f-pill active" data-filter="all">Todos (${tcs.length})</button>
      <button class="f-pill" data-filter="pass">Passou (${tcPass})</button>
      <button class="f-pill" data-filter="warn">Ressalva (${tcWarn})</button>
      <button class="f-pill" data-filter="fail">Falhou (${tcFail})</button>
    </div>
    ${tcs.length ? `<table><thead><tr><th style="width:82px">TC</th><th>Título no Azure</th><th style="width:108px">Resultado</th><th style="width:32%">Ação proposta</th></tr></thead><tbody>${tcRows}</tbody></table>${tcDetails}` : '<div class="cardinfo"><b>Nenhum Test Case vinculado a este card.</b></div>'}
  </section>
  <section class="panel" id="tab-story">
    <div class="cardinfo stagger" style="--d:0">
      <div class="wi-body-bar"><b>Comentário resumo na história (opcional · inglês)</b><button class="copy-btn" data-label="Comentário copiado" data-copy="${esc(storyComment)}">${COPY_ICON}<span>Copiar comentário</span></button></div>
      <pre class="code-box">${esc(storyComment)}</pre>
    </div>
    <div class="tree-card stagger" style="--d:1">
      <h2>Checklist de conformidade com o processo Azure DevOps</h2>
      <ul class="checklist">
        <li><span class="chk-ok">✓</span><span>Títulos, descrições de Defect e comentários em <b>inglês</b>.</span></li>
        <li><span class="chk-ok">✓</span><span>Tipo <b>Defect</b> filho da história com <code>Custom.StepIdentifiedDefectStandard = Tests</code>.</span></li>
        <li><span class="chk-ok">✓</span><span><code>Area Path</code> e <code>Iteration Path</code> herdados da história pai.</span></li>
        <li><span class="chk-ok">✓</span><span>Evidências dos TCs no padrão <code>Evidence of test:</code> + <code>&lt;img&gt;</code>; prints JPG limpos sem rabiscos gravados.</span></li>
        <li><span class="chk-ok">✓</span><span>Escopo aplicado: <b>${esc(scopeLabel(scope))}</b>.</span></li>
      </ul>
    </div>
  </section>
  <footer>Gerado pelo <b>deskcheck</b> · Prévia local autocontida · Nada publicado no Azure DevOps · Atalhos: <code>1</code>–<code>4</code> abas · <code>M</code> marcações · <code>←</code>/<code>→</code> zoom</footer>
</main>
<div class="lb" id="lb" role="dialog" aria-modal="true"><button class="lb-close" id="lbClose">✕</button><button class="lb-nav lb-prev" id="lbPrev">‹</button><div class="lb-stage"><img id="lbimg" alt=""><div class="ann-layer" id="lbAnn"></div></div><button class="lb-nav lb-next" id="lbNext">›</button><div class="lb-bar"><b id="lbCount">1 / 1</b><span id="lbCap"></span><button class="lb-toggle" id="lbAnnToggle" type="button">Marcações: ON</button></div></div>
<div class="toast" id="toast" role="status"><span class="toast-check">✓</span><span id="toastMsg">Copiado!</span></div>
<script>
(() => {
  const rootEl = document.documentElement;
  const themeBtn = document.getElementById('themeBtn'), themeIcon = document.getElementById('themeIcon'), themeLabel = document.getElementById('themeLabel');
  const applyTheme = (t) => { rootEl.setAttribute('data-theme', t); themeIcon.textContent = t === 'dark' ? '☀' : '☾'; themeLabel.textContent = t === 'dark' ? 'Tema claro' : 'Tema escuro'; try { localStorage.setItem('dc_az_theme', t); } catch {} };
  try { const s = localStorage.getItem('dc_az_theme'); if (s === 'dark' || s === 'light') applyTheme(s); } catch {}
  themeBtn.addEventListener('click', () => applyTheme(rootEl.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  const annBtn = document.getElementById('annBtn'), annLabel = document.getElementById('annLabel'), lbAnnToggle = document.getElementById('lbAnnToggle');
  let showAnn = true;
  const syncAnn = () => { document.body.classList.toggle('hide-ann', !showAnn); annBtn.classList.toggle('ann-active', showAnn); annBtn.setAttribute('aria-pressed', String(showAnn)); annLabel.textContent = showAnn ? 'Marcações de erro: ON' : 'Marcações de erro: OFF'; lbAnnToggle.textContent = showAnn ? 'Marcações: ON' : 'Marcações: OFF'; lbAnnToggle.classList.toggle('off', !showAnn); };
  annBtn.addEventListener('click', () => { showAnn = !showAnn; syncAnn(); });
  lbAnnToggle.addEventListener('click', (e) => { e.stopPropagation(); showAnn = !showAnn; syncAnn(); });

  const tabButtons = [...document.querySelectorAll('nav.tabs button')], panels = [...document.querySelectorAll('.panel')], ind = document.getElementById('tabIndicator');
  const moveInd = (b) => { ind.style.width = b.offsetWidth + 'px'; ind.style.transform = 'translateX(' + b.offsetLeft + 'px)'; };
  const activate = (name) => {
    const btn = tabButtons.find((b) => b.dataset.tab === name); if (!btn) return;
    tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
    panels.forEach((p) => { const on = p.id === 'tab-' + name; p.classList.toggle('active', on); if (on) p.querySelectorAll('.stagger').forEach((el) => { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }); });
    moveInd(btn);
  };
  tabButtons.forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));
  window.addEventListener('resize', () => { const a = document.querySelector('nav.tabs button.active'); if (a) moveInd(a); });
  requestAnimationFrame(() => moveInd(tabButtons[0]));
  document.querySelectorAll('[data-jump-tab]').forEach((el) => el.addEventListener('click', () => { activate(el.dataset.jumpTab); const t = document.getElementById(el.dataset.jumpId); if (t) setTimeout(() => t.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }));

  document.querySelectorAll('.count-up').forEach((el) => {
    const target = Number(el.dataset.target || 0), start = performance.now();
    const tick = (now) => { const p = Math.min(1, (now - start) / 700); el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3)))); if (p < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  const filterBtns = document.querySelectorAll('.f-pill');
  filterBtns.forEach((btn) => btn.addEventListener('click', () => {
    filterBtns.forEach((b) => b.classList.remove('active')); btn.classList.add('active');
    const f = btn.dataset.filter;
    document.querySelectorAll('.tc-row, .tc-card').forEach((el) => el.classList.toggle('hidden', f !== 'all' && el.dataset.status !== f));
  }));

  const toast = document.getElementById('toast'), toastMsg = document.getElementById('toastMsg'); let tt = null;
  const showToast = (m) => { toastMsg.textContent = m; toast.classList.remove('on'); void toast.offsetWidth; toast.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => toast.classList.remove('on'), 2000); };
  document.querySelectorAll('.copy-btn').forEach((btn) => btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(btn.dataset.copy || ''); const sp = btn.querySelector('span'), o = sp.textContent; sp.textContent = 'Copiado!'; btn.classList.add('copied'); showToast(btn.dataset.label || 'Copiado!'); setTimeout(() => { sp.textContent = o; btn.classList.remove('copied'); }, 1500); } catch { showToast('Não foi possível copiar'); }
  }));

  const lb = document.getElementById('lb'), lbimg = document.getElementById('lbimg'), lbAnn = document.getElementById('lbAnn'), lbCap = document.getElementById('lbCap'), lbCount = document.getElementById('lbCount');
  let gal = [], idx = 0;
  const drawLbMarks = (raw) => {
    lbAnn.innerHTML = ''; let list = []; try { list = raw ? JSON.parse(raw) : []; } catch {}
    lbAnnToggle.style.display = list.length ? 'inline-block' : 'none';
    list.forEach((m, i) => {
      const k = m.kind === 'ok' || m.kind === 'assert' ? 'ok' : m.kind === 'warn' ? 'warn' : m.kind === 'dashed' ? 'err-dashed' : m.status === 'fail' || m.kind === 'fail' ? 'err' : 'info';
      const b = document.createElement('div'); b.className = 'ann-box ann-' + k;
      b.style.cssText = 'left:' + m.x + '%;top:' + m.y + '%;width:' + m.w + '%;height:' + m.h + '%';
      const p = document.createElement('span'); p.className = m.pinPos === 'right' ? 'ann-pin ann-pin-right' : 'ann-pin'; p.textContent = m.pin || (m.step ? '#' + m.step : String(i + 1)); b.appendChild(p);
      if (m.label) { const t = document.createElement('span'); t.className = 'ann-tip ann-tip-' + (m.pos || 'bottom'); t.textContent = m.label; b.appendChild(t); }
      lbAnn.appendChild(b);
    });
  };
  const renderGal = () => { const it = gal[idx]; if (!it) return; lbimg.src = it.src; lbCap.textContent = it.cap; lbCount.textContent = (idx + 1) + ' / ' + gal.length; drawLbMarks(it.marks); };
  const stepGal = (d) => { if (!gal.length) return; idx = (idx + d + gal.length) % gal.length; renderGal(); };
  document.querySelectorAll('.zoomable').forEach((el) => el.addEventListener('click', () => {
    const active = document.querySelector('.panel.active');
    gal = [...active.querySelectorAll('.zoomable')].map((z) => ({ el: z, src: z.querySelector('img').src, marks: z.dataset.marks || '', cap: z.dataset.caption || '' }));
    idx = Math.max(0, gal.findIndex((i) => i.el === el)); renderGal(); lb.classList.add('on');
  }));
  document.getElementById('lbClose').addEventListener('click', () => lb.classList.remove('on'));
  document.getElementById('lbPrev').addEventListener('click', (e) => { e.stopPropagation(); stepGal(-1); });
  document.getElementById('lbNext').addEventListener('click', (e) => { e.stopPropagation(); stepGal(1); });
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.classList.remove('on'); });
  document.addEventListener('keydown', (e) => {
    if (lb.classList.contains('on')) {
      if (e.key === 'Escape') lb.classList.remove('on');
      if (e.key === 'ArrowLeft') stepGal(-1);
      if (e.key === 'ArrowRight') stepGal(1);
      if (e.key.toLowerCase() === 'm') { showAnn = !showAnn; syncAnn(); }
      return;
    }
    if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey && !e.altKey) { showAnn = !showAnn; syncAnn(); }
    if (['1','2','3','4'].includes(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { const b = tabButtons[Number(e.key) - 1]; if (b) activate(b.dataset.tab); }
  });
})();
</script>
</body>
</html>`;
}
