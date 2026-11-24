import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { isLocalUrl, openPage, sleep, withChrome } from './cdp.mjs';
import { PAGE_HELPER } from './page-helper.mjs';

const COLLECT = String.raw`(() => {
  const vis = (el) => window.__dc.visible(el);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const roleOf = (el) => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' })[el.tagName]
    || (el.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', search: 'searchbox' })[el.type] || 'textbox' : el.tagName.toLowerCase());
  const controls = [...document.querySelectorAll('a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=combobox]')]
    .filter(vis)
    .map((el) => ({ role: roleOf(el), name: norm(window.__dc.accName(el)).slice(0, 80), testid: el.getAttribute('data-testid') || undefined, href: el.tagName === 'A' ? el.getAttribute('href') : undefined }))
    .filter((c, i, arr) => arr.findIndex((x) => x.role === c.role && x.name === c.name && x.testid === c.testid) === i)
    .slice(0, 150);
  const testids = {};
  for (const el of document.querySelectorAll('[data-testid]')) {
    if (!vis(el)) continue;
    const id = el.getAttribute('data-testid').replace(/\d+$/, '#');
    testids[id] = (testids[id] || 0) + 1;
  }
  const headings = [...document.querySelectorAll('h1,h2,h3,[role=heading]')].filter(vis).map((h) => ({ level: h.tagName, text: norm(h.innerText).slice(0, 120) })).slice(0, 60);
  return { url: location.href, title: document.title, headings, controls, testids, text: document.body.innerText.slice(0, 12000) };
})()`;

export async function explore(url, { outDir, headed = false, profileDir, width = 1440, height = 900, readonly, wait = 1500 }) {
  const ro = readonly ?? !isLocalUrl(url);
  return withChrome({ profileDir, headless: !headed }, async (cdp) => {
    const page = await openPage(cdp, { width, height, readonly: ro });
    await page.navigate(url);
    await page.settle();
    await sleep(wait);
    await page.evaluate(PAGE_HELPER);
    const data = await page.evaluate(COLLECT);
    const shot = await page.screenshot({ fullPage: true });
    writeFileSync(path.join(outDir, 'explore.png'), shot);
    const result = { ...data, readonly: ro, viewport: { width, height }, blockedRequests: page.events.blocked.length, at: new Date().toISOString() };
    writeFileSync(path.join(outDir, 'explore.json'), JSON.stringify(result, null, 2));
    return result;
  });
}

export function exploreSummary(r) {
  const L = [`Tela: ${r.url} (${r.viewport.width}×${r.viewport.height})${r.readonly ? ' · somente leitura' : ''}`, `Título: ${r.title || '-'}`];
  if (r.headings.length) L.push('', 'Títulos:', ...r.headings.slice(0, 20).map((h) => `  ${h.level} ${h.text}`));
  const ids = Object.entries(r.testids).sort((a, b) => a[0].localeCompare(b[0]));
  if (ids.length) L.push('', `data-testid (${ids.length}):`, ...ids.slice(0, 40).map(([k, n]) => `  ${k}${n > 1 ? ` ×${n}` : ''}`));
  if (r.controls.length) L.push('', `Controles (${r.controls.length}):`, ...r.controls.slice(0, 40).map((c) => `  ${c.role} "${c.name}"${c.testid ? ` [${c.testid}]` : ''}`));
  return L.join('\n');
}
