import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class DeskcheckError extends Error {}

export const DEFAULT_PROFILE = path.join(os.homedir(), '.cache', 'deskcheck', 'chrome');

export function chromeCandidates() {
  const list = [process.env.CHROME_PATH];
  if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      list.push(path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return list.filter(Boolean);
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result ?? {});
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('conexão com o Chrome fechou'));
      this.pending.clear();
    });
  }

  static connect(url, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
        }
        done(reject, new Error('não foi possível conectar ao Chrome'));
      }, timeoutMs);
      ws.addEventListener('open', () => done(resolve, new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => done(reject, new Error('não foi possível conectar ao Chrome')), { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitFor(method, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer;
      const onClose = () => {
        cleanup();
        reject(new Error('conexão com o Chrome fechou'));
      };
      const off = this.on((msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          cleanup();
          resolve(msg.params ?? {});
        }
      });
      const cleanup = () => {
        clearTimeout(timer);
        off();
        this.ws.removeEventListener('close', onClose);
      };
      this.ws.addEventListener('close', onClose);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`tempo esgotado esperando ${method}`));
      }, timeoutMs);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
    }
  }
}

export async function launchChrome({ profileDir = DEFAULT_PROFILE, headless = true, startUrl } = {}) {
  const chrome = chromeCandidates().find((p) => existsSync(p));
  if (!chrome) throw new DeskcheckError('Google Chrome, Chromium ou Edge não encontrado. Instale um deles ou defina CHROME_PATH.');
  mkdirSync(profileDir, { recursive: true });
  rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--disable-background-networking',
  ];
  if (headless) args.push('--headless=new', '--hide-scrollbars', '--mute-audio');
  args.push(startUrl || 'about:blank');
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const start = Date.now();
  let lines = [];
  for (;;) {
    if (existsSync(portFile)) {
      lines = readFileSync(portFile, 'utf8').trim().split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 2) break;
    }
    if (proc.exitCode !== null) {
      throw new DeskcheckError(`o Chrome fechou ao abrir. Outro Chrome pode estar usando o perfil ${profileDir}: feche-o ou use --profile <outra pasta>.`);
    }
    if (Date.now() - start > 20_000) {
      proc.kill('SIGKILL');
      throw new DeskcheckError('o Chrome não respondeu em 20 s.');
    }
    await sleep(100);
  }
  const [port, wsPath] = lines;
  return { proc, exited, wsUrl: `ws://127.0.0.1:${port}${wsPath}` };
}

export async function closeChrome(chrome) {
  try {
    const cdp = await Cdp.connect(chrome.wsUrl, 3000);
    await Promise.race([cdp.send('Browser.close'), sleep(3000)]).catch(() => undefined);
    cdp.close();
  } catch {
    chrome.proc.kill();
  }
  await Promise.race([chrome.exited, sleep(5000)]);
  if (chrome.proc.exitCode === null) chrome.proc.kill('SIGKILL');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const IDENTITY_HOSTS = [/(^|\.)login\.microsoftonline\.com$/i, /(^|\.)login\.microsoft\.com$/i, /(^|\.)login\.live\.com$/i, /\.b2clogin\.com$/i, /(^|\.)microsoftazuread-sso\.com$/i];

const bodyOf = (req) => req?.postData || (req?.postDataEntries || []).map((e) => Buffer.from(e.bytes || '', 'base64').toString('utf8')).join('');

const AUTH_HOST = /^(auth|sso|login|id|idp|keycloak)[.-]/i;
const isKeycloakAuth = (u) => {
  try {
    const { host, pathname } = new URL(u);
    const extra = String(process.env.DESKCHECK_AUTH_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (extra.includes(host.toLowerCase())) return true;
    return AUTH_HOST.test(host) && /^\/(auth\/)?realms\/[^/]+\/(broker|login-actions|protocol)\//.test(pathname);
  } catch {
    return false;
  }
};

const isIdentityUrl = (u) => {
  try {
    return IDENTITY_HOSTS.some((rx) => rx.test(new URL(u).host));
  } catch {
    return false;
  }
};

export function isReadRequest(method, url, { resourceType, headers = {}, postData = '' } = {}) {
  if (READ_METHODS.has(String(method).toUpperCase())) return true;
  try {
    const { protocol } = new URL(url);
    if (protocol === 'data:' || protocol === 'blob:') return true;
  } catch {
    return false;
  }
  if (isIdentityUrl(url) || isKeycloakAuth(url)) return true;
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const fromIdp = isIdentityUrl(h.origin) || isIdentityUrl(h.referer);
  const authBody = /(^|&)(SAMLResponse|code|id_token)=/.test(String(postData));
  return resourceType === 'Document' && fromIdp && authBody;
}

export function isLocalUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol === 'file:') return true;
    return /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i.test(hostname) || /\.(localhost|test)$/i.test(hostname);
  } catch {
    return false;
  }
}

