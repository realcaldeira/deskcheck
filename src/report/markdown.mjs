import { finalStatus, statusIcon, summarize } from "../runner.mjs";
import { LABEL_LONG, auditItemsOf, computeQuality, coverage, headOf, md, totalDurationMs, verdictOf, when } from "./quality.mjs";

export function reportMarkdown(results, card) {
  const v = verdictOf(results);
  const s = summarize(results.scenarios);
  const cov = coverage(results, card);
  const q = computeQuality(results, cov);
  const L = [`# Desk check · ${headOf(results, card)}`, ''];
  if (card) L.push(`Card: ${card.url}`);
  L.push(`Tela: ${results.baseUrl || '-'} · ${results.viewport.width}×${results.viewport.height} · ${when(results.finishedAt)}${results.readonly ? ' · somente leitura (escritas barradas na rede)' : ''}${results.strict ? ' · modo estrito' : ''}`, '');
  L.push(`**${statusIcon(v.kind)} ${v.text}** (${s.pass} ok · ${s.warn} ressalvas · ${s.fail} falhas · ${s.blocked} bloqueados) · Confiança: **${q.confidence.label} (${q.confidence.score}%)** (${q.confidence.summary})`, '');
  L.push('| Cenário | Critério / TC | Resultado | Observação |', '|---|---|---|---|');
  for (const sc of results.scenarios) {
    const st = finalStatus(sc);
    const refs = [...sc.ac, ...sc.tc.map((t) => `TC ${t}`)].join(', ') || '-';
    const obs = sc.note || (sc.error ? `passo ${sc.failedStep}: ${sc.error}` : '');
    const defects = sc.defects?.length ? ` (Defect ${sc.defects.join(', ')})` : '';
    L.push(`| ${sc.id} · ${md(sc.title)} | ${refs} | ${statusIcon(st)} ${LABEL_LONG[st]}${sc.verdict && sc.verdict !== sc.status ? ' (revisado)' : ''}${defects} | ${md(obs) || '-'} |`);
  }
  L.push('');
  if (cov) {
    if (cov.notTestable.length) {
      L.push('## Não testável', '');
      for (const r of cov.notTestable) L.push(`- ${r.key}: ${r.text.split('\n')[0]} — ${r.reason}`);
      L.push('');
    }
    if (cov.acMissing.length || cov.tcMissing.length) {
      L.push('## Sem cenário', '');
      for (const r of [...cov.acMissing, ...cov.tcMissing]) L.push(`- ${r.key}: ${r.text.split('\n')[0]}`);
      L.push('');
    }
  }
  for (const sc of results.scenarios) {
    const st = finalStatus(sc);
    L.push(`## ${statusIcon(st)} ${sc.id} · ${sc.title}`, '');
    if (sc.expected) L.push(`Esperado: ${sc.expected}`, '');
    for (const step of sc.steps) {
      if (step.status === 'skipped') continue;
      L.push(`${step.n}. ${statusIcon(step.status)} ${step.desc}${step.detail ? ` → ${step.detail}` : ''}${step.error ? ` — **${step.error}**` : ''}${step.shot ? ` (print: shots/${step.shot})` : ''}`);
    }
    if (sc.note) L.push('', `Observação: ${sc.note}`);
    for (const r of sc.references || []) L.push(r.file ? `Referência: shots/${r.file} (${r.label})` : `Referência não encontrada: ${r.missing}`);
    if (sc.console.length) L.push('', `Erros no console (${sc.console.length}):`, ...sc.console.slice(0, 8).map((c) => `- ${c.text.split('\n')[0].slice(0, 200)}`));
    if (sc.network.length) L.push('', `Requisições com erro (${sc.network.length}):`, ...sc.network.slice(0, 8).map((n) => `- ${n.method || ''} ${n.url.slice(0, 160)} → ${n.status || n.error}`));
    if (sc.blockedRequests?.length) L.push('', `Escritas barradas pelo modo somente leitura (${sc.blockedRequests.length}, não chegaram ao servidor):`, ...sc.blockedRequests.slice(0, 8).map((n) => `- ${n.method} ${n.url.slice(0, 160)}`));
    const auditItems = auditItemsOf(sc.audit);
    if (auditItems.length) L.push('', `Auditoria visual automática (${auditItems.length}):`, ...auditItems.slice(0, 8).map((a) => `- [${a.kind}] ${a.text}`));
    L.push('');
  }
  return L.join('\n');
}

const xmlEsc = (s) => String(s ?? "").replace(/[&<>\x22\x27]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\x22": "&quot;", "\x27": "&apos;" })[c]);

export function reportJunit(results, card) {
  const s = summarize(results.scenarios);
  const name = headOf(results, card);
  const timeSec = (totalDurationMs(results) / 1000).toFixed(3);
  const cases = (results.scenarios || []).map((sc) => {
    const st = finalStatus(sc);
    const dur = ((sc.durationMs || 0) / 1000).toFixed(3);
    const cls = results.workItem ? `deskcheck.${results.workItem}` : "deskcheck";
    const title = `${sc.id} · ${sc.title}`;
    if (st === "fail" || st === "blocked") {
      const msg = sc.error || sc.note || (st === "blocked" ? "cenário bloqueado" : "cenário falhou");
      const tag = st === "blocked" ? "error" : "failure";
      const detail = (sc.steps || []).filter((x) => x.status !== "skipped").map((x) => `${x.n}. [${x.status}] ${x.desc}${x.error ? ` — ${x.error}` : ""}`).join("\n");
      return `  <testcase classname="${xmlEsc(cls)}" name="${xmlEsc(title)}" time="${dur}">\n    <${tag} message="${xmlEsc(msg)}">${xmlEsc(detail)}</${tag}>\n  </testcase>`;
    }
    return `  <testcase classname="${xmlEsc(cls)}" name="${xmlEsc(title)}" time="${dur}"/>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xmlEsc(name)}" tests="${s.total}" failures="${s.fail}" errors="${s.blocked}" time="${timeSec}">\n${cases}\n</testsuite>\n`;
}
