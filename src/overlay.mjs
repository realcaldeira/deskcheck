export const OVERLAY_SCRIPT = String.raw`(() => {
  if (window.__dcOverlay) return true;
  const host = document.createElement('div');
  host.id = '__deskcheck_overlay';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' +
    ':host{all:initial}' +
    '@keyframes enter{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}' +
    '@keyframes pulseDot{0%{box-shadow:0 0 0 0 rgba(251,191,36,.6)}70%{box-shadow:0 0 0 9px rgba(251,191,36,0)}100%{box-shadow:0 0 0 0 rgba(251,191,36,0)}}' +
    '@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(220%)}}' +
    '@keyframes stepIn{from{opacity:.35;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}' +
    '@keyframes hlPulse{0%,100%{box-shadow:0 0 0 4px rgba(251,191,36,.26),0 0 26px rgba(251,191,36,.38)}50%{box-shadow:0 0 0 8px rgba(251,191,36,.14),0 0 36px rgba(251,191,36,.52)}}' +
    '.panel{position:fixed;right:20px;bottom:20px;width:424px;max-width:calc(100vw - 40px);font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",Roboto,sans-serif;color:#f3f5f8;' +
    'background:linear-gradient(165deg,rgba(20,25,38,.94),rgba(9,11,17,.97));backdrop-filter:blur(22px) saturate(1.65);-webkit-backdrop-filter:blur(22px) saturate(1.65);' +
    'border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:15px 17px 16px;overflow:hidden;animation:enter .32s cubic-bezier(.22,1,.36,1);' +
    'box-shadow:0 1px 0 inset rgba(255,255,255,.1),0 28px 60px -10px rgba(0,0,0,.68),0 6px 16px rgba(0,0,0,.35);transition:border-color .25s ease}' +
    '.panel.pass{border-color:rgba(52,211,153,.34)}' +
    '.panel.fail{border-color:rgba(251,113,133,.38)}' +
    '.top{display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8490a6}' +
    '.brand{display:inline-flex;align-items:center;gap:7px;color:#f8fafc}' +
    '.live{width:8px;height:8px;border-radius:50%;background:#fbbf24;animation:pulseDot 1.6s infinite}' +
    '.panel.pass .live{background:#34d399;animation:none;box-shadow:0 0 10px rgba(52,211,153,.8)}' +
    '.panel.fail .live{background:#fb7185;animation:none;box-shadow:0 0 10px rgba(251,113,133,.8)}' +
    '.tally{display:inline-flex;align-items:center;gap:5px;margin-left:auto;font:650 11px ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums}' +
    '.t-ok{color:#34d399;background:rgba(52,211,153,.13);border:1px solid rgba(52,211,153,.26);padding:1.5px 7px;border-radius:999px}' +
    '.t-err{color:#fb7185;background:rgba(251,113,133,.14);border:1px solid rgba(251,113,133,.3);padding:1.5px 7px;border-radius:999px}' +
    '.count{font:650 11px ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);padding:2px 8px;border-radius:999px;color:#cbd5e1}' +
    '.ro{display:inline-flex;align-items:center;gap:4px;background:rgba(52,211,153,.14);color:#6ee7b7;border:1px solid rgba(52,211,153,.28);border-radius:999px;padding:1.5px 8px;font-size:9.8px;font-weight:700;letter-spacing:.05em}' +
    '.sc{font-weight:700;font-size:14.5px;letter-spacing:-.015em;margin-top:10px;color:#ffffff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.st{display:flex;gap:9px;align-items:flex-start;margin-top:8px;color:#cbd5e1;font-size:12.8px}' +
    '.st.anim{animation:stepIn .22s cubic-bezier(.22,1,.36,1)}' +
    '.mark{flex:none;width:21px;height:21px;border-radius:7px;display:grid;place-items:center;font-size:11px;font-weight:800;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.34);color:#fbbf24;margin-top:1px;transition:all .2s ease}' +
    '.st.pass .mark{background:rgba(52,211,153,.16);border-color:rgba(52,211,153,.38);color:#34d399}' +
    '.st.fail .mark{background:rgba(251,113,133,.18);border-color:rgba(251,113,133,.4);color:#fb7185}' +
    '.st.fail .txt{color:#fda4af}' +
    '.st-body{min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}' +
    '.kind{font:700 9.8px ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em;padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.08);color:#94a3b8;border:1px solid rgba(255,255,255,.1)}' +
    '.kind.k-assert{background:rgba(96,165,250,.15);color:#93c5fd;border-color:rgba(96,165,250,.3)}' +
    '.kind.k-shot{background:rgba(167,139,250,.15);color:#c4b5fd;border-color:rgba(167,139,250,.3)}' +
    '.txt{min-width:0;overflow-wrap:anywhere}' +
    '.bar{position:relative;height:5px;border-radius:999px;background:rgba(255,255,255,.09);margin-top:13px;overflow:hidden}' +
    '.fill{position:relative;height:100%;width:0;background:linear-gradient(90deg,#3b82f6,#60a5fa,#fbbf24);border-radius:999px;transition:width .32s cubic-bezier(.22,1,.36,1);overflow:hidden}' +
    '.fill::after{content:"";position:absolute;inset:0;width:45%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.42),transparent);animation:shimmer 1.8s infinite}' +
    '.panel.pass .fill{background:linear-gradient(90deg,#059669,#34d399)}' +
    '.panel.fail .fill{background:linear-gradient(90deg,#e11d48,#fb7185)}' +
    '.panel.pass .fill::after,.panel.fail .fill::after{animation:none;opacity:0}' +
    '.hl{position:fixed;border:2.5px solid #fbbf24;border-radius:11px;background:rgba(251,191,36,.09);animation:hlPulse 1.3s ease-in-out infinite;transition:left .18s cubic-bezier(.22,1,.36,1),top .18s cubic-bezier(.22,1,.36,1),width .18s cubic-bezier(.22,1,.36,1),height .18s cubic-bezier(.22,1,.36,1)}' +
    '</style><div class="hl" hidden></div><div class="panel"><div class="top"><span class="brand"><span class="live"></span>Desk check</span><span class="ro" hidden>somente leitura</span><span class="tally"><span class="t-ok" hidden></span><span class="t-err" hidden></span></span><span class="count"></span></div>' +
    '<div class="sc"></div><div class="st"><span class="mark">•</span><span class="st-body"><span class="kind" hidden></span><span class="txt"></span></span></div><div class="bar"><div class="fill"></div></div></div>';
  const mount = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
  mount();
  const $ = (s) => root.querySelector(s);
  const KIND_LABEL = { setup: 'setup', action: 'ação', assert: 'asserção', shot: 'print' };
  window.__dcOverlay = {
    set(st) {
      mount();
      $('.count').textContent = st.count || '';
      $('.ro').hidden = !st.readonly;
      const ok = st.tally ? (st.tally.pass || 0) + (st.tally.warn || 0) : 0;
      const err = st.tally ? (st.tally.fail || 0) + (st.tally.blocked || 0) : 0;
      const tOk = $('.t-ok'), tErr = $('.t-err');
      tOk.hidden = !ok; tOk.textContent = '✓ ' + ok;
      tErr.hidden = !err; tErr.textContent = '✕ ' + err;
      $('.sc').textContent = st.scenario || '';
      const kindEl = $('.kind');
      if (st.kind && KIND_LABEL[st.kind]) {
        kindEl.hidden = false;
        kindEl.className = 'kind k-' + st.kind;
        kindEl.textContent = KIND_LABEL[st.kind];
      } else {
        kindEl.hidden = true;
      }
      $('.txt').textContent = st.step || '';
      $('.panel').className = 'panel ' + (st.status || '');
      const stEl = $('.st');
      stEl.className = 'st ' + (st.status || '');
      void stEl.offsetWidth;
      stEl.classList.add('anim');
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
