import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DeskcheckError, isLocalUrl, isWriteAllowedUrl, openPage, sleep, withChrome } from './cdp.mjs';
import { OVERLAY_SCRIPT } from './overlay.mjs';
import { PAGE_HELPER } from './page-helper.mjs';

export const ACTIONS = [
  'goto', 'reload', 'viewport', 'click', 'dblclick', 'hover', 'fill', 'select', 'check', 'press', 'scroll', 'wait', 'eval',
  'upload', 'dialog',
  'screenshot', 'expectText', 'expectNoText', 'expectVisible', 'expectHidden', 'expectUrl', 'expectCount', 'expectValue',
  'expectEval', 'expectRequest',
];

const MODIFIERS = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

const EDIT_COMMANDS = {
  a: 'selectAll',
  c: 'copy',
  v: 'paste',
  x: 'cut',
  z: 'undo',
  y: 'redo',
};

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
    if (!nt?.ref || !nt?.reason) errs.push(`notTestable ${i + 1}: precisa de "ref" (ex.: "AC-3" ou "TC 10209") e "reason"`);
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
    case 'upload': {
      const files = [].concat(s.files ?? s.file ?? []).map((f) => path.basename(String(f)));
      return `Enviar arquivo${files.length > 1 ? 's' : ''} "${files.join(', ')}"${q ? ` em ${q}` : ''}`;
    }
    case 'dialog': return `Próximo diálogo: ${s.action === 'dismiss' || s.accept === false ? 'cancelar' : 'aceitar'}`;
    case 'screenshot': return `Print "${s.label || 'tela'}"`;
    case 'expectText': return `Ver o texto "${s.text}"${s.within ? ` em \`${s.within}\`` : ''}`;
    case 'expectNoText': return `Não ver o texto "${s.text}"`;
    case 'expectVisible': return `Ver ${q}`;
    case 'expectHidden': return `Não ver ${q}`;
    case 'expectUrl': return `Endereço contém "${s.contains ?? s.match}"`;
    case 'expectCount': return `${q || `\`${s.selector}\``} aparece ${s.count ?? `${s.min ?? 0}–${s.max ?? '∞'}`} vez(es)`;
    case 'expectValue': return `${q} tem o valor "${s.value}"`;
    case 'expectEval': return s.desc || 'Verificação por script';
    case 'expectRequest': return `Requisição ${s.method ? `${String(s.method).toUpperCase()} ` : ''}"${s.urlContains ?? s.urlMatch ?? '*'}"${s.status !== undefined ? ` (${s.status})` : ''}`;
    default: return s.do;
  }
}

const queryOf = (s) => {
  const q = {};
  for (const k of ['selector', 'text', 'role', 'name', 'label', 'placeholder', 'exact', 'index', 'within']) if (s[k] !== undefined) q[k] = s[k];
  return q;
};
const hasQuery = (q) => ['selector', 'text', 'role', 'label', 'placeholder'].some((k) => q[k] !== undefined);

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

function makeStepRunner(page, { baseUrl, planDir }) {
  const ensureHelper = () => page.evaluate(PAGE_HELPER);
  const inPage = async (expr) => {
    await ensureHelper();
    return page.evaluate(expr);
  };
  const locate = async (s, forClick, timeout) => {
    const q = queryOf(s);
    if (!hasQuery(q)) throw new StepFail('o passo precisa de selector, text, role, label ou placeholder', 'blocked');
    let prev = null;
    const isStable = (a, b) => a && b && Math.abs(a.x - b.x) <= 1.5 && Math.abs(a.y - b.y) <= 1.5 && Math.abs(a.w - b.w) <= 1.5 && Math.abs(a.h - b.h) <= 1.5;
    const r = await pollUntil(async () => {
      const t = await inPage(`window.__dc.target(${JSON.stringify(q)}, ${forClick})`).catch(() => null);
      if (!t || t.covered || (forClick && t.disabled)) {
        prev = null;
        return { ok: false, t };
      }
      if (!forClick) return { ok: true, t };
      if (isStable(prev, t)) return { ok: true, t };
      prev = t;
      await sleep(45);
      const t2 = await inPage(`window.__dc.target(${JSON.stringify(q)}, ${forClick})`).catch(() => null);
      if (t2 && !t2.covered && !t2.disabled && isStable(t, t2)) return { ok: true, t: t2 };
      prev = t2;
      return { ok: false, t: t2 || t };
    }, timeout);
    if (!r.t) throw new StepFail(`não encontrei ${describeStep({ ...s, do: 'expectVisible' }).replace(/^Ver /, '')} na tela`, 'blocked');
    if (forClick && r.t.disabled) throw new StepFail(`o elemento <${r.t.tag}> "${r.t.name}" está desabilitado`, 'blocked');
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
  const key = async (combo) => {
    const parts = String(combo).split('+').filter(Boolean);
    const main = parts.pop() || '';
    let modifiers = 0;
    for (const m of parts) {
      const bit = MODIFIERS[m.toLowerCase()];
      if (!bit) throw new StepFail(`modificador desconhecido: ${m}`, 'blocked');
      modifiers |= bit;
    }
    const lookup = Object.keys(KEYS).find((x) => x.toLowerCase() === main.toLowerCase());
    let k = lookup ? { ...KEYS[lookup], key: KEYS[lookup].key || lookup } : null;
    if (!k && main.length === 1) {
      const up = main.toUpperCase();
      const code = /^[0-9]$/.test(main) ? `Digit${main}` : /^[A-Z]$/.test(up) ? `Key${up}` : main;
      k = { key: main, code, keyCode: up.charCodeAt(0), text: main };
    }
    if (!k) throw new StepFail(`tecla desconhecida: ${combo}`, 'blocked');
    const nonShiftMod = Boolean(modifiers & ~8);
    const sendText = !nonShiftMod && Boolean(k.text);
    const primaryMod = process.platform === 'darwin' ? 4 : 2;
    let commands;
    if (modifiers & primaryMod && !(modifiers & 1)) {
      const m = main.toLowerCase();
      if (m === 'z' && (modifiers & 8)) commands = ['redo'];
      else if (!(modifiers & 8) && EDIT_COMMANDS[m]) commands = [EDIT_COMMANDS[m]];
    }
    const base = {
      key: k.key || main,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
      ...(modifiers ? { modifiers } : {}),
    };
    await page.send('Input.dispatchKeyEvent', {
      type: sendText ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(sendText ? { text: k.text, unmodifiedText: k.text } : {}),
      ...(commands ? { commands } : {}),
    });
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
        await locate(s, true, timeout);
        const ok = await inPage(`window.__dc.focus(${JSON.stringify(q)})`);
        if (!ok) throw new StepFail('não consegui focar o campo', 'blocked');

        const selectAllCombo = process.platform === 'darwin' ? 'Meta+A' : 'Ctrl+A';
        await key(selectAllCombo);
        await key('Backspace');
        const value = String(s.value ?? '');
        if (value) await page.send('Input.insertText', { text: value });
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
        for (const k of String(s.key).trim().split(/\s+/).filter(Boolean)) await key(k);
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
      case 'upload': {
        const rawFiles = [].concat(s.files ?? s.file ?? []).filter(Boolean);
        if (!rawFiles.length) throw new StepFail('o passo upload precisa de "file" ou "files"', 'blocked');
        const files = rawFiles.map((f) => path.resolve(planDir || '.', String(f)));
        for (const f of files) {
          if (!existsSync(f)) throw new StepFail(`arquivo para upload não encontrado: ${f}`, 'blocked');
        }
        const r = await pollUntil(async () => {
          await ensureHelper();
          const res = await page.evaluateRemote(`window.__dc.findFileInput(${JSON.stringify(q)})`).catch(() => null);
          return { ok: Boolean(res?.objectId), res };
        }, timeout);
        if (!r.ok || !r.res?.objectId) throw new StepFail('campo de upload (<input type="file">) não encontrado na tela', 'blocked');
        try {
          await page.send('DOM.getDocument', { depth: 0 });
          const { nodeId } = await page.send('DOM.requestNode', { objectId: r.res.objectId });
          await page.send('DOM.setFileInputFiles', { nodeId, files });
        } finally {
          await page.send('Runtime.releaseObject', { objectId: r.res.objectId }).catch(() => undefined);
        }
        await page.settle(s.settle ?? 5000);
        return { detail: files.map((f) => path.basename(f)).join(', ') };
      }
      case 'dialog': {
        const accept = s.action !== 'dismiss' && s.accept !== false;
        const promptText = String(s.promptText ?? s.text ?? '');
        page.queueDialog({ accept, promptText });
        return { detail: accept ? (promptText ? `aceitar ("${promptText}")` : 'aceitar') : 'cancelar' };
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
      case 'expectRequest': {
        const wantMethod = s.method ? String(s.method).toUpperCase() : null;
        const urlRx = s.urlMatch ? new RegExp(s.urlMatch) : null;
        const wantStatus = s.status;
        const minCount = Number(s.minCount ?? 1);
        const statusMatches = (st) => {
          if (wantStatus === undefined || wantStatus === null) return true;
          if (st === null || st === undefined) return false;
          if (wantStatus === 'ok' || wantStatus === '2xx') return st >= 200 && st < 300;
          if (typeof wantStatus === 'string' && /^\dxx$/i.test(wantStatus)) return Math.floor(st / 100) === Number(wantStatus[0]);
          return Number(st) === Number(wantStatus);
        };
        const r = await pollUntil(async () => {
          const hits = (page.events.requests || []).filter((req) => {
            if (wantMethod && req.method !== wantMethod) return false;
            if (s.urlContains !== undefined && !String(req.url).includes(String(s.urlContains))) return false;
            if (urlRx && !urlRx.test(String(req.url))) return false;
            return statusMatches(req.status);
          });
          return { ok: hits.length >= minCount, hits };
        }, timeout);
        if (!r.ok) {
          const seen = (page.events.requests || []).slice(-6).map((x) => `${x.method} ${x.url.slice(0, 80)} (${x.status ?? 'pendente'})`).join('; ');
          throw new StepFail(`requisição esperada não encontrada${seen ? ` · vistas: ${seen}` : ' (nenhuma requisição XHR/Fetch registrada)'}`);
        }
        const hit = r.hits[r.hits.length - 1];
        const shortUrl = (() => { try { const u = new URL(hit.url); return `${u.pathname}${u.search}`.slice(0, 80); } catch { return hit.url.slice(0, 80); } })();
        return { detail: `${hit.method} ${shortUrl} → ${hit.status ?? '?'}` };
      }
      default:
        throw new StepFail(`ação desconhecida: ${s.do}`, 'blocked');
    }
  };
}

const slug = (s) => String(s || 'print').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'print';

const stepKind = (s) => (s._setup ? 'setup' : s.do === 'screenshot' ? 'shot' : s.do.startsWith('expect') ? 'assert' : 'action');

const panel0 = (r, sc, ctx) => {
  const tally = { ...(ctx.tally || { pass: 0, fail: 0, warn: 0, blocked: 0 }) };
  tally[r.status] = (tally[r.status] || 0) + 1;
  return `window.__dcOverlay && window.__dcOverlay.set(${JSON.stringify({ count: ctx.position || '', readonly: ctx.readonly, tally, scenario: `${sc.id} · ${sc.title}`, step: r.status === 'pass' ? 'Cenário passou' : `Cenário ${({ fail: 'falhou', blocked: 'bloqueado', warn: 'com ressalva' })[r.status] || r.status}${r.error ? `: ${r.error}` : ''}`, status: r.status === 'pass' ? 'pass' : 'fail', progress: 1 })})`;
};

async function runScenario(cdp, sc, plan, ctx) {
  const viewport = { ...(plan.viewport || {}), ...(sc.viewport || {}), ...(ctx.viewport || {}) };
  const page = await openPage(cdp, { width: viewport.width || 1440, height: viewport.height || 900, readonly: ctx.readonly });
  const runStep = makeStepRunner(page, { baseUrl: ctx.baseUrl, planDir: ctx.planDir });
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
    audit: null,
    startedAt: new Date().toISOString(),
  };
  const t0 = Date.now();
  let n = 0;
  let pendingMarks = [];

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
  const captureMarks = async (s, rec, kind) => {
    const q = queryOf(s);
    if (!hasQuery(q)) return;
    await page.evaluate(PAGE_HELPER).catch(() => undefined);
    const all = s.do === 'expectCount';
    const [raw, view] = await Promise.all([
      page.evaluate(`window.__dc && window.__dc.boxes(${JSON.stringify(q)}, { all: ${all}, max: 6 })`).catch(() => []),
      page.evaluate('window.__dc && window.__dc.viewState()').catch(() => null),
    ]);
    if (!Array.isArray(raw) || !raw.length) return;
    for (const b of raw) {
      if (b.w < 2 || b.h < 2) continue;
      pendingMarks.push({ step: rec.n, kind, status: rec.status, label: rec.desc, href: view?.href || '', hasModal: Boolean(view?.hasModal), ...b });
    }
    if (pendingMarks.length > 18) pendingMarks = pendingMarks.slice(-18);
  };
  const normalizeMarks = (raw, fullPage, docSize, curView) => {
    const seen = new Set();
    const out = [];
    for (const m of raw) {

      if (curView?.href && m.href && m.href !== curView.href) continue;
      if (curView && curView.hasModal !== m.hasModal) continue;
      const bw = fullPage && docSize?.w ? docSize.w : m.vw || 1;
      const bh = fullPage && docSize?.h ? docSize.h : m.vh || 1;
      const x = fullPage ? m.dx : m.vx;
      const y = fullPage ? m.dy : m.vy;
      if (x + m.w < 0 || y + m.h < 0 || x > bw || y > bh) continue;
      const xPct = +Math.max(0, Math.min(99, (x / bw) * 100)).toFixed(2);
      const yPct = +Math.max(0, Math.min(99, (y / bh) * 100)).toFixed(2);
      const wPct = +Math.max(0.5, Math.min(100 - xPct, (m.w / bw) * 100)).toFixed(2);
      const hPct = +Math.max(0.5, Math.min(100 - yPct, (m.h / bh) * 100)).toFixed(2);
      const key = `${m.step}:${Math.round(xPct)}:${Math.round(yPct)}:${Math.round(wPct)}:${Math.round(hPct)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ step: m.step, kind: m.kind, status: m.status, label: m.label, x: xPct, y: yPct, w: wPct, h: hPct });
    }
    return out;
  };
  const shoot = async (label, fullPage) => {
    n++;
    const file = `${sc.id}-${String(n).padStart(2, '0')}-${slug(label)}.png`;
    await page.evaluate(PAGE_HELPER).catch(() => undefined);
    const curView = await page.evaluate('window.__dc && window.__dc.viewState()').catch(() => null);
    if (ctx.headed) await page.evaluate('window.__dcOverlay && window.__dcOverlay.hide()').catch(() => undefined);
    let docSize = null;
    if (fullPage) {
      const m = await page.send('Page.getLayoutMetrics').catch(() => null);
      if (m?.cssContentSize) docSize = { w: Math.ceil(m.cssContentSize.width), h: Math.min(Math.ceil(m.cssContentSize.height), 8000) };
    }
    const buf = await page.screenshot({ fullPage: Boolean(fullPage) });

    const web = await page.screenshot({ fullPage: Boolean(fullPage), format: 'jpeg', quality: 82 }).catch(() => null);
    if (ctx.headed) await page.evaluate('window.__dcOverlay && window.__dcOverlay.show()').catch(() => undefined);
    writeFileSync(path.join(ctx.shotsDir, file), buf);
    if (web) {
      mkdirSync(path.join(ctx.shotsDir, 'web'), { recursive: true });
      writeFileSync(path.join(ctx.shotsDir, 'web', file.replace(/\.png$/, '.jpg')), web);
    }
    const marks = normalizeMarks(pendingMarks, Boolean(fullPage), docSize, curView);
    pendingMarks = [];
    result.shots.push({ file, label: label || 'tela', ...(marks.length ? { marks } : {}) });
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
    const kind = stepKind(s);
    const panel = (step, status, progress = i / steps.length) =>
      `window.__dcOverlay && window.__dcOverlay.set(${JSON.stringify({ count: ctx.position || '', readonly: ctx.readonly, tally: ctx.tally, kind, scenario: `${sc.id} · ${sc.title}`, step, status, progress })})`;
    try {
      if (ctx.headed && s.do !== 'goto' && s.do !== 'reload') {
        await overlay(panel(`Passo ${i + 1}/${steps.length}: ${rec.desc}`));
        if (/^(click|dblclick|hover|fill|select|check|expectVisible|expectValue|scroll)$/.test(s.do)) {
          await overlay(`window.__dcOverlay.highlight(${JSON.stringify(queryOf(s))})`);
        }
        if (ctx.slowMo) await sleep(ctx.slowMo);
        await overlay('window.__dcOverlay.clearHighlight()');
      }
      if (s.do === 'goto' || s.do === 'reload') pendingMarks = [];
      const r = await runStep(s);
      if (ctx.headed) await overlay(panel(`Passo ${i + 1}/${steps.length}: ${rec.desc}`, 'pass', (i + 1) / steps.length));
      if (r.detail) rec.detail = r.detail;
      if (/^(click|dblclick|hover|fill|select|check|expectVisible|expectValue|expectText|expectCount)$/.test(s.do)) {
        await captureMarks(s, rec, kind);
      }
      if (s.save && r.value !== undefined) {

        const file = path.join(path.dirname(ctx.shotsDir), path.basename(String(s.save)));
        writeFileSync(file, typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2));
        rec.saved = path.basename(file);
      }
      if (r.shot || s.shot) rec.shot = await shoot(s.label || s.shot || rec.desc, s.fullPage);
    } catch (e) {
      const kindErr = e instanceof StepFail ? e.kind : 'blocked';
      rec.status = s.optional ? 'warn' : kindErr;
      rec.error = e.message;
      await captureMarks(s, rec, 'fail');
      if (ctx.headed) await overlay(panel(`Passo ${i + 1}/${steps.length}: ${rec.desc} — ${e.message}`, 'fail', (i + 1) / steps.length));
      rec.shot = await shoot(`Falha · ${rec.desc}`).catch(() => undefined);
      if (ctx.headed && ctx.slowMo) await sleep(ctx.slowMo * 3);
      if (!s.optional) {
        result.status = kindErr;
        result.failedStep = rec.n;
        result.error = e.message;
        stopped = true;
      } else if (result.status === 'pass') result.status = 'warn';
    }
    rec.ms = Date.now() - st;
    result.steps.push(rec);
  }

  if (sc.audit !== false) {
    await page.evaluate(PAGE_HELPER).catch(() => undefined);
    result.audit = await page.evaluate('window.__dc && window.__dc.audit()').catch(() => null);
  }

  if (!result.shots.length && sc.finalShot !== false) {
    await shoot('final').catch(() => undefined);
  }
  const ignore = (u) => /favicon|hot-update|sockjs-node|__webpack_hmr|\/ws(\?|$)/i.test(u || '');
  result.console = page.events.console.slice(0, 30).map(({ level, text }) => ({ level, text }));
  result.network = page.events.network.filter((x) => !ignore(x.url) && !String(x.error || '').startsWith('net::ERR_BLOCKED_BY_CLIENT')).slice(0, 30).map(({ url, status, method, error }) => ({ url, status, method, error }));

  result.requests = (page.events.requests || [])
    .filter((x) => !ignore(x.url))
    .slice(-40)
    .map(({ method, url, status, type, ms }) => ({ method, url, status, type, ms }));

  result.blockedRequests = page.events.blocked.slice(0, 30).map(({ method, url }) => ({ method, url }));
  if (page.events.dialogs?.length) {
    result.dialogs = page.events.dialogs.slice(0, 30).map(({ type, message, action, promptText }) => ({ type, message, action, ...(promptText !== undefined ? { promptText } : {}) }));
  }

  const strictMode = sc.strict ?? plan.strict ?? ctx.strict ?? false;
  if (strictMode && result.status === 'pass') {
    const reasons = [];
    const jsExceptions = result.console.filter((c) => c.level === 'exception').length;
    const http5xx = result.network.filter((n) => Number(n.status) >= 500).length;
    const brokenImgs = result.audit?.brokenImages?.length || 0;
    const hOverflow = result.audit?.horizontalOverflow ? 1 : 0;
    if (jsExceptions) reasons.push(`${jsExceptions} exceção(ões) JS no console`);
    if (http5xx) reasons.push(`${http5xx} erro(s) HTTP 5xx`);
    if (brokenImgs) reasons.push(`${brokenImgs} imagem(ns) quebrada(s)`);
    if (hOverflow) reasons.push(`overflow horizontal (+${result.audit.horizontalOverflow.overflowPx}px)`);
    if (reasons.length) {
      result.status = strictMode === 'fail' ? 'fail' : 'warn';
      result.strictReasons = reasons;
      if (!result.note) result.note = `Modo estrito: ${reasons.join(' · ')}.`;
    }
  }

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

