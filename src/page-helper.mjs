export const PAGE_HELPER = String.raw`
(() => {
  if (window.__dc && window.__dc.v === 5) return true;
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();
  const winOf = (el) => (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
  const frameElOf = (el) => {
    try {
      const w = el && el.ownerDocument && el.ownerDocument.defaultView;
      return w && w !== window ? w.frameElement : null;
    } catch {
      return null;
    }
  };
  const frameDocOf = (el) => {
    if (!el || el.tagName !== 'IFRAME') return null;
    try {
      const d = el.contentDocument;
      return d && d.documentElement ? d : null;
    } catch {
      return null;
    }
  };
  const parentDeep = (e) => {
    if (!e) return null;
    if (e.parentElement) return e.parentElement;
    const rn = e.getRootNode && e.getRootNode();
    if (rn && rn.host) return rn.host;
    return frameElOf(e);
  };
  const frameOffsetOf = (el) => {
    let ox = 0;
    let oy = 0;
    let cur = frameElOf(el);
    let guard = 0;
    while (cur && guard++ < 10) {
      const r = cur.getBoundingClientRect();
      ox += r.left + (cur.clientLeft || 0);
      oy += r.top + (cur.clientTop || 0);
      cur = frameElOf(cur);
    }
    return { ox, oy };
  };
  const globalRect = (el) => {
    const r = el.getBoundingClientRect();
    const { ox, oy } = frameOffsetOf(el);
    return {
      left: r.left + ox,
      top: r.top + oy,
      right: r.right + ox,
      bottom: r.bottom + oy,
      width: r.width,
      height: r.height,
    };
  };
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e; ) {
      if (e.nodeType === 1) {
        const cs = winOf(e).getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) return false;
        e = parentDeep(e);
      } else {
        e = e.host || null;
      }
    }
    return true;
  };
  const isDisabled = (el) => {
    if (!el) return false;
    if (el.disabled === true) return true;
    const aria = el.getAttribute && el.getAttribute('aria-disabled');
    if (aria === 'true') return true;
    if (el.closest && el.closest('fieldset[disabled]')) return true;
    return false;
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
  const rootOf = (el) => (el && el.getRootNode ? el.getRootNode() : document);
  const byIdText = (ids, root, ownerDoc) => {
    const scope = root && root.getElementById ? root : ownerDoc || document;
    const doc = ownerDoc || document;
    return norm(String(ids || '').split(/\s+/).map((id) => (scope.getElementById(id) || doc.getElementById(id))?.innerText || '').join(' '));
  };
  const accName = (el) => {
    const a = el.getAttribute('aria-label');
    if (a) return norm(a);
    const doc = el.ownerDocument || document;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = byIdText(lb, rootOf(el), doc); if (t) return t; }
    if (el.id) {
      const r = rootOf(el);
      const escId = (winOf(el).CSS || CSS).escape(el.id);
      const l = (r.querySelector && r.querySelector('label[for="' + escId + '"]')) || doc.querySelector('label[for="' + escId + '"]');
      if (l) return norm(l.innerText);
    }
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

  function walkDeep(root, visit) {
    if (!root) return;
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;
      if (cur.nodeType === 1) {
        if (cur.id === '__deskcheck_overlay') continue;
        if (visit(cur) === false) continue;
        if (cur.shadowRoot) stack.push(cur.shadowRoot);
        const fdoc = frameDocOf(cur);
        if (fdoc && visible(cur)) stack.push(fdoc.body || fdoc.documentElement);
      }
      const kids = cur.children;
      if (kids && kids.length) {
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
    }
  }

  function queryDeep(root, selector) {
    const out = [];
    const seen = new Set();
    const visitRoot = (r) => {
      if (!r || !r.querySelectorAll) return;
      try {
        for (const el of r.querySelectorAll(selector)) {
          if (el.id === '__deskcheck_overlay' || seen.has(el)) continue;
          seen.add(el);
          out.push(el);
        }
      } catch {

      }
      const all = r.querySelectorAll('*');
      for (const el of all) {
        if (el.id === '__deskcheck_overlay') continue;
        if (el.shadowRoot) visitRoot(el.shadowRoot);
        const fdoc = frameDocOf(el);
        if (fdoc) visitRoot(fdoc);
      }
    };
    visitRoot(root);
    return out;
  }

  function deepElementFromPoint(x, y) {
    let doc = document;
    let cx = x;
    let cy = y;
    let el = doc.elementFromPoint(cx, cy);
    let guard = 0;
    while (el && guard++ < 15) {
      if (el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(cx, cy);
        if (!inner || inner === el) break;
        el = inner;
        continue;
      }
      const fdoc = frameDocOf(el);
      if (fdoc) {
        const r = el.getBoundingClientRect();
        cx = cx - r.left - (el.clientLeft || 0);
        cy = cy - r.top - (el.clientTop || 0);
        const inner = fdoc.elementFromPoint(cx, cy);
        if (!inner || inner === el) break;
        doc = fdoc;
        el = inner;
        continue;
      }
      break;
    }
    return el;
  }

  function containsDeep(outer, inner) {
    if (!outer || !inner) return false;
    if (outer === inner) return true;
    try {
      if (outer.contains && outer.contains(inner)) return true;
    } catch {

    }
    for (let e = inner; e; ) {
      if (e === outer) return true;
      e = parentDeep(e);
    }
    return false;
  }

  function byText(root, text, exact) {
    const out = [];
    const firstWord = lower(text).split(' ')[0];
    walkDeep(root, (el) => {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HTML|HEAD)$/.test(el.tagName)) return false;
      if (el.tagName === 'IFRAME') return;
      const aria = matches(el.getAttribute('aria-label'), text, exact);
      if (el.tagName === 'INPUT') {
        if (aria || matches(el.value || el.placeholder, text, exact)) out.push(el);
        return;
      }
      if (!aria && !lower(el.textContent).includes(firstWord)) return;
      if (!aria && !matches(el.innerText ?? el.textContent, text, exact)) return;
      const childList = [...el.children, ...(el.shadowRoot ? [...el.shadowRoot.children] : [])];
      const childHas = childList.some((c) => matches(c.innerText ?? c.textContent, text, exact) && visible(c));
      if (!childHas) out.push(el);
    });
    return out.filter(visible);
  }

  function findAll(q) {
    const root = q.within ? queryDeep(document, q.within)[0] : document;
    if (!root) return [];
    let list;
    if (q.selector) list = queryDeep(root, q.selector);
    else if (q.role) {
      const css = '[role="' + q.role + '"]' + (IMPLICIT[q.role] ? ', ' + IMPLICIT[q.role] : '');
      list = queryDeep(root, css).filter((el) => !el.getAttribute('role') || el.getAttribute('role') === q.role);
      if (q.name !== undefined) list = list.filter((el) => matches(accName(el), q.name, q.exact));
    } else if (q.text !== undefined) list = byText(root === document ? document.body : root, q.text, q.exact);
    else if (q.label !== undefined) {
      list = queryDeep(root, 'input, select, textarea, [role=textbox], [role=combobox], [contenteditable=true]').filter((el) => matches(accName(el) || el.placeholder, q.label, q.exact));
    } else if (q.placeholder !== undefined) list = queryDeep(root, '[placeholder]').filter((el) => matches(el.placeholder, q.placeholder, q.exact));
    else list = [];
    list = list.filter((el) => el.id !== '__deskcheck_overlay');
    if (q.selector && q.text !== undefined) list = list.filter((el) => matches(el.innerText ?? el.textContent, q.text, q.exact));
    if (q.visible !== false) list = list.filter(visible);
    return list;
  }

  function find(q) {
    const list = findAll(q);
    const el = list[q.index ?? 0];
    return el || null;
  }

  function findFileInput(q) {
    const root = q && q.within ? queryDeep(document, q.within)[0] : document;
    if (!root) return null;
    if (q && (q.selector || q.label !== undefined || q.role || q.placeholder !== undefined || q.text !== undefined)) {
      const hits = findAll({ ...q, visible: false });
      for (const h of hits) {
        if (h.tagName === 'INPUT' && h.type === 'file') return h;
        if (h.tagName === 'LABEL' && h.control && h.control.type === 'file') return h.control;
        const inner = h.querySelector && h.querySelector('input[type=file]');
        if (inner) return inner;
      }
    }
    const all = queryDeep(root, 'input[type=file]');
    return all[q?.index ?? 0] || null;
  }

  function target(q, forClick) {
    let el = find(q);
    if (!el) return null;
    if (forClick && q.text !== undefined && !q.selector) el = el.closest(INTERACTIVE) || el;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const frameEl = frameElOf(el);
    if (frameEl) frameEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = globalRect(el);
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const disabled = Boolean(forClick && isDisabled(el));
    const top = deepElementFromPoint(x, y);
    const covered = top && !containsDeep(el, top) && !containsDeep(top, el);
    return {
      x,
      y,
      w: r.width,
      h: r.height,
      tag: el.tagName.toLowerCase(),
      name: accName(el).slice(0, 80),
      disabled,
      covered: covered ? (top.tagName.toLowerCase() + (top.className && typeof top.className === 'string' ? '.' + top.className.split(' ')[0] : '')) : null,
    };
  }

  function describeEl(el) {
    const tag = el.tagName.toLowerCase();
    const tid = el.getAttribute('data-testid');
    if (tid) return tag + '[data-testid="' + tid + '"]';
    if (el.id) return tag + '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    return cls ? tag + '.' + cls : tag;
  }

  function boxes(q, { all = false, max = 6 } = {}) {
    const els = all ? findAll(q).slice(0, max) : [find(q)].filter(Boolean);
    if (!els.length) return [];
    const vw = window.innerWidth || document.documentElement.clientWidth || 1;
    const vh = window.innerHeight || document.documentElement.clientHeight || 1;
    const sx = window.scrollX || 0;
    const sy = window.scrollY || 0;
    return els.map((el) => {
      const r = globalRect(el);
      return {
        vx: Math.round(r.left),
        vy: Math.round(r.top),
        dx: Math.round(r.left + sx),
        dy: Math.round(r.top + sy),
        w: Math.round(r.width),
        h: Math.round(r.height),
        vw,
        vh,
        tag: el.tagName.toLowerCase(),
        name: accName(el).slice(0, 60),
      };
    });
  }

  function audit() {
    const vw = window.innerWidth || document.documentElement.clientWidth || 1;
    const vh = window.innerHeight || document.documentElement.clientHeight || 1;
    const docSw = document.documentElement.scrollWidth || vw;
    const horizontalOverflow = docSw > vw + 2 ? { overflowPx: Math.round(docSw - vw), scrollWidth: Math.round(docSw), viewportWidth: Math.round(vw), offenders: [] } : null;

    if (horizontalOverflow) {
      const off = [];
      walkDeep(document.body, (el) => {
        if (off.length >= 4) return false;
        if (!visible(el)) return;
        const r = globalRect(el);
        if (r.right > vw + 2) {
          off.push({ target: describeEl(el), right: Math.round(r.right), overflowPx: Math.round(r.right - vw), text: norm(el.innerText).slice(0, 50) });
        }
      });
      horizontalOverflow.offenders = off;
    }

    const brokenImages = [];
    for (const img of queryDeep(document, 'img')) {
      if (!visible(img)) continue;
      if (img.complete && img.naturalWidth === 0) {
        brokenImages.push({ src: (img.getAttribute('src') || '').slice(0, 140), alt: norm(img.alt).slice(0, 60), target: describeEl(img) });
        if (brokenImages.length >= 10) break;
      }
    }

    const clippedText = [];
    const seenClipped = new Set();
    walkDeep(document.body, (el) => {
      if (clippedText.length >= 10) return false;
      if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|PATH|INPUT|TEXTAREA|SELECT|OPTION|IFRAME|CANVAS|VIDEO|IMG)$/.test(el.tagName)) return;
      if (!visible(el)) return;
      const cs = winOf(el).getComputedStyle(el);
      const ovX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      const ovY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      if (!ovX && !ovY) return;
      const r = el.getBoundingClientRect();
      if (r.width < 12 || r.height < 10) return;
      const directText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (!directText && el.children.length > 0) return;
      const text = norm(el.innerText || el.textContent);
      if (!text || text.length < 3) return;
      const clipX = ovX && el.scrollWidth > el.clientWidth + 3;
      const clipY = ovY && el.scrollHeight > el.clientHeight + 4;
      if (!clipX && !clipY) return;
      const key = text.slice(0, 60) + '|' + describeEl(el);
      if (seenClipped.has(key)) return;
      seenClipped.add(key);
      clippedText.push({
        target: describeEl(el),
        text: text.slice(0, 90),
        axis: clipX && clipY ? 'horizontal e vertical' : clipX ? 'horizontal' : 'vertical',
        ellipsis: cs.textOverflow === 'ellipsis',
        deltaPx: Math.round(Math.max(clipX ? el.scrollWidth - el.clientWidth : 0, clipY ? el.scrollHeight - el.clientHeight : 0)),
      });
    });

    const isModalLayer = (el) => {
      if (!el || el === document.body || el === document.documentElement) return false;
      const role = el.getAttribute && el.getAttribute('role');
      if (el.tagName === 'DIALOG' && el.hasAttribute('open')) return true;
      if (role === 'dialog' || role === 'alertdialog' || (el.getAttribute && el.getAttribute('aria-modal') === 'true')) return true;
      const cs = winOf(el).getComputedStyle(el);
      if (cs.position === 'fixed') {
        const r = globalRect(el);
        if (r.width >= vw * 0.75 && r.height >= vh * 0.75) return true;
      }
      return false;
    };
    const modalAncestorOf = (el) => {
      for (let e = el; e; ) {
        if (e.nodeType === 1 && isModalLayer(e)) return e;
        e = parentDeep(e);
      }
      return null;
    };
    const hasOpenModal = queryDeep(document, 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]').some(visible)
      || [...document.querySelectorAll('body > *')].some((el) => el.id !== '__deskcheck_overlay' && visible(el) && isModalLayer(el));

    const overlappedControls = [];
    const unnamedControls = [];
    const ctrlSel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link]';
    for (const el of queryDeep(document, ctrlSel)) {
      if (!visible(el)) continue;
      const elModal = modalAncestorOf(el);
      const name = accName(el);
      if (!name && (!hasOpenModal || elModal) && unnamedControls.length < 8) {
        unnamedControls.push({ target: describeEl(el), tag: el.tagName.toLowerCase() });
      }
      const r = globalRect(el);
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
      const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
      const top = deepElementFromPoint(cx, cy);
      if (top && !containsDeep(el, top) && !containsDeep(top, el) && top.id !== '__deskcheck_overlay') {
        const topModal = modalAncestorOf(top);
        if (topModal && topModal !== elModal) continue;
        if (overlappedControls.length < 8) {
          overlappedControls.push({ target: describeEl(el), name: name.slice(0, 50), coveredBy: describeEl(top) });
        }
      }
    }

    const total = (horizontalOverflow ? 1 : 0) + brokenImages.length + clippedText.length + overlappedControls.length + unnamedControls.length;
    return { horizontalOverflow, brokenImages, clippedText, overlappedControls, unnamedControls, total };
  }

  function viewState() {
    const vw = window.innerWidth || document.documentElement.clientWidth || 1;
    const vh = window.innerHeight || document.documentElement.clientHeight || 1;
    const hasModal = queryDeep(document, 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]').some(visible)
      || [...document.querySelectorAll('body > *')].some((el) => {
        if (el.id === '__deskcheck_overlay' || !visible(el)) return false;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed') return false;
        const r = el.getBoundingClientRect();
        return r.width >= vw * 0.75 && r.height >= vh * 0.75;
      });
    return { href: location.href, hasModal };
  }

  window.__dc = {
    v: 5,
    norm,
    visible,
    accName,
    findAll,
    find,
    findFileInput,
    target,
    boxes,
    audit,
    viewState,
    count: (q) => findAll(q).length,
    hasText: (text, within, exact) => findAll({ text, within, exact }).length > 0,
    focus: (q) => {
      const el = find(q);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'instant' });
      el.focus();
      try {
        if (typeof el.select === 'function') el.select();
        else if (el.isContentEditable) {
          const r = el.ownerDocument.createRange();
          r.selectNodeContents(el);
          const s = winOf(el).getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
      } catch {

      }
      return true;
    },
    value: (q) => { const el = find(q); return el ? (el.value ?? norm(el.innerText)) : null; },
    selectOption: (q, opt) => {
      const el = find(q);
      if (!el || el.tagName !== 'SELECT') return 'not-select';
      const o = [...el.options].find((x) => x.value === opt || lower(x.text) === lower(opt)) || [...el.options].find((x) => lower(x.text).includes(lower(opt)));
      if (!o) return 'no-option';
      const proto = winOf(el).HTMLSelectElement?.prototype || HTMLSelectElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, o.value);
      else el.value = o.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    },
  };
  return true;
})()
`;
