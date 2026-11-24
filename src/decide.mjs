import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DeskcheckError } from './cdp.mjs';
import { finalStatus } from './runner.mjs';

const execFileAsync = promisify(execFile);

export function resolveDecideBin(explicit) {
  if (explicit) return explicit;
  if (process.env.DESKCHECK_DECIDE_BIN) return process.env.DESKCHECK_DECIDE_BIN;
  const local = path.join(os.homedir(), '.local', 'bin', 'decide');
  if (existsSync(local)) return local;
  return 'decide';
}

export function parseDecideYesNo(output) {
  const text = String(output || '').trim();
  const m = text.match(/^(SIM|NÃO|NAO|YES|NO)\b/i);
  const raw = m ? m[1].toUpperCase() : '';
  const answer = raw === 'SIM' || raw === 'YES' ? 'SIM' : raw === 'NÃO' || raw === 'NAO' || raw === 'NO' ? 'NÃO' : raw || 'INDEFINIDO';
  const yesMatch = text.match(/prob\.\s*de\s*sim:\s*(\d+)%/i);
  const confMatch = text.match(/confian[çc]a:\s*(\d+)%/i);
  const yesProb = yesMatch ? Number(yesMatch[1]) : null;
  const confidence = confMatch ? Number(confMatch[1]) : yesProb !== null ? (answer === 'SIM' ? yesProb : 100 - yesProb) : null;
  return { answer, yesProb, confidence, raw: text };
}

export function parseDecideScore(output) {
  const text = String(output || '').trim();
  const sm = text.match(/score\s+([\d.]+)/i);
  const cm = text.match(/confian[çc]a:\s*(\d+)%/i);
  const levels = [];
  for (const line of text.split('\n')) {
    const lm = line.match(/^\s*(\d+)\.\s+([^\s]+)\s+(\d+)%/);
    if (lm) levels.push({ index: Number(lm[1]), label: lm[2], pct: Number(lm[3]) });
  }
  const top = [...levels].sort((a, b) => b.pct - a.pct)[0] || null;
  const highPct = levels.filter((l) => l.index >= Math.max(0, levels.length - 2)).reduce((acc, l) => acc + l.pct, 0);
  return {
    score: sm ? Number(sm[1]) : null,
    max: levels.length ? levels.length - 1 : 3,
    confidence: cm ? Number(cm[1]) : null,
    topLabel: top?.label || '',
    highPct: levels.length ? highPct : null,
    levels,
    raw: text,
  };
}

function pickEvidenceFiles(dir, results) {
  const files = [];
  const add = (p) => {
    if (p && existsSync(p) && !files.includes(p)) files.push(p);
  };
  add(path.join(dir, 'card.md'));
  add(path.join(dir, 'report.md'));
  const prioritized = [
    ...(results.scenarios || []).filter((s) => ['fail', 'blocked', 'warn'].includes(finalStatus(s))),
    ...(results.scenarios || []).filter((s) => finalStatus(s) === 'pass'),
  ];
  let shotCount = 0;
  for (const sc of prioritized) {
    if (shotCount >= 6) break;
    const shots = sc.shots || [];
    const pick = shots.find((s) => !/falha/.test(s.file)) || shots[0];
    if (!pick) continue;
    const jpg = path.join(dir, 'shots', 'web', pick.file.replace(/\.png$/i, '.jpg'));
    const png = path.join(dir, 'shots', pick.file);
    add(existsSync(jpg) ? jpg : png);
    shotCount++;
  }
  return files;
}

export async function runDecisionCheck({ dir, results, scope = 'full', bin, runner } = {}) {
  const cmd = resolveDecideBin(bin);
  const files = pickEvidenceFiles(dir, results);
  const fileArgs = files.flatMap((f) => ['-f', f]);
  const scopeNote = scope === 'frontend' ? ' no escopo estritamente de frontend (ignorando duplicidades ou problemas do backend)' : scope === 'backend' ? ' no escopo de backend' : '';

  const invoke =
    runner ||
    (async (args) => {
      try {
        const { stdout } = await execFileAsync(cmd, args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
        return stdout;
      } catch (e) {
        if (e.code === 'ENOENT') throw new DeskcheckError(`comando "${cmd}" não encontrado (instale decide ou defina DESKCHECK_DECIDE_BIN).`);
        throw new DeskcheckError(`falha ao rodar ${cmd}: ${e.stderr || e.message}`);
      }
    });

  const [approveOut, accuracyOut] = await Promise.all([
    invoke([`A implementação avaliada neste desk check atende integralmente aos critérios de aceite${scopeNote} para ser aprovada no estado atual?`, ...fileArgs]),
    invoke([`Qual o nível de assertividade e precisão deste relatório de desk check e dos testes executados${scopeNote} em relação ao card e às evidências visuais?`, '--score', 'baixa,media,alta,muito_alta', ...fileArgs]),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    scope,
    filesCount: files.length,
    approve: parseDecideYesNo(approveOut),
    accuracy: parseDecideScore(accuracyOut),
  };
}