export async function runPlan(plan, { baseUrl, outDir, planDir, headed = false, slowMo, only, profileDir, viewport, readonly = 'auto', strict = false, retries = 0, log = () => {} }) {
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
    const tally = { pass: 0, fail: 0, warn: 0, blocked: 0 };
    for (const [k, sc] of picked.entries()) {
      const maxRetries = Math.max(0, Number(sc.retries ?? plan.retries ?? retries ?? 0) || 0);
      let r = null;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        log(attempt === 1 ? `▶ ${sc.id} ${sc.title}\n` : `  ↻ ${sc.id} nova tentativa (${attempt}/${maxRetries + 1})\n`);
        r = await runScenario(cdp, sc, plan, {
          baseUrl: base,
          shotsDir,
          viewport,
          readonly: ro,
          strict,
          headed,
          slowMo: slowMo ?? (headed ? 500 : 0),
          position: `cenário ${k + 1} de ${picked.length}`,
          tally: { ...tally },
          planDir,
        });
        if (attempt > 1) r.attempts = attempt;
        if (r.status === 'pass' || r.status === 'warn') {
          if (attempt > 1) r.flaky = true;
          break;
        }
      }
      tally[r.status] = (tally[r.status] || 0) + 1;
      log(`  ${statusIcon(r.status)} ${r.status}${r.flaky ? ` (flaky · ${r.attempts} tentativas)` : ''}${r.error ? ` · passo ${r.failedStep}: ${r.error}` : ''}${r.blockedRequests?.length ? ` · ${r.blockedRequests.length} escrita(s) barrada(s)` : ''}\n`);
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
    strict: Boolean(strict || plan.strict),
    viewport: { width: 1440, height: 900, ...(plan.viewport || {}), ...(viewport || {}) },
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios,
    notTestable: (plan.notTestable || []).map(({ ref, reason }) => ({ ref: String(ref), reason: String(reason) })),
    summary: summarize(scenarios),
  };
}

export const statusIcon = (s) => ({ pass: '✅', fail: '❌', warn: '⚠️', blocked: '⛔', skipped: '·' })[s] || '?';
