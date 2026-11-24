import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DeskcheckError, isLocalUrl, isWriteAllowedUrl, openPage, sleep, withChrome } from './cdp.mjs';
import { MARK_SCRIPT, OVERLAY_SCRIPT } from './overlay.mjs';
import { PAGE_HELPER } from './page-helper.mjs';

export const ACTIONS = [
  'goto', 'reload', 'viewport', 'click', 'dblclick', 'hover', 'fill', 'select', 'check', 'press', 'scroll', 'wait', 'eval',
  'screenshot', 'expectText', 'expectNoText', 'expectVisible', 'expectHidden', 'expectUrl', 'expectCount', 'expectValue',
  'expectEval',
];

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  PageUp: { code: 'PageUp', keyCode: 33 },
};

export function validatePlan(plan) {
  const errs = [];
  if (!plan || typeof plan !== 'object') return ['o plano não é um objeto JSON'];
  if (!Array.isArray(plan.scenarios) || !plan.scenarios.length) errs.push('faltou "scenarios" (lista com pelo menos um cenário)');
  const ids = new Set();
  const checkSteps = (steps, where) => {
    if (!Array.isArray(steps)) return errs.push(`${where}: "steps" precisa ser uma lista`);
    steps.forEach((s, i) => {
      if (!s || typeof s !== 'object') errs.push(`${where} passo ${i + 1}: não é objeto`);
      else if (!ACTIONS.includes(s.do)) errs.push(`${where} passo ${i + 1}: ação "${s.do}" não existe (use: ${ACTIONS.join(', ')})`);
      else for (const m of marksOf(s)) if (!hasQuery(queryOf(m))) errs.push(`${where} passo ${i + 1}: cada "mark" precisa de selector, text, role, label ou placeholder (e "note" com o problema)`);
    });
  };
  if (plan.beforeEach) checkSteps(plan.beforeEach, 'beforeEach');
  for (const [i, sc] of (plan.scenarios || []).entries()) {
    const where = `cenário ${sc?.id || i + 1}`;
    if (!sc?.id) errs.push(`cenário ${i + 1}: faltou "id" (ex.: "S1")`);
    else if (ids.has(sc.id)) errs.push(`${where}: id repetido`);
    else ids.add(sc.id);
    if (!sc?.title) errs.push(`${where}: faltou "title"`);
    checkSteps(sc?.steps, where);
    for (const ref of [].concat(sc?.reference ?? [])) {
      const f = typeof ref === 'string' ? ref : ref?.file;
      if (!f) errs.push(`${where}: "reference" precisa ser o caminho de uma imagem ou { "file", "label" }`);
    }
  }
  for (const [i, nt] of (plan.notTestable || []).entries()) {
    if (!nt?.ref || !nt?.reason) errs.push(`notTestable ${i + 1}: precisa de "ref" (ex.: "AC-3" ou "TC 10051") e "reason"`);
  }
  return errs;
}

