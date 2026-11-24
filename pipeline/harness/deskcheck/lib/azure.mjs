import { DeskcheckError, openPage, sleep } from './cdp.mjs';

export const DEFAULT_ORG = process.env.DESKCHECK_ORG || '';
export const DEFAULT_PROJECT = process.env.DESKCHECK_PROJECT || '';

const API = '7.1';
const COMMENTS_API = '7.1-preview.4';

export function orgUrl(org = DEFAULT_ORG) {
  return `https://dev.azure.com/${encodeURIComponent(org)}`;
}

export function workItemLink(id, { org = DEFAULT_ORG, project = DEFAULT_PROJECT } = {}) {
  return `${orgUrl(org)}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

export async function browserTransport(cdp, { org = DEFAULT_ORG } = {}) {
  const page = await openPage(cdp, { width: 1280, height: 800 });
  await page.navigate(`${orgUrl(org)}/`).catch(() => undefined);
  let href = '';
  for (let i = 0; i < 60; i++) {
    href = await page.evaluate('location.href').catch(() => '');
    const ready = await page.evaluate('document.readyState').catch(() => '');
    if (/^https:\/\/dev\.azure\.com\//i.test(href) && ready === 'complete') break;
    await sleep(500);
  }
  if (!/^https:\/\/dev\.azure\.com\//i.test(href)) {
    const host = (() => { try { return new URL(href).host; } catch { return href || '?'; } })();
    throw new DeskcheckError(`sem login no Azure DevOps (a aba parou em ${host}). Rode: deskcheck login`);
  }
  return async function transport(method, url, { json, binaryBase64, contentType } = {}) {
    const init = {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-TFS-FedAuthRedirect': 'Suppress',
        'X-VSS-ReauthenticationAction': 'Suppress',
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
    };
    const bodyExpr = binaryBase64 !== undefined
      ? `Uint8Array.from(atob(${JSON.stringify(binaryBase64)}), (c) => c.charCodeAt(0))`
      : json !== undefined
        ? JSON.stringify(JSON.stringify(json))
        : 'undefined';
    const expr = `(async () => {
      const init = ${JSON.stringify(init)};
      init.body = ${bodyExpr};
      const r = await fetch(${JSON.stringify(url)}, init);
      return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
    })()`;
    return page.evaluate(expr);
  };
}

function parseResponse(res, what) {
  if (res.status === 401 || res.status === 403 || (res.status < 400 && /text\/html/i.test(res.type))) {
    throw new DeskcheckError(`sem permissão ou sem login no Azure (${what}: HTTP ${res.status}). Rode: deskcheck login`);
  }
  let body = null;
  try {
    body = res.text ? JSON.parse(res.text) : {};
  } catch {
    body = { raw: res.text?.slice(0, 500) };
  }
  if (res.status >= 400) {
    const msg = body?.message || body?.raw || `HTTP ${res.status}`;
    throw new DeskcheckError(`Azure recusou ${what}: ${msg}`);
  }
  return body;
}

export function createAzure(transport, { org = DEFAULT_ORG, project = DEFAULT_PROJECT, allowWrite = false } = {}) {
  const base = `${orgUrl(org)}/${encodeURIComponent(project)}/_apis`;
  const call = async (method, url, opts, what) => parseResponse(await transport(method, url, opts), what);
  const guard = (what) => {
    if (!allowWrite) throw new DeskcheckError(`escrita bloqueada (${what}): só o comando "deskcheck apply <código>" grava no Azure, depois do OK do usuário.`);
  };

  return {
    org,
    project,
    link: (id) => workItemLink(id, { org, project }),
    apiUrl: (id) => `${orgUrl(org)}/_apis/wit/workItems/${id}`,

    whoami: async () => {
      const d = await call('GET', `${orgUrl(org)}/_apis/connectionData?api-version=7.1-preview`, {}, 'connectionData');
      const u = d.authenticatedUser || {};
      if (!u.id || /anonymous/i.test(`${u.descriptor || ''} ${u.providerDisplayName || ''}`)) {
        throw new DeskcheckError('o Azure respondeu como anônimo. Rode: deskcheck login');
      }
      return { name: u.providerDisplayName || u.customDisplayName || u.id, id: u.id };
    },

    getWorkItem: (id, { expand = 'relations' } = {}) =>
      call('GET', `${base}/wit/workitems/${id}?api-version=${API}${expand ? `&$expand=${expand}` : ''}`, {}, `work item ${id}`),

    getWorkItems: async (ids, fields) => {
      const out = [];
      const list = [...new Set(ids.map(String))];
      for (let i = 0; i < list.length; i += 200) {
        const q = list.slice(i, i + 200).join(',');
        const f = fields?.length ? `&fields=${fields.join(',')}` : '';
        const d = await call('GET', `${base}/wit/workitems?ids=${q}${f}&errorPolicy=omit&api-version=${API}`, {}, 'work items');
        out.push(...(d.value || []).filter(Boolean));
      }
      return out;
    },

    getComments: async (id) => (await call('GET', `${base}/wit/workItems/${id}/comments?api-version=${COMMENTS_API}`, {}, `comentários de ${id}`)).comments || [],

    createWorkItem: async (type, ops, { validateOnly = false } = {}) => {
      if (!validateOnly) guard(`criar ${type}`);
      const v = validateOnly ? '&validateOnly=true' : '';
      return call('POST', `${base}/wit/workitems/$${encodeURIComponent(type)}?api-version=${API}${v}`, { json: ops, contentType: 'application/json-patch+json' }, `criar ${type}`);
    },

    updateWorkItem: async (id, ops, { validateOnly = false } = {}) => {
      if (!validateOnly) guard(`alterar ${id}`);
      const v = validateOnly ? '&validateOnly=true' : '';
      return call('PATCH', `${base}/wit/workitems/${id}?api-version=${API}${v}`, { json: ops, contentType: 'application/json-patch+json' }, `alterar ${id}`);
    },

    uploadAttachment: async (fileName, buffer) => {
      guard(`anexar ${fileName}`);
      const d = await call(
        'POST',
        `${base}/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=${API}`,
        { binaryBase64: Buffer.from(buffer).toString('base64'), contentType: 'application/octet-stream' },
        `anexar ${fileName}`,
      );
      return String(d.url).split('?')[0];
    },

    addComment: async (id, html) => {
      guard(`comentar em ${id}`);
      return call('POST', `${base}/wit/workItems/${id}/comments?api-version=${COMMENTS_API}`, { json: { text: html }, contentType: 'application/json' }, `comentar em ${id}`);
    },
  };
}
