export const PAGE_HELPER = String.raw`(() => {
  if (window.__dc && window.__dc.v === 1) return true;
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  const IMPLICIT = {
    button: 'button, input[type=button], input[type=submit], input[type=reset], summary',
    link: 'a[href]',
    textbox: 'input:not([type]), input[type=text], input[type=email], input[type=search], input[type=password], input[type=tel], input[type=url], input[type=number], textarea',
    searchbox: 'input[type=search]',
    checkbox: 'input[type=checkbox]',
    radio: 'input[type=radio]',
    combobox: 'select',
    listbox: 'select[multiple]',
    option: 'option',
    heading: 'h1, h2, h3, h4, h5, h6',
    img: 'img[alt]',
    table: 'table',
    row: 'tr',
    cell: 'td',
    columnheader: 'th',
    list: 'ul, ol',
    listitem: 'li',
    dialog: 'dialog',
    navigation: 'nav',
    main: 'main',
    form: 'form',
  };
  const byIdText = (ids) => norm(String(ids || '').split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '));
  const accName = (el) => {
    const a = el.getAttribute('aria-label');
    if (a) return norm(a);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = byIdText(lb); if (t) return t; }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return norm(l.innerText); }
    const wrap = el.closest('label');
    if (wrap && wrap !== el) return norm(wrap.innerText);
    if (el.tagName === 'IMG') return norm(el.alt);
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) return norm(el.value);
    const t = norm(el.innerText || el.textContent);
    if (t) return t;
    return norm(el.getAttribute('title') || el.getAttribute('placeholder') || '');
  };
  const matches = (hay, needle, exact) => (exact ? lower(hay) === lower(needle) : lower(hay).includes(lower(needle)));
  const INTERACTIVE = 'button, a[href], input, select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=option], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=combobox], [tabindex]:not([tabindex="-1"])';

  function byText(root, text, exact) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.currentNode; el; el = walker.nextNode()) {
      if (el.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HTML|HEAD)$/.test(el.tagName)) continue;
      const aria = matches(el.getAttribute('aria-label'), text, exact);
      if (el.tagName === 'INPUT') {
        if (aria || matches(el.value || el.placeholder, text, exact)) out.push(el);
        continue;
      }
      if (!aria && !lower(el.textContent).includes(lower(text).split(' ')[0])) continue;
      if (!aria && !matches(el.innerText ?? el.textContent, text, exact)) continue;
      const childHas = [...el.children].some((c) => matches(c.innerText ?? c.textContent, text, exact) && visible(c));
      if (!childHas) out.push(el);
    }
    return out.filter(visible);
  }

  function findAll(q) {
    const root = q.within ? document.querySelector(q.within) : document;
    if (!root) return [];
    let list;
    if (q.selector) list = [...root.querySelectorAll(q.selector)];
    else if (q.role) {
      const css = '[role="' + q.role + '"]' + (IMPLICIT[q.role] ? ', ' + IMPLICIT[q.role] : '');
      list = [...root.querySelectorAll(css)].filter((el) => !el.getAttribute('role') || el.getAttribute('role') === q.role);
      if (q.name !== undefined) list = list.filter((el) => matches(accName(el), q.name, q.exact));
    } else if (q.text !== undefined) list = byText(root === document ? document.body : root, q.text, q.exact);
    else if (q.label !== undefined) {
      list = [...root.querySelectorAll('input, select, textarea, [role=textbox], [role=combobox], [contenteditable=true]')].filter((el) => matches(accName(el) || el.placeholder, q.label, q.exact));
    } else if (q.placeholder !== undefined) list = [...root.querySelectorAll('[placeholder]')].filter((el) => matches(el.placeholder, q.placeholder, q.exact));
    else list = [];
    if (q.selector && q.text !== undefined) list = list.filter((el) => matches(el.innerText ?? el.textContent, q.text, q.exact));
    if (q.visible !== false) list = list.filter(visible);
    return list;
  }

  function find(q) {
    const list = findAll(q);
    const el = list[q.index ?? 0];
    return el || null;
  }

  function target(q, forClick) {
    let el = find(q);
    if (!el) return null;
    if (forClick && q.text !== undefined && !q.selector) el = el.closest(INTERACTIVE) || el;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const covered = top && top !== el && !el.contains(top) && !top.contains(el);
    return { x, y, tag: el.tagName.toLowerCase(), name: accName(el).slice(0, 80), covered: covered ? (top.tagName.toLowerCase() + (top.className && typeof top.className === 'string' ? '.' + top.className.split(' ')[0] : '')) : null };
  }

  window.__dc = {
    v: 1,
    norm,
    visible,
    accName,
    findAll,
    find,
    target,
    count: (q) => findAll(q).length,
    hasText: (text, within, exact) => findAll({ text, within, exact }).length > 0,
    focus: (q) => { const el = find(q); if (!el) return false; el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.focus(); if (typeof el.select === 'function') el.select(); else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } return true; },
    value: (q) => { const el = find(q); return el ? (el.value ?? norm(el.innerText)) : null; },
    selectOption: (q, opt) => {
      const el = find(q);
      if (!el || el.tagName !== 'SELECT') return 'not-select';
      const o = [...el.options].find((x) => x.value === opt || lower(x.text) === lower(opt)) || [...el.options].find((x) => lower(x.text).includes(lower(opt)));
      if (!o) return 'no-option';
      el.value = o.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    },
  };
  return true;
})()`;
