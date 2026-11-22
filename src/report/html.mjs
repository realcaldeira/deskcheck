import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { finalStatus, summarize } from "../runner.mjs";
import { icon } from "./icons.mjs";
import { LABEL, LABEL_LONG, VERDICT_TAG, auditItemsOf, computeQuality, coverage, esc, formatMs, headOf, richEsc, scenarioMetrics, stepCategory, totalDurationMs, verdictOf, when } from "./quality.mjs";
import { REPORT_CSS } from "./styles.mjs";
import { REPORT_CLIENT_JS } from "./client.mjs";

const pill = (st, extra = '') => `<span class="pill s-${st}">${icon(st, 'ico xs')}<span>${esc(LABEL[st])}</span>${extra}</span>`;

function img(dir, file) {
  const light = path.join(dir, 'shots', 'web', file.replace(/\.png$/i, '.jpg'));
  if (existsSync(light)) return `data:image/jpeg;base64,${readFileSync(light).toString('base64')}`;
  const p = path.join(dir, 'shots', file);
  if (!existsSync(p)) return '';
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.svg' ? 'image/svg+xml' : 'image/png';
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`;
}

function marksLayerHtml(marks) {
  if (!marks?.length) return '';
  return `<div class="shot-marks" data-marks>${marks
    .map((m) => {
      const cls = m.status === 'fail' || m.kind === 'fail' ? 'm-fail' : m.kind === 'assert' ? 'm-assert' : 'm-action';
      return `<span class="s-mark ${cls}" style="left:${m.x}%;top:${m.y}%;width:${m.w}%;height:${m.h}%" title="Passo #${esc(m.step)} · ${esc(m.label)}"><span class="s-mark-n">#${esc(m.step)}</span></span>`;
    })
    .join('')}</div>`;
}

function figure(src, rawLabel, tag, shotFile = '', marks = []) {
  if (!src) return '';
  const label = String(rawLabel || '').replace(/^falha\s+/i, 'Falha · ');
  const isFail = /^Falha\s*·/i.test(label);
  const hasMarks = Array.isArray(marks) && marks.length > 0;
  return `<figure class="shot${isFail ? ' shot-fail' : ''}">
    <div class="shot-stage">
      <div class="shot-card">
        <div class="shot-chrome">
          <span class="shot-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="shot-cap">
            ${tag ? `<span class="tag${tag === 'Referência' ? ' tag-ref' : ' tag-scr'}">${esc(tag)}</span>` : ''}
            <span class="cap-text" title="${esc(label)}">${esc(label)}</span>
          </span>
          ${hasMarks ? `<button type="button" class="marks-toggle on" data-marks-toggle aria-pressed="true" title="Mostrar ou ocultar marcações automáticas dos passos">${icon('target', 'ico xs')}<span>${marks.length}</span></button>` : ''}
          <span class="shot-expand-ico" aria-hidden="true">${icon('zoom', 'ico xs')}</span>
        </div>
        <button type="button" class="zoom" data-zoom${shotFile ? ` data-shot-file="${esc(shotFile)}"` : ''}${hasMarks ? ` data-marks-json="${esc(JSON.stringify(marks))}"` : ''} aria-label="Ampliar: ${esc(label)}">
          <div class="shot-frame">
            <img loading="lazy" src="${src}" alt="${esc(label)}">
            ${marksLayerHtml(marks)}
            <span class="shot-glint" aria-hidden="true"></span>
            <span class="zoom-hint" aria-hidden="true">${icon('zoom', 'ico xs')} Ampliar print</span>
          </div>
        </button>
      </div>
    </div>
  </figure>`;
}

function compareHtml(refsImgs, screen, dir) {
  const refItems = refsImgs.map((r) => ({ src: img(dir, r.file), label: r.label, file: r.file })).filter((r) => r.src);
  const scrSrc = screen ? img(dir, screen.file) : '';
  if (!refItems.length && !scrSrc) return '';
  const canCurtain = refItems.length === 1 && Boolean(scrSrc);
  const sideBySide = `<div class="compare-grid">${refItems.map((r) => figure(r.src, r.label, 'Referência', r.file)).join('')}${scrSrc ? figure(scrSrc, screen.label, 'Tela', screen.file, screen.marks || []) : ''}</div>`;
  const curtain = canCurtain
    ? `<div class="curtain" data-curtain hidden>
        <div class="curtain-stage">
          <img class="curtain-base" src="${scrSrc}" alt="${esc(screen.label)}">
          <div class="curtain-top"><img src="${refItems[0].src}" alt="${esc(refItems[0].label)}"></div>
          <div class="curtain-line" aria-hidden="true"><span class="curtain-handle">⇄</span></div>
          <span class="curtain-badge left">Referência</span>
          <span class="curtain-badge right">Tela</span>
          <input class="curtain-range" type="range" min="0" max="100" value="50" aria-label="Comparar referência e tela">
        </div>
      </div>`
    : '';
  const diffView = canCurtain
    ? `<div class="diff-view" data-diff hidden>
        <div class="diff-bar">
          <span class="diff-stats" data-diff-stats>Calculando diferença pixel-a-pixel…</span>
          <label class="diff-tol"><span>Tolerância</span><input type="range" min="8" max="80" value="28" data-diff-tol><span class="diff-tol-v" data-diff-tol-v>28</span></label>
        </div>
        <div class="diff-stage"><canvas class="diff-canvas" data-diff-canvas></canvas></div>
      </div>`
    : '';
  return `<div class="compare" data-compare>
    <div class="compare-head">
      <div class="compare-left">
        <span class="compare-title">${icon('layers', 'ico sm')} Referência × Tela</span>
        ${canCurtain ? '<span class="sim-badge" data-sim>Calculando similaridade…</span>' : ''}
      </div>
      ${canCurtain ? '<div class="seg-ctrl" role="group" aria-label="Modo de comparação"><button type="button" class="seg-btn on" data-cmode="side">Lado a lado</button><button type="button" class="seg-btn" data-cmode="curtain">Cortina</button><button type="button" class="seg-btn" data-cmode="diff">Diferença</button></div>' : ''}
    </div>
    ${sideBySide}
    ${curtain}
    ${diffView}
  </div>`;
}

function scenarioHtml(sc, dir, idx) {
  const st = finalStatus(sc);
  const m = scenarioMetrics(sc);
  const revised = sc.verdict && sc.verdict !== sc.status;
  const refs = [...sc.ac.map((a) => `<span class="chip">${esc(a)}</span>`), ...sc.tc.map((t) => `<span class="chip chip-tc">TC ${esc(t)}</span>`)].join('');
  const dur = formatMs(sc.durationMs);
  const visibleSteps = sc.steps.filter((x) => x.status !== 'skipped');
  const stepRail = (sc.steps || []).map((x) => `<span class="sc-rail-seg s-${x.status}" title="Passo ${x.n}: ${esc(LABEL[x.status] || x.status)}"></span>`).join('');
  const steps = visibleSteps
    .map((x) => {
      const cat = stepCategory(x);
      return `<li class="step s-${x.status} cat-${cat.key}${x.setup ? ' setup' : ''}">
        <span class="dot" title="${esc(LABEL[x.status] || x.status)}">${icon(x.status, 'ico xs')}</span>
        <div class="step-body">
          <div class="step-main">
            <span class="step-cat c-${cat.key}">${esc(cat.label)}</span>
            <span class="step-text">${richEsc(x.desc)}</span>
            ${x.detail ? `<span class="step-detail">→ ${esc(x.detail)}</span>` : ''}
            ${x.shot ? `<button type="button" class="step-shot" data-open-shot="${esc(x.shot)}" title="Abrir print capturado neste passo">${icon('camera', 'ico xs')}<span>print</span></button>` : ''}
          </div>
          ${x.error ? `<div class="step-error">${icon(x.status === 'warn' ? 'warn' : 'fail', 'ico sm')}<span>${esc(x.error)}</span></div>` : ''}
        </div>
        ${x.ms !== undefined ? `<span class="ms">${esc(formatMs(x.ms))}</span>` : ''}
      </li>`;
    })
    .join('');
  const skipped = sc.steps.filter((x) => x.status === 'skipped').length;
  const refsImgs = (sc.references || []).filter((r) => r.file);
  const missingRefs = (sc.references || []).filter((r) => r.missing);
  const screen = refsImgs.length ? sc.shots.find((sh) => !/falha/.test(sh.file)) || sc.shots[0] : null;
  const galleryShots = sc.shots.filter((sh) => sh !== screen).map((sh) => ({ ...sh, src: img(dir, sh.file) })).filter((sh) => sh.src);
  const shotsHtml = galleryShots.map((sh) => figure(sh.src, sh.label, '', sh.file, sh.marks || [])).join('');
  const compare = refsImgs.length ? compareHtml(refsImgs, screen, dir) : '';
  const hasSteps = visibleSteps.length > 0 || skipped > 0;
  const useSplit = !compare && hasSteps && galleryShots.length === 1;
  const galleryCls = galleryShots.length === 1 ? 'gallery g-1' : galleryShots.length === 2 ? 'gallery g-2' : 'gallery g-many';
  const totalShots = sc.shots.length;
  const runtimeAlerts = (sc.console?.length || 0) + (sc.network?.length || 0);
  const auditItems = auditItemsOf(sc.audit);
  const auditSevere = auditItems.filter((a) => a.severity === 'fail').length;
  const assertBadgeSt = !m.assertTotal ? 'none' : m.assertFail ? 'fail' : m.assertWarn ? 'warn' : 'pass';

  const diagHtml =
    st === 'fail' || st === 'blocked'
      ? `<div class="diag s-${st}">
          <div class="diag-head">
            <span class="diag-ico">${icon(st, 'ico sm')}</span>
            <strong>${st === 'fail' ? 'Diagnóstico da falha' : 'Motivo do bloqueio'}</strong>
            ${m.failedStepObj ? `<span class="diag-step">Passo #${m.failedStepObj.n} · ${esc(m.failedStepObj.do)}</span>` : ''}
          </div>
          <div class="diag-grid">
            ${sc.expected ? `<div class="diag-col"><span class="diag-k">Esperado</span><p>${esc(sc.expected)}</p></div>` : ''}
            <div class="diag-col"><span class="diag-k">Obtido</span><p class="diag-err">${esc(sc.note || m.failedStepObj?.error || sc.error || 'Cenário não atingiu o resultado esperado.')}</p></div>
          </div>
        </div>`
      : '';

  const stepsBlock = hasSteps
    ? `<div class="steps-wrap">
        <div class="section-sub">
          <span>Passos executados</span>
          <span class="sub-meta">${visibleSteps.length} passo${visibleSteps.length !== 1 ? 's' : ''}${m.assertTotal ? ` · ${m.assertPass}/${m.assertTotal} asserç${m.assertTotal > 1 ? 'ões' : 'ão'}` : ''}${skipped ? ` · ${skipped} pulado${skipped > 1 ? 's' : ''}` : ''}</span>
        </div>
        <ol class="steps">${steps}</ol>
        ${skipped ? `<p class="skipped-note">${skipped} passo${skipped > 1 ? 's' : ''} não executado${skipped > 1 ? 's' : ''} depois da falha.</p>` : ''}
      </div>`
    : '';

  const logs = [
    auditItems.length
      ? `<details class="log-box audit-box" open><summary><span class="log-chev">${icon('chevron', 'ico xs')}</span>${icon('eye', 'ico xs')}<span>Auditoria visual automática</span><span class="log-count s-${auditSevere ? 'fail' : 'warn'}">${auditItems.length}</span></summary><ul class="mono">${auditItems.map((a) => `<li><span class="code ${a.severity === 'warn' ? 'wr' : ''}">${esc(a.kind)}</span> ${esc(a.text)}</li>`).join('')}</ul></details>`
      : '',
    sc.console.length ? `<details class="log-box"><summary><span class="log-chev">${icon('chevron', 'ico xs')}</span>${icon('terminal', 'ico xs')}<span>Erros no console</span><span class="log-count s-fail">${sc.console.length}</span></summary><ul class="mono">${sc.console.map((c) => `<li>${esc(c.text.slice(0, 400))}</li>`).join('')}</ul></details>` : '',
    sc.network.length ? `<details class="log-box"><summary><span class="log-chev">${icon('chevron', 'ico xs')}</span>${icon('globe', 'ico xs')}<span>Requisições com erro</span><span class="log-count s-fail">${sc.network.length}</span></summary><ul class="mono">${sc.network.map((n) => `<li><span class="code">${esc(n.status || n.error)}</span> <span class="method">${esc(n.method || '')}</span> ${esc(n.url)}</li>`).join('')}</ul></details>` : '',
    sc.blockedRequests?.length ? `<details class="log-box"><summary><span class="log-chev">${icon('chevron', 'ico xs')}</span>${icon('shield', 'ico xs')}<span>Escritas barradas (somente leitura)</span><span class="log-count s-pass">${sc.blockedRequests.length}</span></summary><ul class="mono">${sc.blockedRequests.map((n) => `<li><span class="code ro">${esc(n.method)}</span> ${esc(n.url)}</li>`).join('')}</ul></details>` : '',
    sc.dialogs?.length ? `<details class="log-box"><summary><span class="log-chev">${icon('chevron', 'ico xs')}</span>${icon('note', 'ico xs')}<span>Diálogos nativos tratados</span><span class="log-count s-none">${sc.dialogs.length}</span></summary><ul class="mono">${sc.dialogs.map((d) => `<li><span class="code ro">${esc(d.type)} · ${esc(d.action)}</span> ${esc(d.message)}</li>`).join('')}</ul></details>` : '',
    sc.requests?.length
      ? `<details class="log-box"><summary><span class="log-chev">${icon('chevron', 'ico xs')}</span>${icon('globe', 'ico xs')}<span>Requisições registradas (XHR/Fetch)</span><span class="log-count s-none">${sc.requests.length}</span></summary><ul class="mono">${sc.requests
          .map((n) => {
            const stCls = Number(n.status) >= 400 || n.status === 0 ? '' : 'ro';
            return `<li><span class="code ${stCls}">${esc(n.status ?? '?')}</span> <span class="method">${esc(n.method || '')}</span> ${esc(n.url)}${n.ms ? ` <span class="muted">(${esc(formatMs(n.ms))})</span>` : ''}</li>`;
          })
          .join('')}</ul></details>`
      : '',
  ].filter(Boolean).join('');

  const searchHay = [sc.id, sc.title, sc.expected, sc.note, sc.error, ...sc.ac, ...sc.tc.map((t) => `TC ${t}`)].filter(Boolean).join(' ').toLowerCase();

  return `<article id="${esc(sc.id)}" class="scenario s-${st} reveal" style="--delay:${Math.min(idx * 55, 330)}ms" data-status="${st}" data-search="${esc(searchHay)}">
  <header class="sc-head">
    <button type="button" class="sc-toggle" data-sc-toggle aria-expanded="true" aria-label="Expandir ou recolher ${esc(sc.id)}">
      <span class="sc-chev" aria-hidden="true">${icon('chevron', 'ico sm')}</span>
      <span class="sc-badge s-${st}" aria-hidden="true">${icon(st, 'ico sm')}</span>
      <span class="sc-title-wrap">
        <span class="sc-title-line">
          <span class="sc-id">${esc(sc.id)}</span>
          <h3>${esc(sc.title)}</h3>
        </span>
        ${refs ? `<span class="chips">${refs}</span>` : ''}
      </span>
    </button>
    <div class="sc-right">
      <span class="sc-meta-group">
        ${m.assertTotal ? `<span class="assert-chip s-${assertBadgeSt}" title="Asserções executadas neste cenário">${icon(assertBadgeSt, 'ico xs')}${m.assertPass}/${m.assertTotal} asserç${m.assertTotal > 1 ? 'ões' : 'ão'}</span>` : ''}
        ${sc.flaky ? `<span class="assert-chip s-warn" title="Cenário passou após nova tentativa automática">${icon('warn', 'ico xs')}flaky · ${sc.attempts} tentativas</span>` : ''}
        ${auditItems.length ? `<span class="assert-chip s-${auditSevere ? 'fail' : 'warn'}" title="Achados na auditoria visual automática">${icon('eye', 'ico xs')}${auditItems.length} visual</span>` : ''}
        ${runtimeAlerts ? `<span class="assert-chip s-fail" title="Erros de console ou rede detectados">${icon('terminal', 'ico xs')}${runtimeAlerts} alerta${runtimeAlerts > 1 ? 's' : ''}</span>` : ''}
        ${totalShots ? `<span class="sc-mini" title="${totalShots} print${totalShots !== 1 ? 's' : ''}">${icon('camera', 'ico xs')}${totalShots}</span>` : ''}
        ${dur ? `<span class="sc-dur" title="Duração">${icon('clock', 'ico xs')}${esc(dur)}</span>` : ''}
      </span>
      ${pill(st, revised ? '<span class="rev" title="Veredito revisado depois de olhar os prints">revisado</span>' : '')}
      <button type="button" class="copy-link" data-copy-link="${esc(sc.id)}" title="Copiar link para ${esc(sc.id)}" aria-label="Copiar link para ${esc(sc.id)}">${icon('anchor', 'ico xs')}</button>
    </div>
  </header>
  ${stepRail ? `<div class="sc-rail" aria-hidden="true">${stepRail}</div>` : ''}
  <div class="sc-body-wrap">
    <div class="sc-body">
      ${diagHtml}
      ${!diagHtml && (sc.expected || sc.note) ? `<div class="callouts">
        ${sc.expected ? `<div class="callout expected"><span class="lbl">${icon('target', 'ico xs')} Esperado</span><p>${esc(sc.expected)}</p></div>` : ''}
        ${sc.note ? `<div class="callout note n-${st}"><span class="lbl">${icon('note', 'ico xs')} Observação</span><p>${esc(sc.note)}</p></div>` : ''}
      </div>` : ''}
      ${sc.defects?.length ? `<div class="defects">${icon('bug', 'ico sm')}<span>Defect aberto:</span>${sc.defects.map((d) => `<span class="defect-id">#${esc(d)}</span>`).join('')}</div>` : ''}
      ${compare}
      ${useSplit
        ? `<div class="sc-split">
            <div class="sc-split-main">${stepsBlock}</div>
            <div class="sc-split-media">
              <div class="section-sub"><span>Evidência</span><span class="sub-meta">1 print</span></div>
              ${shotsHtml}
            </div>
          </div>`
        : `${stepsBlock}${shotsHtml ? `<div class="gallery-wrap"><div class="section-sub"><span>Evidências</span><span class="sub-meta">${galleryShots.length} print${galleryShots.length !== 1 ? 's' : ''}</span></div><div class="${galleryCls}">${shotsHtml}</div></div>` : ''}`}
      ${missingRefs.map((r) => `<p class="muted small">Referência não encontrada: ${esc(r.missing)}</p>`).join('')}
      ${logs ? `<div class="logs">${logs}</div>` : ''}
    </div>
  </div>
</article>`;
}

function coverageHtml(cov, kind, title, sectionId) {
  const rows = cov[kind];
  if (!rows.length) return '';
  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  const segs = ['pass', 'warn', 'fail', 'blocked', 'nottestable', 'none']
    .filter((k) => counts[k])
    .map((k) => `<span class="cov-seg s-${k}" style="flex:${counts[k]}" title="${counts[k]} ${esc(LABEL[k].toLowerCase())}"></span>`)
    .join('');
  const summary = ['pass', 'warn', 'fail', 'blocked', 'nottestable', 'none']
    .filter((k) => counts[k])
    .map((k) => `<span class="mini s-${k}">${icon(k, 'ico xs')}${counts[k]} ${esc(LABEL[k].toLowerCase())}</span>`)
    .join('');
  return `<section id="${esc(sectionId)}" class="panel cov reveal" data-section="${esc(sectionId)}">
  <div class="panel-head">
    <div class="panel-title">
      <span class="panel-ico">${icon('checklist', 'ico sm')}</span>
      <h2>${esc(title)}</h2>
      <span class="count-tag">${rows.length}</span>
    </div>
    <div class="minis">${summary}</div>
  </div>
  <div class="cov-meter" aria-hidden="true">${segs}</div>
  <div class="cov-list">${rows
    .map((r) => {
      const lines = String(r.text || '').split('\n').map((x) => x.trim()).filter(Boolean);
      const first = lines[0] || '';
      const rest = lines.slice(1).join(' · ');
      return `<div class="cov-row s-${r.status}">
        <span class="cov-key">${esc(r.key)}</span>
        <div class="cov-text">
          <span class="cov-line">${esc(first)}</span>
          ${rest ? `<span class="cov-sub">${esc(rest)}</span>` : ''}
          ${r.reason ? `<span class="reason">${esc(r.reason)}</span>` : ''}
        </div>
        <div class="cov-res">${r.scenarios.length ? `<span class="links">${r.scenarios.map((id) => `<a href="#${esc(id)}" data-jump="${esc(id)}">${esc(id)}</a>`).join('')}</span>` : ''}${pill(r.status)}</div>
      </div>`;
    })
    .join('')}</div>
</section>`;
}

function qualityHtml(q) {
  const cards = q.checks
    .map(
      (c) => `<div class="q-item s-${c.status}${c.meter !== undefined ? ' q-featured' : ''}" data-spot>
        <div class="q-item-top">
          <span class="q-ico">${icon(c.meter !== undefined ? 'shield' : c.status, 'ico xs')}</span>
          <span class="q-name">${esc(c.label)}</span>
        </div>
        <div class="q-val">${esc(c.value)}</div>
        ${c.meter !== undefined ? `<div class="q-meter" aria-hidden="true"><span style="width:${c.meter}%"></span></div>` : ''}
        <div class="q-sub">${esc(c.sub)}</div>
      </div>`,
    )
    .join('');

  const attention = q.findings.length
    ? `<section id="sec-attention" class="panel attention reveal" data-section="sec-attention">
        <div class="panel-head">
          <div class="panel-title">
            <span class="panel-ico s-fail">${icon('radar', 'ico sm')}</span>
            <h2>O que precisa de atenção</h2>
            <span class="count-tag">${q.findings.length}</span>
          </div>
          <span class="att-hint">Clique em qualquer item para ir direto ao ponto</span>
        </div>
        <div class="att-list">
          ${q.findings
            .map(
              (f) => `<a href="#${esc(f.jump)}" class="att-row s-${f.severity}" data-jump="${esc(f.jump)}">
                <span class="att-dot" aria-hidden="true">${icon(f.severity, 'ico xs')}</span>
                <span class="att-id">${esc(f.id)}</span>
                <div class="att-copy">
                  <span class="att-title">${esc(f.title)}</span>
                  <span class="att-detail">${esc(f.detail)}</span>
                </div>
                <span class="att-tag">${esc(f.tag)}</span>
                <span class="att-go" aria-hidden="true">${icon('arrowRight', 'ico xs')}</span>
              </a>`,
            )
            .join('')}
        </div>
      </section>`
    : `<section id="sec-attention" class="all-clear reveal" data-section="sec-attention">
        <span class="all-clear-ico">${icon('pass', 'ico sm')}</span>
        <div class="all-clear-copy">
          <strong>Tudo validado sem pendências</strong>
          <span>Todos os cenários, asserções objetivas, console, rede e auditoria visual passaram limpos.</span>
        </div>
      </section>`;

  return { checksStrip: `<div class="q-strip q-strip--${q.checks.length}" aria-label="Checklist de confiança">${cards}</div>`, attention };
}

export function reportHtml(results, card, dir) {
  const v = verdictOf(results);
  const s = summarize(results.scenarios);
  const cov = coverage(results, card);
  const quality = computeQuality(results, cov);
  const { checksStrip, attention } = qualityHtml(quality);
  const okCount = s.pass + s.warn;
  const passPct = s.total ? Math.round((okCount / s.total) * 100) : 0;
  const ringR = 39;
  const ringC = +(2 * Math.PI * ringR).toFixed(2);
  const ringOff = +(ringC * (1 - passPct / 100)).toFixed(2);
  const durTotal = formatMs(totalDurationMs(results));

  const host = (() => {
    try {
      const u = new URL(results.baseUrl);
      if (u.protocol === 'file:') {
        const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
        return parts.slice(-2).join('/') || 'arquivo local';
      }
      return u.host || results.baseUrl;
    } catch {
      return results.baseUrl || '';
    }
  })();

  const seg = ['pass', 'warn', 'fail', 'blocked']
    .filter((k) => s[k])
    .map((k) => `<span class="seg s-${k}" style="flex:${s[k]}" title="${s[k]} ${esc(LABEL[k].toLowerCase())}"></span>`)
    .join('');

  const kpiMeta = [
    ['pass', 'Passaram'],
    ['warn', 'Ressalvas'],
    ['fail', 'Falharam'],
    ['blocked', 'Bloqueados'],
  ];
  const tiles = kpiMeta
    .map(([k, label]) => {
      const n = s[k] || 0;
      const pct = s.total ? Math.round((n / s.total) * 100) : 0;
      const disabled = n === 0 ? ' disabled' : '';
      return `<button type="button" class="tile s-${k}${n ? '' : ' zero'}" data-kpi-filter="${k}" data-spot${disabled} title="${n ? `Filtrar por ${label.toLowerCase()}` : `Nenhum cenário em ${label.toLowerCase()}`}">
        <span class="tile-top"><span class="tile-ico">${icon(k, 'ico xs')}</span><span class="tile-l">${esc(label)}</span></span>
        <span class="tile-val">
          <span class="tile-n" data-count="${n}">${n}</span>
          <span class="tile-pct">${pct}%</span>
        </span>
        <span class="tile-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
      </button>`;
    })
    .join('');

  const quickNav = results.scenarios
    .map((sc) => {
      const st = finalStatus(sc);
      return `<a href="#${esc(sc.id)}" class="q-chip s-${st}" data-jump="${esc(sc.id)}" title="${esc(sc.id)} · ${esc(sc.title)} (${esc(LABEL[st])})"><span class="q-dot"></span>${esc(sc.id)}</a>`;
    })
    .join('');

  const sideScenarios = results.scenarios
    .map((sc) => {
      const st = finalStatus(sc);
      return `<a href="#${esc(sc.id)}" class="nav-item s-${st}" data-jump="${esc(sc.id)}" data-nav-id="${esc(sc.id)}" title="${esc(sc.id)} · ${esc(sc.title)}">
        <span class="nav-dot" aria-hidden="true"></span>
        <span class="nav-id">${esc(sc.id)}</span>
        <span class="nav-title">${esc(sc.title)}</span>
      </a>`;
    })
    .join('');

  const filters = [
    ['all', 'Todos', s.total],
    ['fail', 'Falhas', s.fail],
    ['warn', 'Ressalvas', s.warn],
    ['blocked', 'Bloqueados', s.blocked],
    ['pass', 'Passaram', s.pass],
  ]
    .filter(([k, , n]) => k === 'all' || n)
    .map(([k, l, n], i) => `<button type="button" class="filter${k !== 'all' ? ` s-${k}` : ''}${i === 0 ? ' on' : ''}" data-filter="${k}" aria-pressed="${i === 0}">${k !== 'all' ? '<span class="f-dot" aria-hidden="true"></span>' : ''}${esc(l)}<span class="f-n">${n}</span></button>`)
    .join('');

  const meta = [
    card ? `<a class="meta-item link" href="${esc(card.url)}" target="_blank" rel="noopener">${esc(card.type)} #${esc(card.id)} ${icon('link', 'ico xs')}</a>` : '',
    card?.state ? `<span class="meta-item"><span class="state-dot"></span>${esc(card.state)}</span>` : '',
    results.readonly ? `<span class="meta-item ro">${icon('shield', 'ico xs')} Somente leitura</span>` : '',
    results.strict ? `<span class="meta-item ro">${icon('spark', 'ico xs')} Modo estrito</span>` : '',
    host ? `<span class="meta-item">${icon('globe', 'ico xs')} ${esc(host)}</span>` : '',
    `<span class="meta-item">${icon('monitor', 'ico xs')} ${results.viewport.width}×${results.viewport.height}</span>`,
    durTotal ? `<span class="meta-item">${icon('clock', 'ico xs')} ${esc(durTotal)}</span>` : '',
    `<span class="meta-item">${icon('calendar', 'ico xs')} ${esc(when(results.finishedAt))}</span>`,
  ].filter(Boolean).join('');

  const pageTitle = card ? card.title : headOf(results, card);
  const shortId = card ? `${card.type} #${card.id}` : results.workItem ? `Item #${results.workItem}` : pageTitle;
  const docTitleId = card?.id || results.workItem || pageTitle;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Desk check · ${esc(docTitleId)}</title>
<style>
${REPORT_CSS}
</style>
</head>
<body class="s-${v.kind}">

<div class="ambient" aria-hidden="true">
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
</div>

<header class="topbar">
  <div class="topbar-in">
    <div class="brand">
      <span class="brand-mark">${icon('brand', 'ico sm')}</span>
      <div class="brand-text">
        <span class="brand-name">Desk check</span>
        <span class="brand-sep">/</span>
        <span class="brand-sub">${esc(shortId)}</span>
      </div>
      <span class="top-status s-${v.kind}"><span class="top-status-dot" aria-hidden="true"></span>${esc(VERDICT_TAG[v.kind] || 'Resultado')}</span>
    </div>
    <div class="top-actions">
      <button type="button" class="icon-btn sq" id="btn-sidebar" aria-label="Mostrar ou ocultar navegação lateral" title="Mostrar ou ocultar barra lateral">${icon('sidebar', 'ico sm')}</button>
      <button type="button" class="icon-btn" id="btn-print" title="Imprimir ou salvar PDF">${icon('print', 'ico sm')}<span class="btn-lbl">Imprimir</span></button>
      <button type="button" class="icon-btn sq" id="theme" aria-label="Alternar tema claro/escuro" title="Alternar tema claro/escuro"><span class="theme-sun">${icon('sun', 'ico sm')}</span><span class="theme-moon">${icon('moon', 'ico sm')}</span></button>
    </div>
  </div>
  <div class="read-progress" aria-hidden="true"><div class="read-progress-bar" id="read-bar"></div></div>
</header>

<div class="shell">
  <aside class="sidebar" aria-label="Navegação do relatório">
    <nav class="nav-group">
      <div class="nav-label"><span>Visão geral</span></div>
      <a href="#sec-summary" class="nav-item active s-${v.kind}" data-nav-id="sec-summary">
        <span class="nav-dot" aria-hidden="true"></span>
        <span class="nav-title">Resumo executivo</span>
      </a>
      <a href="#sec-attention" class="nav-item ${quality.findings.length ? 's-fail' : 's-pass'}" data-nav-id="sec-attention">
        <span class="nav-dot" aria-hidden="true"></span>
        <span class="nav-title">${quality.findings.length ? 'Atenção imediata' : 'Tudo validado'}</span>
        ${quality.findings.length ? `<span class="nav-badge s-fail">${quality.findings.length}</span>` : ''}
      </a>
      ${cov?.acs?.length ? `<a href="#sec-acs" class="nav-item" data-nav-id="sec-acs"><span class="nav-dot" aria-hidden="true"></span><span class="nav-title">Critérios de aceite</span><span class="nav-badge">${cov.acs.length}</span></a>` : ''}
      ${cov?.tcs?.length ? `<a href="#sec-tcs" class="nav-item" data-nav-id="sec-tcs"><span class="nav-dot" aria-hidden="true"></span><span class="nav-title">Test Cases</span><span class="nav-badge">${cov.tcs.length}</span></a>` : ''}
    </nav>

    <nav class="nav-group" aria-label="Lista de cenários">
      <div class="nav-label"><span>Cenários</span><span class="nav-cnt">${s.total}</span></div>
      ${sideScenarios}
    </nav>

    <div class="side-card">
      <div class="side-card-row"><span>Aprovação</span><strong>${okCount}/${s.total} (${passPct}%)</strong></div>
      <div class="side-bar" aria-hidden="true">${seg}</div>
      <div class="side-card-row"><span>Confiança</span><strong>${esc(quality.confidence.label)} (${quality.confidence.score}%)</strong></div>
      <div class="side-card-row"><span>Asserções</span><strong>${quality.assertPass}/${quality.assertTotal}</strong></div>
      ${durTotal ? `<div class="side-card-row"><span>Duração total</span><strong>${esc(durTotal)}</strong></div>` : ''}
    </div>
  </aside>

  <main class="main">
    <div id="sec-summary" class="doc-head reveal" data-section="sec-summary">
      <div class="eyebrow-row">
        <p class="eyebrow"><span class="eyebrow-dot"></span>Relatório de validação</p>
      </div>
      <h1>${esc(pageTitle)}</h1>
      <div class="meta">${meta}</div>
    </div>

    <section class="hero s-${v.kind} reveal" style="--delay:60ms" aria-label="Veredito">
      <div class="hero-grid">
        <div class="verdict">
          <div class="ring" aria-label="${passPct}% aprovados">
            <svg viewBox="0 0 96 96" aria-hidden="true">
              <defs>
                <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="var(--c)"/>
                  <stop offset="100%" stop-color="var(--c2, var(--c))"/>
                </linearGradient>
              </defs>
              <circle class="ring-ticks" cx="48" cy="48" r="31"/>
              <circle class="ring-track" cx="48" cy="48" r="${ringR}"/>
              ${passPct > 0 ? `<circle class="ring-val" id="ring-val" cx="48" cy="48" r="${ringR}" stroke="url(#ringGrad)" stroke-dasharray="${ringC}" stroke-dashoffset="${ringOff}" data-target-offset="${ringOff}" data-circumference="${ringC}"/>` : ''}
            </svg>
            <div class="ring-center">
              <span class="ring-pct" data-count="${passPct}" data-suffix="%">${passPct}%</span>
              <span class="ring-sub">${okCount}/${s.total}</span>
            </div>
          </div>
          <div class="verdict-copy">
            <span class="verdict-kicker">${icon(v.kind, 'ico xs')} ${esc(VERDICT_TAG[v.kind] || 'Resultado')}</span>
            <h2>${esc(v.text)}</h2>
            <p>${s.total} cenário${s.total !== 1 ? 's' : ''}${durTotal ? ` em ${durTotal}` : ''} · ${results.readonly ? 'somente leitura (escritas barradas)' : 'execução local'}${card?.acceptanceCriteria?.length ? ` · ${card.acceptanceCriteria.length} critérios de aceite` : ''}</p>
          </div>
        </div>
        <div class="tiles">${tiles}</div>
      </div>

      ${checksStrip}

      <div class="hero-foot">
        <div class="bar" aria-hidden="true">${seg}</div>
        ${results.scenarios.length > 1 ? `<nav class="quick-nav" aria-label="Atalhos dos cenários"><span class="q-lbl">Cenários:</span>${quickNav}</nav>` : ''}
      </div>
    </section>

    ${attention}

    ${cov ? coverageHtml(cov, 'acs', 'Critérios de aceite', 'sec-acs') + coverageHtml(cov, 'tcs', 'Test Cases', 'sec-tcs') : ''}

    <div class="toolbar reveal" style="--delay:120ms">
      <div class="toolbar-left">
        <h2>Cenários</h2>
        <span class="count-tag" id="vis-count">${s.total}</span>
      </div>
      <div class="toolbar-right">
        <div class="filters" role="group" aria-label="Filtrar cenários">${filters}</div>
        <label class="search-box" aria-label="Buscar cenários">
          ${icon('search', 'ico sm')}
          <input type="search" id="search" placeholder="Buscar cenário, AC..." autocomplete="off">
          <kbd class="search-kbd">/</kbd>
        </label>
        <button type="button" class="icon-btn" id="toggle-all" data-collapsed="false">${icon('collapse', 'ico xs')}<span id="toggle-all-lbl">Recolher</span></button>
      </div>
    </div>

    <div id="scenarios">
      ${results.scenarios.map((sc, i) => scenarioHtml(sc, dir, i)).join('\n')}
    </div>
    <div class="empty-state" id="empty-state" hidden>
      <p>Nenhum cenário encontrado para este filtro.</p>
      <button type="button" class="icon-btn" id="clear-filters">Limpar filtros</button>
    </div>

    <footer>
      <span>Gerado pelo <strong>deskcheck</strong> · ${esc(when(results.finishedAt))}</span>
      ${results.baseUrl ? `<span>${esc(results.baseUrl)}</span>` : ''}
    </footer>
  </main>
</div>

<button type="button" class="to-top" id="to-top" aria-label="Voltar ao topo" title="Voltar ao topo">${icon('arrowUp', 'ico sm')}</button>
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<dialog class="lb" id="lb" aria-label="Imagem ampliada">
  <div class="lb-shell" id="lb-shell">
    <div class="lb-stage"><div class="lb-frame"><img id="lb-img" alt=""><div class="lb-marks" id="lb-marks-layer"></div></div></div>
  </div>
  <div class="lb-bar">
    <button type="button" id="lb-prev" aria-label="Anterior">←</button>
    <span class="lb-cap" id="lb-cap"></span>
    <button type="button" id="lb-next" aria-label="Próxima">→</button>
    <button type="button" id="lb-marks" class="on" aria-label="Alternar marcações" hidden>Marcações</button>
    <button type="button" id="lb-zoom" aria-label="Alternar zoom">100%</button>
    <button type="button" id="lb-close" aria-label="Fechar">✕</button>
  </div>
</dialog>

<script>
${REPORT_CLIENT_JS}
</script>
</body>
</html>`;
}