export function describeStep(s) {
  if (s.desc) return s.desc;
  const q = s.selector ? `\`${s.selector}\`${s.text ? ` com "${s.text}"` : ''}` : s.role ? `${s.role} "${s.name ?? ''}"` : s.label ? `campo "${s.label}"` : s.placeholder ? `campo "${s.placeholder}"` : s.text !== undefined ? `"${s.text}"` : '';
  switch (s.do) {
    case 'goto': return `Abrir ${s.url}`;
    case 'reload': return 'Recarregar a página';
    case 'viewport': return `Tela ${s.width}×${s.height}`;
    case 'click': return `Clicar em ${q}`;
    case 'dblclick': return `Clicar duas vezes em ${q}`;
    case 'hover': return `Passar o mouse em ${q}`;
    case 'fill': return `Preencher ${q} com "${s.value}"`;
    case 'select': return `Escolher "${s.value}" em ${q}`;
    case 'check': return `${s.value === false ? 'Desmarcar' : 'Marcar'} ${q}`;
    case 'press': return `Tecla ${s.key}`;
    case 'scroll': return q ? `Rolar até ${q}` : `Rolar para y=${s.y ?? 0}`;
    case 'wait': return s.ms ? `Esperar ${s.ms} ms` : s.gone !== undefined ? `Esperar sumir "${s.gone}"` : `Esperar ${q}`;
    case 'eval': return 'Executar script na página';
    case 'screenshot': return `Print "${s.label || 'tela'}"${marksOf(s).length ? ` com ${marksOf(s).length} marcação(ões)` : ''}`;
    case 'expectText': return `Ver o texto "${s.text}"${s.within ? ` em \`${s.within}\`` : ''}`;
    case 'expectNoText': return `Não ver o texto "${s.text}"`;
    case 'expectVisible': return `Ver ${q}`;
    case 'expectHidden': return `Não ver ${q}`;
    case 'expectUrl': return `Endereço contém "${s.contains ?? s.match}"`;
    case 'expectCount': return `${q || `\`${s.selector}\``} aparece ${s.count ?? `${s.min ?? 0}–${s.max ?? '∞'}`} vez(es)`;
    case 'expectValue': return `${q} tem o valor "${s.value}"`;
    case 'expectEval': return s.desc || 'Verificação por script';
    default: return s.do;
  }
}

const queryOf = (s) => {
  const q = {};
  for (const k of ['selector', 'text', 'role', 'name', 'label', 'placeholder', 'exact', 'index', 'within']) if (s[k] !== undefined) q[k] = s[k];
  return q;
};
const hasQuery = (q) => ['selector', 'text', 'role', 'label', 'placeholder'].some((k) => q[k] !== undefined);
const marksOf = (s) => [].concat(s.mark ?? []).filter((m) => m && typeof m === 'object');
const toMarks = (list) => list.map((m) => ({ q: queryOf(m), note: String(m.note || '') }));

export function resolveUrl(u, baseUrl) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (!baseUrl) throw new DeskcheckError(`endereço relativo "${u}" sem --url / baseUrl no plano`);
  return new URL(u, baseUrl.endsWith('/') || u.startsWith('/') || u.startsWith('?') || u.startsWith('#') ? baseUrl : `${baseUrl}/`).href;
}

class StepFail extends Error {
  constructor(msg, kind = 'fail') {
    super(msg);
    this.kind = kind;
  }
}

async function pollUntil(fn, timeoutMs, interval = 150) {
  const start = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last.ok) return last;
    if (Date.now() - start >= timeoutMs) return last;
    await sleep(interval);
  }
}

function makeStepRunner(page, { baseUrl }) {
  const ensureHelper = () => page.evaluate(PAGE_HELPER);
  const inPage = async (expr) => {
    await ensureHelper();
    return page.evaluate(expr);
  };
  const locate = async (s, forClick, timeout) => {
    const q = queryOf(s);
    if (!hasQuery(q)) throw new StepFail('o passo precisa de selector, text, role, label ou placeholder', 'blocked');
    const r = await pollUntil(async () => {
      const t = await inPage(`window.__dc.target(${JSON.stringify(q)}, ${forClick})`).catch(() => null);
      return { ok: Boolean(t && !t.covered), t };
    }, timeout);
    if (!r.t) throw new StepFail(`não encontrei ${describeStep({ ...s, do: 'expectVisible' }).replace(/^Ver /, '')} na tela`, 'blocked');
    if (r.t.covered) throw new StepFail(`o elemento está coberto por <${r.t.covered}> (modal, overlay?)`, 'blocked');
    return r.t;
  };
  const mouse = async (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  const clickAt = async (x, y, clickCount = 1) => {
    await mouse('mouseMoved', x, y, { button: 'none' });
    for (let c = 1; c <= clickCount; c++) {
      await mouse('mousePressed', x, y, { clickCount: c });
      await mouse('mouseReleased', x, y, { clickCount: c });
    }
  };
  const key = async (name) => {
    const k = KEYS[name] || (name.length === 1 ? { code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: name } : null);
    if (!k) throw new StepFail(`tecla desconhecida: ${name}`, 'blocked');
    const base = { key: k.key || name, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  return async function runStep(s) {
    const timeout = s.timeout ?? (s.do.startsWith('expect') ? 6000 : 8000);
    const q = queryOf(s);
    switch (s.do) {
      case 'goto':
        await page.navigate(resolveUrl(s.url, baseUrl));
        await page.settle();
        return {};
      case 'reload':
        await page.send('Page.reload', {});
        await sleep(300);
        await page.settle();
        return {};
      case 'viewport':
        await page.send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: 1, mobile: Boolean(s.mobile) });
        await page.settle(3000);
        return {};
      case 'click':
      case 'dblclick': {
        const t = await locate(s, true, timeout);
        await clickAt(t.x, t.y, s.do === 'dblclick' ? 2 : 1);
        await page.settle(s.settle ?? 8000);
        return { detail: `<${t.tag}> ${t.name}` };
      }
      case 'hover': {
        const t = await locate(s, false, timeout);
        await mouse('mouseMoved', t.x, t.y, { button: 'none' });
        await sleep(250);
        return {};
      }
      case 'fill': {
        await locate(s, false, timeout);
        const ok = await inPage(`window.__dc.focus(${JSON.stringify(q)})`);
        if (!ok) throw new StepFail('não consegui focar o campo', 'blocked');
        const value = String(s.value ?? '');
        if (value) await page.send('Input.insertText', { text: value });
        else await key('Backspace');
        if (s.enter) await key('Enter');
        await page.settle(s.settle ?? 5000);
        return {};
      }
      case 'select': {
        await locate(s, false, timeout);
        const r = await inPage(`window.__dc.selectOption(${JSON.stringify(q)}, ${JSON.stringify(String(s.value))})`);
        if (r === 'not-select') throw new StepFail('o elemento não é um <select>: para listas do design system, use click no campo e depois click na opção', 'blocked');
        if (r === 'no-option') throw new StepFail(`opção "${s.value}" não existe`, 'fail');
        await page.settle(5000);
        return {};
      }
      case 'check': {
        const t = await locate(s, true, timeout);
        const want = s.value !== false;
        const cur = await inPage(`(() => { const el = window.__dc.find(${JSON.stringify(q)}); const i = el && (el.matches('input') ? el : el.querySelector('input[type=checkbox], input[type=radio]')); return i ? i.checked : (el?.getAttribute('aria-checked') === 'true'); })()`);
        if (cur !== want) await clickAt(t.x, t.y);
        await page.settle(5000);
        return {};
      }
      case 'press':
        for (const k of String(s.key).split('+').length > 1 ? [s.key] : String(s.key).split(' ')) await key(k);
        await page.settle(s.settle ?? 5000);
        return {};
      case 'scroll':
        if (hasQuery(q)) await locate(s, false, timeout);
        else await page.evaluate(`window.scrollTo(${Number(s.x ?? 0)}, ${Number(s.y ?? 0)})`);
        await sleep(250);
        return {};
      case 'wait': {
        if (s.ms) {
          await sleep(Number(s.ms));
          return {};
        }
        if (s.gone !== undefined) {
          const r = await pollUntil(async () => ({ ok: !(await inPage(`window.__dc.hasText(${JSON.stringify(String(s.gone))}, ${JSON.stringify(s.within ?? null)})`)) }), s.timeout ?? 15000);
          if (!r.ok) throw new StepFail(`"${s.gone}" não sumiu em ${(s.timeout ?? 15000) / 1000} s`, 'blocked');
          return {};
        }
        await locate(s, false, s.timeout ?? 15000);
        return {};
      }
      case 'eval': {
        const v = await page.evaluate(`(async () => { ${s.script ?? `return (${s.expr})`} })()`);
        await page.settle(5000);
        return { detail: v === undefined ? undefined : JSON.stringify(v).slice(0, 200), value: v };
      }
      case 'screenshot':
        return { shot: true };
      case 'expectText': {
        const r = await pollUntil(async () => ({ ok: await inPage(`window.__dc.hasText(${JSON.stringify(String(s.text))}, ${JSON.stringify(s.within ?? null)}, ${Boolean(s.exact)})`) }), timeout);
        if (!r.ok) throw new StepFail(`o texto "${s.text}" não aparece${s.within ? ` em \`${s.within}\`` : ''}`);
        return {};
      }
      case 'expectNoText': {
        const r = await pollUntil(async () => ({ ok: !(await inPage(`window.__dc.hasText(${JSON.stringify(String(s.text))}, ${JSON.stringify(s.within ?? null)}, ${Boolean(s.exact)})`)) }), s.timeout ?? 1500);
        if (!r.ok) throw new StepFail(`o texto "${s.text}" aparece, mas não deveria`);
        return {};
      }
      case 'expectVisible': {
        const r = await pollUntil(async () => ({ ok: (await inPage(`window.__dc.count(${JSON.stringify(q)})`)) > (q.index ?? 0) }), timeout);
        if (!r.ok) throw new StepFail(`${describeStep(s).replace(/^Ver /, '')} não está visível`);
        return {};
      }
      case 'expectHidden': {
        const r = await pollUntil(async () => ({ ok: (await inPage(`window.__dc.count(${JSON.stringify(q)})`)) === 0 }), s.timeout ?? 3000);
        if (!r.ok) throw new StepFail(`${describeStep(s).replace(/^Não ver /, '')} continua visível`);
        return {};
      }
      case 'expectUrl': {
        const r = await pollUntil(async () => {
          const href = await page.evaluate('location.href');
          const ok = s.contains !== undefined ? href.includes(s.contains) : new RegExp(s.match).test(href);
          return { ok, href };
        }, timeout);
        if (!r.ok) throw new StepFail(`endereço é ${r.href}`);
        return {};
      }
      case 'expectCount': {
        const r = await pollUntil(async () => {
          const n = await inPage(`window.__dc.count(${JSON.stringify(q)})`);
          const ok = s.count !== undefined ? n === s.count : n >= (s.min ?? 0) && n <= (s.max ?? Infinity);
          return { ok, n };
        }, timeout);
        if (!r.ok) throw new StepFail(`encontrei ${r.n}`);
        return { detail: `${r.n}` };
      }
      case 'expectValue': {
        const r = await pollUntil(async () => {
          const v = await inPage(`window.__dc.value(${JSON.stringify(q)})`);
          return { ok: v !== null && String(v).trim() === String(s.value).trim(), v };
        }, timeout);
        if (!r.ok) throw new StepFail(r.v === null ? 'campo não encontrado' : `valor é "${r.v}"`);
        return {};
      }
      case 'expectEval': {
        const r = await pollUntil(async () => {
          const v = await page.evaluate(`(async () => { ${s.script ?? `return (${s.expr})`} })()`).catch((e) => ({ __err: e.message }));
          return { ok: v === true || (v && typeof v === 'object' && v.ok === true), v };
        }, timeout);
        if (!r.ok) {
          const v = r.v;
          throw new StepFail(v?.__err ? `script falhou: ${v.__err}` : v && typeof v === 'object' && v.message ? v.message : `script devolveu ${JSON.stringify(v)?.slice(0, 200)}`);
        }
        return {};
      }
      default:
        throw new StepFail(`ação desconhecida: ${s.do}`, 'blocked');
    }
  };
}

const slug = (s) => String(s || 'print').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'print';

const panel0 = (r, sc, ctx) =>
  `window.__dcOverlay && window.__dcOverlay.set(${JSON.stringify({ count: ctx.position || '', readonly: ctx.readonly, scenario: `${sc.id} · ${sc.title}`, step: r.status === 'pass' ? 'Cenário passou' : `Cenário ${({ fail: 'falhou', blocked: 'bloqueado', warn: 'com ressalva' })[r.status] || r.status}${r.error ? `: ${r.error}` : ''}`, status: r.status === 'pass' ? 'pass' : 'fail', progress: 1 })})`;

async function runScenario(cdp, sc, plan, ctx) {
  const viewport = { ...(plan.viewport || {}), ...(sc.viewport || {}), ...(ctx.viewport || {}) };
  const page = await openPage(cdp, { width: viewport.width || 1440, height: viewport.height || 900, readonly: ctx.readonly });
  const runStep = makeStepRunner(page, { baseUrl: ctx.baseUrl });
  if (ctx.headed) {
    await page.send('Page.bringToFront').catch(() => undefined);
    const win = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId }).catch(() => null);
    if (win) await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', width: (viewport.width || 1440) + 16, height: (viewport.height || 900) + 110 } }).catch(() => undefined);
  }
  const overlay = async (expr) => {
    if (!ctx.headed) return;
    await page.evaluate(PAGE_HELPER).catch(() => undefined);
    await page.evaluate(OVERLAY_SCRIPT).catch(() => undefined);
    await page.evaluate(expr).catch(() => undefined);
  };
  const result = {
    id: sc.id,
    title: sc.title,
    ac: [].concat(sc.ac ?? []),
    tc: [].concat(sc.tc ?? []).map(Number),
    status: 'pass',
    verdict: null,
    note: sc.note || '',
    expected: sc.expected || '',
    steps: [],
    shots: [],
    console: [],
    network: [],
    references: [],
    startedAt: new Date().toISOString(),
  };
  const t0 = Date.now();
  let n = 0;
  for (const f of readdirSync(ctx.shotsDir)) if (f.startsWith(`${sc.id}-`) || f.startsWith(`ref-${sc.id}-`)) rmSync(path.join(ctx.shotsDir, f), { force: true });
  if (existsSync(path.join(ctx.shotsDir, 'web'))) for (const f of readdirSync(path.join(ctx.shotsDir, 'web'))) if (f.startsWith(`${sc.id}-`)) rmSync(path.join(ctx.shotsDir, 'web', f), { force: true });
  for (const [k, ref] of [].concat(sc.reference ?? []).entries()) {
    const src = path.resolve(ctx.planDir || '.', typeof ref === 'string' ? ref : ref.file);
    if (!existsSync(src)) {
      result.references.push({ missing: src, label: (typeof ref === 'object' && ref.label) || path.basename(src) });
      continue;
    }
    const file = `ref-${sc.id}-${k + 1}${path.extname(src) || '.png'}`;
    copyFileSync(src, path.join(ctx.shotsDir, file));
    result.references.push({ file, label: (typeof ref === 'object' && ref.label) || 'Referência' });
  }
  const drawMarks = async (marks, fullPage) => {
    if (!marks?.length) return null;
    await page.evaluate(PAGE_HELPER).catch(() => undefined);
    await page.evaluate(MARK_SCRIPT).catch(() => undefined);
    return page.evaluate(`window.__dcMark.draw(${JSON.stringify(marks)}, ${Boolean(fullPage)})`).catch(() => null);
  };
  const shoot = async (label, fullPage, marks) => {
    n++;
    const file = `${sc.id}-${String(n).padStart(2, '0')}-${slug(label)}.png`;
    if (ctx.headed) await page.evaluate('window.__dcOverlay && window.__dcOverlay.hide()').catch(() => undefined);
    const drawn = await drawMarks(marks, fullPage);
    const buf = await page.screenshot({ fullPage: Boolean(fullPage) });
    const web = await page.screenshot({ fullPage: Boolean(fullPage), format: 'jpeg', quality: 82 }).catch(() => null);
    if (drawn) await page.evaluate('window.__dcMark && window.__dcMark.clear()').catch(() => undefined);
    if (ctx.headed) await page.evaluate('window.__dcOverlay && window.__dcOverlay.show()').catch(() => undefined);
    writeFileSync(path.join(ctx.shotsDir, file), buf);
    if (web) {
      mkdirSync(path.join(ctx.shotsDir, 'web'), { recursive: true });
      writeFileSync(path.join(ctx.shotsDir, 'web', file.replace(/\.png$/, '.jpg')), web);
    }
    const shot = { file, label: label || 'tela' };
    if (drawn?.marks?.length) shot.marks = drawn.marks;
    if (drawn?.missing?.length) shot.missingMarks = drawn.missing;
    result.shots.push(shot);
    return file;
  };
  const steps = [...(plan.beforeEach || []).map((s) => ({ ...s, _setup: true })), ...sc.steps];
  if (ctx.baseUrl && !steps.some((s) => s.do === 'goto')) steps.unshift({ do: 'goto', url: ctx.baseUrl, _setup: true });
  let stopped = false;
  for (const [i, s] of steps.entries()) {
    const rec = { n: i + 1, do: s.do, desc: describeStep(s), status: 'pass', setup: Boolean(s._setup) || undefined };
    if (stopped) {
      rec.status = 'skipped';
      result.steps.push(rec);
      continue;
    }
    const st = Date.now();
    const panel = (step, status, progress = i / steps.length) =>
      `window.__dcOverlay && window.__dcOverlay.set(${JSON.stringify({ count: ctx.position || '', readonly: ctx.readonly, scenario: `${sc.id} · ${sc.title}`, step, status, progress })})`;
    try {
      if (ctx.headed && s.do !== 'goto' && s.do !== 'reload') {
        await overlay(panel(`Passo ${i + 1}/${steps.length}: ${rec.desc}`));
        if (/^(click|dblclick|hover|fill|select|check|expectVisible|expectValue|scroll)$/.test(s.do)) {
          await overlay(`window.__dcOverlay.highlight(${JSON.stringify(queryOf(s))})`);
        }
        if (ctx.slowMo) await sleep(ctx.slowMo);
        await overlay('window.__dcOverlay.clearHighlight()');
      }
      const r = await runStep(s);
      if (ctx.headed) await overlay(panel(`Passo ${i + 1}/${steps.length}: ${rec.desc}`, 'pass', (i + 1) / steps.length));
      if (r.detail) rec.detail = r.detail;
      if (s.save && r.value !== undefined) {
        const file = path.join(path.dirname(ctx.shotsDir), path.basename(String(s.save)));
        writeFileSync(file, typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2));
        rec.saved = path.basename(file);
      }
      if (r.shot || s.shot) rec.shot = await shoot(s.label || s.shot || rec.desc, s.fullPage, toMarks(marksOf(s)));
    } catch (e) {
      const kind = e instanceof StepFail ? e.kind : 'blocked';
      rec.status = s.optional ? 'warn' : kind;
      rec.error = e.message;
      if (ctx.headed) await overlay(panel(`Passo ${i + 1}/${steps.length}: ${rec.desc} — ${e.message}`, 'fail', (i + 1) / steps.length));
      const failMarks = [...(hasQuery(queryOf(s)) ? [{ ...queryOf(s), note: `${rec.desc} → ${e.message}` }] : []), ...marksOf(s)];
      rec.shot = await shoot(`Falha · ${rec.desc}`, false, toMarks(failMarks)).catch(() => undefined);
      if (ctx.headed && ctx.slowMo) await sleep(ctx.slowMo * 3);
      if (!s.optional) {
        result.status = kind;
        result.failedStep = rec.n;
        result.error = e.message;
        stopped = true;
      } else if (result.status === 'pass') result.status = 'warn';
    }
    rec.ms = Date.now() - st;
    result.steps.push(rec);
  }
  if (!result.shots.length && sc.finalShot !== false) {
    await shoot('final').catch(() => undefined);
  }
  const ignore = (u) => /favicon|hot-update|sockjs-node|__webpack_hmr|\/ws(\?|$)/i.test(u || '');
  result.console = page.events.console.slice(0, 30).map(({ level, text }) => ({ level, text }));
  result.network = page.events.network.filter((x) => !ignore(x.url) && !String(x.error || '').startsWith('net::ERR_BLOCKED_BY_CLIENT')).slice(0, 30).map(({ url, status, method, error }) => ({ url, status, method, error }));
  result.blockedRequests = page.events.blocked.slice(0, 30).map(({ method, url }) => ({ method, url }));
  result.durationMs = Date.now() - t0;
  if (ctx.headed) {
    await overlay(panel0(result, sc, ctx));
    if (ctx.slowMo) await sleep(ctx.slowMo * 2);
  }
  await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => undefined);
  return result;
}

export function summarize(scenarios) {
  const s = { total: scenarios.length, pass: 0, fail: 0, warn: 0, blocked: 0 };
  for (const sc of scenarios) s[finalStatus(sc)] = (s[finalStatus(sc)] || 0) + 1;
  return s;
}

export const finalStatus = (sc) => sc.verdict || sc.status;

function planUrls(plan, baseUrl) {
  return [baseUrl, ...[...(plan.beforeEach || []), ...plan.scenarios.flatMap((s) => s.steps || [])].filter((s) => s.do === 'goto' && /^[a-z]+:/i.test(s.url)).map((s) => s.url)].filter(Boolean);
}

export function needsReadonly(plan, baseUrl) {
  return planUrls(plan, baseUrl).some((u) => !isLocalUrl(u));
}

export async function runPlan(plan, { baseUrl, outDir, planDir, headed = false, slowMo, only, profileDir, viewport, readonly = 'auto', log = () => {} }) {
  const errs = validatePlan(plan);
  if (errs.length) throw new DeskcheckError(`plano inválido:\n- ${errs.join('\n- ')}`);
  const shotsDir = path.join(outDir, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const base = baseUrl || plan.baseUrl || null;
  const picked = plan.scenarios.filter((sc) => !only?.length || only.includes(sc.id));
  if (!picked.length) throw new DeskcheckError(`nenhum cenário com id ${only.join(', ')}`);
  const ro = readonly === 'auto' ? needsReadonly(plan, base) : Boolean(readonly);
  const denied = ro ? [] : planUrls(plan, base).filter((u) => !isWriteAllowedUrl(u));
  if (denied.length) throw new DeskcheckError(`escritas (--allow-writes) só valem em localhost e em ambientes de teste (dev, stg, uat...). Recusado: ${denied.join(', ')}`);
  if (!ro) log('Escritas liberadas só para localhost e hosts de teste (dev, stg, uat...): qualquer outro destino continua barrado na rede.\n');
  if (ro) log('Modo somente leitura: POST/PUT/PATCH/DELETE são barrados na rede (só o login da Microsoft passa).\n');
  const startedAt = new Date().toISOString();
  const scenarios = await withChrome({ profileDir, headless: !headed }, async (cdp) => {
    const out = [];
    for (const [k, sc] of picked.entries()) {
      log(`▶ ${sc.id} ${sc.title}\n`);
      const r = await runScenario(cdp, sc, plan, {
        baseUrl: base,
        shotsDir,
        viewport,
        readonly: ro,
        headed,
        slowMo: slowMo ?? (headed ? 500 : 0),
        position: `cenário ${k + 1} de ${picked.length}`,
        planDir,
      });
      log(`  ${statusIcon(r.status)} ${r.status}${r.error ? ` · passo ${r.failedStep}: ${r.error}` : ''}${r.blockedRequests?.length ? ` · ${r.blockedRequests.length} escrita(s) barrada(s)` : ''}\n`);
      out.push(r);
    }
    return out;
  });
  return {
    version: 1,
    workItem: plan.workItem ?? null,
    title: plan.title || null,
    baseUrl: base,
    readonly: ro,
    viewport: { width: 1440, height: 900, ...(plan.viewport || {}), ...(viewport || {}) },
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios,
    notTestable: (plan.notTestable || []).map(({ ref, reason }) => ({ ref: String(ref), reason: String(reason) })),
    summary: summarize(scenarios),
  };
}

export const statusIcon = (s) => ({ pass: '✅', fail: '❌', warn: '⚠️', blocked: '⛔', skipped: '·' })[s] || '?';