const PROD_LABEL = /(^|[.-])(prd|prod|production)([.-]|$)/i;
const NONPROD_LABEL = /(^|[.-])(dev|development|stg|stage|staging|uat|qa|hml|homolog|sandbox|sbx|preview)([.-]|$)/i;
const NEVER_WRITE_HOST = /(^|\.)dev\.azure\.com$|(^|\.)visualstudio\.com$|(^|\.)github\.com$/i;

const hostList = (name) =>
  String(process.env[name] || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

const hostIn = (h, list) => list.some((x) => h === x || h.endsWith(`.${x}`));

export function isProdUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    const h = hostname.toLowerCase();
    return PROD_LABEL.test(h) || hostIn(h, hostList('DESKCHECK_PROD_HOSTS'));
  } catch {
    return false;
  }
}

export function isWriteAllowedUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (isLocalUrl(u)) return true;
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    const h = hostname.toLowerCase();
    if (NEVER_WRITE_HOST.test(h) || isProdUrl(u)) return false;
    return NONPROD_LABEL.test(h.split('.').slice(0, -1).join('.')) || hostIn(h, hostList('DESKCHECK_WRITE_HOSTS'));
  } catch {
    return false;
  }
}

export const DOM_QUIET_SCRIPT = `new Promise((resolve) => {
  let last = Date.now();
  const start = last;
  const obs = new MutationObserver(() => { last = Date.now(); });
  obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  const busy = () => document.querySelector('[aria-busy="true"], [class*="skeleton" i], [class*="spinner" i]');
  const tick = () => {
    const quiet = Date.now() - last > 500 && !busy();
    if (quiet || Date.now() - start > 15000) { obs.disconnect(); resolve(true); } else setTimeout(tick, 120);
  };
  tick();
})`;

export async function openPage(cdp, { width = 1440, height = 900, readonly = false } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Log.enable').catch(() => undefined);
  if (width && height) await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const inflight = new Map();
  let lastActivity = Date.now();
  const events = { console: [], network: [], blocked: [] };
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  if (readonly) await send('Network.setBypassServiceWorker', { bypass: true }).catch(() => undefined);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const guarded = new Set([sessionId]);
  const guardChild = async (child) => {
    guarded.add(child);
    const cs = (m, pr = {}) => cdp.send(m, pr, child);
    await cs('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }).catch(() => undefined);
    await cs('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => undefined);
    await cs('Runtime.runIfWaitingForDebugger').catch(() => undefined);
  };
  cdp.on((msg) => {
    if (!guarded.has(msg.sessionId)) return;
    const p = msg.params || {};
    if (msg.method === 'Target.attachedToTarget') guardChild(p.sessionId);
    else if (msg.method === 'Fetch.requestPaused') {
      const method = String(p.request?.method || 'GET').toUpperCase();
      if (isReadRequest(method, p.request?.url, { resourceType: p.resourceType, headers: p.request?.headers, postData: bodyOf(p.request) }) || (!readonly && isWriteAllowedUrl(p.request?.url))) {
        cdp.send('Fetch.continueRequest', { requestId: p.requestId }, msg.sessionId).catch(() => undefined);
      } else {
        events.blocked.push({ at: Date.now(), method, url: p.request?.url, frame: msg.sessionId === sessionId ? 'aba' : 'iframe/worker' });
        cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, msg.sessionId).catch(() => undefined);
      }
    }
  });
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params || {};
    switch (msg.method) {
      case 'Network.requestWillBeSent':
        inflight.set(p.requestId, { url: p.request?.url, method: p.request?.method, type: p.type });
        lastActivity = Date.now();
        break;
      case 'Network.responseReceived': {
        const req = inflight.get(p.requestId);
        if (p.response?.status >= 400) {
          events.network.push({ at: Date.now(), url: p.response.url, status: p.response.status, method: req?.method });
        }
        break;
      }
      case 'Network.loadingFinished':
        inflight.delete(p.requestId);
        lastActivity = Date.now();
        break;
      case 'Network.loadingFailed': {
        const req = inflight.get(p.requestId);
        inflight.delete(p.requestId);
        lastActivity = Date.now();
        if (!p.canceled && req) events.network.push({ at: Date.now(), url: req.url, status: 0, method: req.method, error: p.errorText });
        break;
      }
      case 'Runtime.exceptionThrown':
        events.console.push({ at: Date.now(), level: 'exception', text: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exceção' });
        break;
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'assert') {
          const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500);
          events.console.push({ at: Date.now(), level: 'error', text });
        }
        break;
      default:
    }
  });

  async function evaluate(expression, { awaitPromise = true } = {}) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description?.split('\n')[0] || d.text || 'erro ao executar na página');
    }
    return r.result?.value;
  }

  async function settle(maxMs = 15_000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (inflight.size === 0 && Date.now() - lastActivity > 400) break;
      await sleep(120);
    }
    await evaluate(DOM_QUIET_SCRIPT).catch(() => undefined);
    await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => undefined);
  }

  async function navigate(url, timeoutMs = 45_000) {
    const loaded = cdp.waitFor('Page.loadEventFired', sessionId, timeoutMs);
    loaded.catch(() => undefined);
    const nav = await send('Page.navigate', { url });
    if (nav.errorText) {
      const why = String(nav.errorText);
      if (/ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/.test(why)) throw new DeskcheckError(`nada respondendo em ${url} (a tela está no ar?)`);
      if (/ERR_NAME_NOT_RESOLVED/.test(why)) throw new DeskcheckError(`endereço não encontrado: ${url} (VPN?)`);
      throw new DeskcheckError(`não abriu ${url}: ${why}`);
    }
    if (!nav.loaderId) return;
    await loaded.catch(() => {
      throw new DeskcheckError(`a tela não terminou de carregar em ${timeoutMs / 1000} s: ${url}`);
    });
  }

  async function screenshot({ fullPage = false, format = 'png', quality } = {}) {
    const params = { format, captureBeyondViewport: fullPage, ...(format === 'jpeg' ? { quality: quality ?? 82 } : {}) };
    if (fullPage) {
      const { cssContentSize } = await send('Page.getLayoutMetrics');
      params.clip = { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.min(Math.ceil(cssContentSize.height), 8000), scale: 1 };
    }
    const shot = await send('Page.captureScreenshot', params);
    return Buffer.from(String(shot.data), 'base64');
  }

  return { targetId, sessionId, send, evaluate, settle, navigate, screenshot, events };
}

