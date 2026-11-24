import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const PT_TYPES = {
  'User Story': 'História de Usuário',
  'Technical Story': 'História Técnica',
  Feature: 'Funcionalidade',
  Bug: 'Bug',
  Task: 'Tarefa',
};

export const PT_STATES = {
  New: 'Novo',
  Active: 'Ativo',
  'Waiting Tests': 'Aguardando Testes',
  'Waiting Quality Analysis': 'Aguardando Análise de Qualidade',
  Testing: 'Em Testes',
  'In Progress': 'Em Andamento',
  'Code Review': 'Revisão de Código',
  Design: 'Em Design',
  Ready: 'Pronto',
  Resolved: 'Resolvido',
  Closed: 'Fechado',
  Done: 'Concluído',
  Blocked: 'Bloqueado',
  Removed: 'Removido',
};

const GWT_RE = /^(Given|When|Then|And|But):?\s*(.*)$/i;
const PT_ACCENT_RE = /[ãõçáéíóúâêôà]/i;
const PT_WORDS_RE = /\b(não|para|com|está|estão|usuário|tela|cenário|defeito|nenhum|simulado|aguardando|concluído|reprovado|aprovado|ressalva|verifique|quando|então|dado)\b/i;

export function stripGwt(raw) {
  const s = String(raw || '').trim();
  const m = GWT_RE.exec(s);
  return m ? m[2].trim() : s;
}

export function looksPortuguese(text) {
  const s = String(text || '').trim();
  if (s.length < 3) return true;
  if (PT_ACCENT_RE.test(s)) return true;
  if (PT_WORDS_RE.test(s)) return true;
  return !/[a-zA-Z]{2,}/.test(s);
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function curlJson(url) {
  return new Promise((done) => {
    const child = spawn('curl', ['-sS', '--max-time', '8', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code !== 0) return done(null);
      try { done(JSON.parse(out)); } catch { done(null); }
    });
  });
}

async function translateChunk(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|pt-BR`;
  const data = await curlJson(url);
  if (!data || data.responseStatus !== 200 || data.quotaFinished) return null;
  const tr = decodeEntities(data.responseData?.translatedText || '').trim();
  if (!tr || /^MYMEMORY WARNING/i.test(tr)) return null;
  return tr;
}

async function translateOne(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (s.length <= 450 && !s.includes('\n')) return translateChunk(s);
  const lines = s.split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { out.push(''); continue; }
    if (looksPortuguese(trimmed)) { out.push(line); continue; }
    if (trimmed.length <= 450) {
      const tr = await translateChunk(trimmed);
      out.push(tr || line);
    } else {
      const parts = trimmed.match(/.{1,420}(?:\s|$)/g) || [trimmed];
      const trParts = [];
      for (const p of parts) trParts.push((await translateChunk(p.trim())) || p.trim());
      out.push(trParts.join(' '));
    }
  }
  return out.join('\n');
}

export function loadCache(file) {
  if (!file || !existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

export function saveCache(file, cache) {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache, null, 1));
  } catch {}
}

export function collectRunTexts(run) {
  const set = new Set();
  const add = (v) => {
    const s = String(v || '').trim();
    if (s && !looksPortuguese(s)) set.add(s);
  };
  add(run.title);
  if (run.card) {
    add(run.card.title);
    for (const tc of run.card.testCases || []) {
      add(tc.title);
      for (const st of tc.steps || []) {
        if (typeof st === 'string') add(stripGwt(st));
        else {
          add(stripGwt(st.action || st.text || ''));
          add(st.expected || '');
        }
      }
    }
    for (const ac of run.card.acceptanceCriteria || []) add(ac.text || ac);
  }
  if (run.result) {
    add(run.result.summary);
    for (const ac of run.result.acWithoutTc || []) add(ac);
    for (const nt of run.result.notTested || []) add(nt.reason);
    for (const sc of run.result.scenarios || []) add(sc.notes);
    for (const d of run.result.defects || []) {
      add(d.title);
      add(d.steps);
      add(d.expected);
      add(d.actual);
    }
  }
  for (const s of run.shots || []) {
    for (const m of s.marks || []) add(m.note);
  }
  return [...set];
}

export function pickRunPt(run, cache) {
  const pt = {};
  const texts = collectRunTexts(run);
  for (const s of texts) if (cache[s]) pt[s] = cache[s];
  if (run.type && PT_TYPES[run.type]) pt[run.type] = PT_TYPES[run.type];
  if (run.card?.type && PT_TYPES[run.card.type]) pt[run.card.type] = PT_TYPES[run.card.type];
  if (run.card?.state && PT_STATES[run.card.state]) pt[run.card.state] = PT_STATES[run.card.state];
  return pt;
}

export async function translateRun(run, cache, cacheFile, { simulate = false } = {}) {
  const texts = collectRunTexts(run);
  const missing = texts.filter((s) => !(s in cache));
  if (!simulate && missing.length > 0) {
    let idx = 0;
    let changed = false;
    const worker = async () => {
      while (idx < missing.length) {
        const text = missing[idx++];
        const tr = await translateOne(text);
        if (tr) {
          cache[text] = tr;
          changed = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
    if (changed) saveCache(cacheFile, cache);
  }
  run.pt = pickRunPt(run, cache);
  return run.pt;
}
