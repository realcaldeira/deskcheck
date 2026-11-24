export const OVERLAY_SCRIPT = String.raw`(() => {
  if (window.__dcOverlay) return true;
  const host = document.createElement('div');
  host.id = '__deskcheck_overlay';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' +
    ':host{all:initial}' +
    '.panel{position:fixed;right:18px;bottom:18px;width:380px;max-width:calc(100vw - 36px);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#f4f3ee;' +
    'background:rgba(22,22,20,.94);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:12px 14px 12px;box-shadow:0 12px 32px rgba(0,0,0,.35)}' +
    '.top{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#a9a79f}' +
    '.brand{display:inline-flex;align-items:center;gap:6px;color:#f4f3ee}' +
    '.live{width:8px;height:8px;border-radius:50%;background:#f2c35b;box-shadow:0 0 0 0 rgba(242,195,91,.6);animation:p 1.4s infinite}' +
    '@keyframes p{0%{box-shadow:0 0 0 0 rgba(242,195,91,.55)}70%{box-shadow:0 0 0 7px rgba(242,195,91,0)}100%{box-shadow:0 0 0 0 rgba(242,195,91,0)}}' +
    '.count{margin-left:auto;font-weight:600;letter-spacing:.02em;text-transform:none}' +
    '.ro{background:rgba(98,207,139,.16);color:#7fe0a3;border-radius:999px;padding:1px 7px;font-weight:700;letter-spacing:.04em}' +
    '.sc{font-weight:650;font-size:14px;margin-top:6px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.st{display:flex;gap:8px;align-items:flex-start;margin-top:6px;color:#dedcd5}' +
    '.mark{flex:none;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:800;background:rgba(255,255,255,.1);color:#f2c35b}' +
    '.st.pass .mark{background:rgba(98,207,139,.18);color:#7fe0a3}.st.fail .mark{background:rgba(255,138,123,.2);color:#ff9a8c}.st.fail .txt{color:#ffb4aa}' +
    '.bar{height:4px;border-radius:999px;background:rgba(255,255,255,.1);margin-top:10px;overflow:hidden}' +
    '.fill{height:100%;width:0;background:linear-gradient(90deg,#f2c35b,#f7d98c);border-radius:999px;transition:width .25s ease}' +
    '.hl{position:fixed;border:2.5px solid #f2c35b;border-radius:8px;box-shadow:0 0 0 5px rgba(242,195,91,.28),0 0 24px rgba(242,195,91,.35);transition:all .18s ease}' +
    '</style><div class="hl" hidden></div><div class="panel"><div class="top"><span class="brand"><span class="live"></span>Desk check</span><span class="ro" hidden>somente leitura</span><span class="count"></span></div>' +
    '<div class="sc"></div><div class="st"><span class="mark">•</span><span class="txt"></span></div><div class="bar"><div class="fill"></div></div></div>';
  const mount = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
  mount();
  const $ = (s) => root.querySelector(s);
  window.__dcOverlay = {
    set(st) {
      mount();
      $('.count').textContent = st.count || '';
      $('.ro').hidden = !st.readonly;
      $('.sc').textContent = st.scenario || '';
      $('.txt').textContent = st.step || '';
      $('.st').className = 'st ' + (st.status || '');
      $('.mark').textContent = st.status === 'pass' ? '✓' : st.status === 'fail' ? '✕' : '•';
      if (typeof st.progress === 'number') $('.fill').style.width = Math.max(0, Math.min(1, st.progress)) * 100 + '%';
    },
    highlight(q) {
      mount();
      const box = $('.hl');
      const el = window.__dc && window.__dc.find(q);
      if (!el) { box.hidden = true; return false; }
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: (r.left - 5) + 'px', top: (r.top - 5) + 'px', width: (r.width + 10) + 'px', height: (r.height + 10) + 'px' });
      box.hidden = false;
      return true;
    },
    clearHighlight() { $('.hl').hidden = true; },
    hide() { host.style.display = 'none'; },
    show() { mount(); host.style.display = ''; },
  };
  return true;
})()`;