export async function guardBrowser(cdp) {
  const blocked = [];
  const guardSession = async (sessionId) => {
    const s = (m, p = {}) => cdp.send(m, p, sessionId);
    await s('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }).catch(() => undefined);
    await s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => undefined);
    await s('Runtime.runIfWaitingForDebugger').catch(() => undefined);
  };
  cdp.on((msg) => {
    const p = msg.params || {};
    if (msg.method === 'Target.attachedToTarget') guardSession(p.sessionId);
    else if (msg.method === 'Fetch.requestPaused') {
      const method = String(p.request?.method || 'GET').toUpperCase();
      if (isReadRequest(method, p.request?.url, { resourceType: p.resourceType, headers: p.request?.headers, postData: bodyOf(p.request) })) cdp.send('Fetch.continueRequest', { requestId: p.requestId }, msg.sessionId).catch(() => undefined);
      else {
        blocked.push({ method, url: p.request?.url, type: p.resourceType, origin: p.request?.headers?.Origin, referer: p.request?.headers?.Referer, body: bodyOf(p.request).length });
        cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, msg.sessionId).catch(() => undefined);
      }
    }
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const t of targetInfos.filter((x) => x.type === 'page' && !x.attached)) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    await guardSession(sessionId);
  }
  return blocked;
}

export async function loginWindow(url, profileDir = DEFAULT_PROFILE, log = (s) => process.stdout.write(s), { readonly = !isLocalUrl(url) && !/^https:\/\/dev\.azure\.com\//i.test(url) } = {}) {
  const chrome = await launchChrome({ profileDir, headless: false, startUrl: readonly ? 'about:blank' : url });
  let cdp = null;
  try {
    cdp = await Cdp.connect(chrome.wsUrl);
  } catch {
    cdp = null;
  }
  let blocked = null;
  if (readonly) {
    if (!cdp) {
      await closeChrome(chrome);
      throw new DeskcheckError('não consegui ligar o modo somente leitura na janela de login; nada foi aberto.');
    }
    blocked = await guardBrowser(cdp);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await cdp.send('Page.navigate', { url }, sessionId);
    log('Modo somente leitura: POST/PUT/PATCH/DELETE da aplicação são barrados nesta janela (o login da Microsoft passa).\n');
  }
  log(`Janela do Chrome aberta em ${url}.\nFaça o login e feche a janela; o login fica guardado em ${profileDir}.\n`);
  if (cdp) {
    let sawPage = false;
    let emptyPolls = 0;
    while (chrome.proc.exitCode === null) {
      const targets = await Promise.race([cdp.send('Target.getTargets').catch(() => null), chrome.exited.then(() => null)]);
      if (!targets) break;
      const pages = (targets.targetInfos || []).filter((t) => t.type === 'page');
      if (pages.length) {
        sawPage = true;
        emptyPolls = 0;
      } else if (sawPage || ++emptyPolls >= 10) break;
      await sleep(500);
    }
    cdp.close();
    if (chrome.proc.exitCode === null) await closeChrome(chrome);
  } else {
    await chrome.exited;
  }
  if (blocked?.length) {
    log(`Barradas ${blocked.length} escrita(s) durante o login (nenhuma chegou ao servidor):\n`);
    const seen = new Set();
    for (const b of blocked) {
      const u = new URL(b.url);
      const key = `${b.method} ${u.host}${u.pathname}`;
      if (seen.has(key)) continue;
      seen.add(key);
      log(`  - ${key} [${b.type || '?'}${b.type === 'Document' ? ` · origin ${b.origin || '-'} · corpo ${b.body} bytes` : ''}]\n`);
    }
  }
  log('Login guardado.\n');
}

export async function withChrome(opts, fn) {
  const chrome = await launchChrome(opts);
  const cdp = await Cdp.connect(chrome.wsUrl);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
    await closeChrome(chrome);
  }
}