export const MARK_SCRIPT = String.raw`(() => {
  if (window.__dcMark) return true;
  const COLOR = '#e5132b';
  const FONT = '600 13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  let layer = null;
  const clear = () => { if (layer) layer.remove(); layer = null; };
  const px = (n) => Math.round(n) + 'px';
  const draw = (marks, fullPage) => {
    clear();
    const found = [];
    const missing = [];
    marks.forEach((m, i) => {
      const el = window.__dc && window.__dc.find(m.q);
      if (el) found.push({ el, note: m.note || '', n: i + 1 });
      else missing.push({ n: i + 1, note: m.note || '' });
    });
    if (!found.length) return { marks: [], missing };
    found[0].el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    layer = document.createElement('div');
    layer.id = '__deskcheck_marks';
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483646;';
    document.documentElement.appendChild(layer);
    const out = [];
    const sx = window.scrollX, sy = window.scrollY, pad = 6, gap = 8;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const rects = found.map(({ el }) => el.getBoundingClientRect());
    const boxes = rects.map((r) => ({ l: r.left - pad, t: r.top - pad, r: r.right + pad, b: r.bottom + pad }));
    const placed = [];
    const hits = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
    found.forEach(({ note, n }, i) => {
      const r = rects[i], bx = boxes[i];
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;box-sizing:border-box;border:3px solid ' + COLOR + ';border-radius:8px;background:rgba(229,19,43,.08);' +
        'box-shadow:0 0 0 2px rgba(255,255,255,.9),0 4px 18px rgba(229,19,43,.35);' +
        'left:' + px(bx.l + sx) + ';top:' + px(bx.t + sy) + ';width:' + px(bx.r - bx.l) + ';height:' + px(bx.b - bx.t);
      const tag = document.createElement('div');
      const num = document.createElement('b');
      num.textContent = String(n);
      num.style.cssText = 'display:inline-grid;place-items:center;min-width:18px;height:18px;border-radius:50%;background:#fff;color:' + COLOR + ';font:800 11px/1 -apple-system,sans-serif;margin-right:7px;vertical-align:1px';
      tag.append(num, document.createTextNode(note));
      tag.style.cssText = 'position:absolute;box-sizing:border-box;width:max-content;max-width:' + Math.min(520, vw - 16) + 'px;background:' + COLOR + ';color:#fff;font:' + FONT + ';' +
        'padding:5px 10px;border-radius:7px;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 6px 16px rgba(0,0,0,.25);left:0;top:0;visibility:hidden';
      layer.append(box, tag);
      const w = tag.offsetWidth, h = tag.offsetHeight;
      const clampX = (x) => Math.max(8, Math.min(x, vw - w - 8));
      const clampY = (y) => Math.max(8, Math.min(y, vh - h - 8));
      const cy = (bx.t + bx.b) / 2 - h / 2;
      const candidates = [
        { l: bx.r + gap, t: clampY(cy) },
        { l: clampX(bx.l), t: bx.t - gap - h },
        { l: clampX(bx.l), t: bx.b + gap },
        { l: bx.l - gap - w, t: clampY(cy) },
      ].map((c) => ({ l: c.l, t: c.t, r: c.l + w, b: c.t + h }));
      const fits = (c) => c.l >= 4 && c.t >= 4 && c.r <= vw - 4 && c.b <= vh - 4;
      const free = (c) => !placed.some((p) => hits(c, p)) && !boxes.some((o) => hits(c, o));
      let spot = candidates.find((c) => fits(c) && free(c)) || candidates.find(fits) || candidates[2];
      for (let k = 0; k < 12 && placed.some((p) => hits(spot, p)); k++) spot = { ...spot, t: spot.t + h + 4, b: spot.b + h + 4 };
      placed.push(spot);
      tag.style.left = px(spot.l + sx);
      tag.style.top = px(spot.t + sy);
      tag.style.visibility = '';
      const fw = fullPage ? Math.max(document.documentElement.scrollWidth, vw) : vw;
      const fh = fullPage ? Math.max(document.documentElement.scrollHeight, vh) : vh;
      const ox = fullPage ? sx : 0, oy = fullPage ? sy : 0;
      const frac = (a) => ({ x: +((a.l + ox) / fw).toFixed(4), y: +((a.t + oy) / fh).toFixed(4), w: +((a.r - a.l) / fw).toFixed(4), h: +((a.b - a.t) / fh).toFixed(4) });
      out.push({ n, note, x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), box: frac(bx), label: frac(spot) });
    });
    return { marks: out, missing };
  };
  window.__dcMark = { draw, clear };
  return true;
})()`;
