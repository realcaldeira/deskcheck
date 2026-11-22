import { finalStatus, summarize } from "../runner.mjs";

export const LABEL = {
  pass: 'Passou',
  warn: 'Ressalva',
  fail: 'Falhou',
  blocked: 'Bloqueado',
  skipped: 'Não executado',
  nottestable: 'Não testável',
  none: 'Sem cenário',
};
export const LABEL_LONG = { ...LABEL, warn: 'Passou com ressalva' };
export const VERDICT_TAG = {
  pass: 'Aprovado',
  warn: 'Aprovado com ressalvas',
  fail: 'Reprovado',
  blocked: 'Incompleto',
};
const SEVERITY = { fail: 4, blocked: 3, warn: 2, pass: 1 };

export function verdictOf(results) {
  const s = summarize(results.scenarios);
  if (s.fail) return { kind: 'fail', text: `Reprovado: ${s.fail} de ${s.total} cenário${s.total > 1 ? 's' : ''} com falha` };
  if (s.blocked) return { kind: 'blocked', text: `Incompleto: ${s.blocked} cenário${s.blocked > 1 ? 's' : ''} não pôde ser executado` };
  if (s.warn) return { kind: 'warn', text: `Aprovado com ${s.warn} ressalva${s.warn > 1 ? 's' : ''}` };
  return { kind: 'pass', text: `Aprovado: ${s.total} de ${s.total} cenário${s.total > 1 ? 's' : ''} passaram` };
}

const refKey = (r) => String(r).trim().toUpperCase().replace(/^TC\s*/, 'TC ');

export function coverage(results, card) {
  if (!card) return null;
  const nt = new Map((results.notTestable || []).map((n) => [refKey(n.ref), n.reason]));
  const worst = (scs) => scs.map(finalStatus).sort((a, b) => (SEVERITY[b] || 0) - (SEVERITY[a] || 0))[0];
  const row = (key, text, scs) => {
    if (scs.length) return { key, text, status: worst(scs), scenarios: scs.map((s) => s.id) };
    if (nt.has(refKey(key))) return { key, text, status: 'nottestable', reason: nt.get(refKey(key)), scenarios: [] };
    return { key, text, status: 'none', scenarios: [] };
  };
  const acs = card.acceptanceCriteria.map((a) => row(a.id, a.text, results.scenarios.filter((s) => s.ac.includes(a.id))));
  const tcs = card.testCases.map((t) => row(`TC ${t.id}`, t.title, results.scenarios.filter((s) => s.tc.includes(t.id))));
  return {
    acs,
    tcs,
    acMissing: acs.filter((r) => r.status === 'none'),
    tcMissing: tcs.filter((r) => r.status === 'none'),
    notTestable: [...acs, ...tcs].filter((r) => r.status === 'nottestable'),
  };
}

export const isAssertion = (step) => String(step?.do || '').startsWith('expect');
export const stepCategory = (step) => {
  if (step.setup) return { key: 'setup', label: 'setup' };
  if (step.do === 'screenshot') return { key: 'shot', label: 'evidência' };
  if (isAssertion(step)) return { key: 'assert', label: 'asserção' };
  return { key: 'action', label: 'ação' };
};

export function scenarioMetrics(sc) {
  const steps = sc.steps || [];
  const asserts = steps.filter(isAssertion);
  const executedAsserts = asserts.filter((x) => x.status !== 'skipped');
  const assertPass = executedAsserts.filter((x) => x.status === 'pass').length;
  const assertFail = executedAsserts.filter((x) => x.status === 'fail' || x.status === 'blocked').length;
  const assertWarn = executedAsserts.filter((x) => x.status === 'warn').length;
  const failedStepObj = steps.find((x) => x.status === 'fail' || x.status === 'blocked') || null;
  return {
    assertTotal: asserts.length,
    assertExecuted: executedAsserts.length,
    assertPass,
    assertFail,
    assertWarn,
    failedStepObj,
  };
}

export function auditItemsOf(audit) {
  if (!audit) return [];
  const items = [];
  if (audit.horizontalOverflow) {
    const o = audit.horizontalOverflow;
    const who = o.offenders?.length ? ` (${o.offenders.map((x) => x.target).slice(0, 2).join(', ')})` : '';
    items.push({ kind: 'Overflow horizontal', severity: 'fail', text: `Página estoura +${o.overflowPx}px além do viewport (${o.scrollWidth}px vs ${o.viewportWidth}px)${who}` });
  }
  for (const im of audit.brokenImages || []) {
    items.push({ kind: 'Imagem quebrada', severity: 'fail', text: `${im.target}${im.alt ? ` "${im.alt}"` : ''} não carregou (${im.src || 'sem src'})` });
  }
  for (const c of audit.clippedText || []) {
    items.push({
      kind: c.ellipsis ? 'Texto truncado' : 'Texto cortado',
      severity: c.ellipsis ? 'warn' : 'fail',
      text: `${c.target} (${c.axis}, +${c.deltaPx}px): "${c.text}"`,
    });
  }
  for (const ov of audit.overlappedControls || []) {
    items.push({ kind: 'Elemento sobreposto', severity: 'warn', text: `${ov.target}${ov.name ? ` "${ov.name}"` : ''} está coberto por ${ov.coveredBy}` });
  }
  for (const u of audit.unnamedControls || []) {
    items.push({ kind: 'Sem nome acessível', severity: 'warn', text: `${u.target} sem texto, label ou aria-label` });
  }
  return items;
}

export function computeQuality(results, cov) {
  const scs = results.scenarios || [];
  const s = summarize(scs);
  let assertTotal = 0;
  let assertPass = 0;
  let assertFail = 0;
  let assertWarn = 0;
  let consoleErrors = 0;
  let networkErrors = 0;
  let blockedWrites = 0;
  let totalShots = 0;
  let scenariosWithShots = 0;
  let auditTotal = 0;
  let auditSevere = 0;
  let hasAuditData = false;
  const findings = [];

  for (const sc of scs) {
    const st = finalStatus(sc);
    const m = scenarioMetrics(sc);
    assertTotal += m.assertTotal;
    assertPass += m.assertPass;
    assertFail += m.assertFail;
    assertWarn += m.assertWarn;
    const cLen = (sc.console || []).length;
    const nLen = (sc.network || []).length;
    const bLen = (sc.blockedRequests || []).length;
    consoleErrors += cLen;
    networkErrors += nLen;
    blockedWrites += bLen;
    const shLen = (sc.shots || []).length;
    totalShots += shLen;
    if (shLen > 0) scenariosWithShots++;

    if (sc.audit) {
      hasAuditData = true;
      const items = auditItemsOf(sc.audit);
      auditTotal += items.length;
      const sev = items.filter((x) => x.severity === 'fail').length;
      auditSevere += sev;
      if (items.length) {
        findings.push({
          severity: sev ? 'fail' : 'warn',
          id: sc.id,
          title: sc.title,
          detail: items.slice(0, 2).map((x) => `${x.kind}: ${x.text}`).join(' · ') + (items.length > 2 ? ` (+${items.length - 2})` : ''),
          jump: sc.id,
          tag: 'Visual',
        });
      }
    }

    if (st === 'fail' || st === 'blocked') {
      const detail = sc.note || (m.failedStepObj ? `Passo ${m.failedStepObj.n} (${m.failedStepObj.do}): ${m.failedStepObj.error || sc.error || 'falhou'}` : sc.error || 'Falha na validação');
      findings.push({ severity: st, id: sc.id, title: sc.title, detail, jump: sc.id, tag: LABEL[st] });
    } else if (st === 'warn') {
      findings.push({ severity: 'warn', id: sc.id, title: sc.title, detail: sc.note || 'Passou com ressalva — conferir observação e prints.', jump: sc.id, tag: 'Ressalva' });
    }
    if (m.assertTotal === 0) {
      findings.push({ severity: 'warn', id: sc.id, title: sc.title, detail: 'Cenário sem asserção objetiva (expect*): validação depende apenas da inspeção do print.', jump: sc.id, tag: 'Sem asserção' });
    }
    if (cLen || nLen) {
      const parts = [];
      if (cLen) parts.push(`${cLen} erro${cLen > 1 ? 's' : ''} no console`);
      if (nLen) parts.push(`${nLen} requisição${nLen > 1 ? 'ões' : ''} com erro`);
      findings.push({ severity: st === 'fail' ? 'fail' : 'warn', id: sc.id, title: sc.title, detail: parts.join(' · '), jump: sc.id, tag: 'Runtime' });
    }
  }

  if (cov) {
    for (const r of [...cov.acMissing, ...cov.tcMissing]) {
      findings.push({
        severity: 'warn',
        id: r.key,
        title: r.text.split('\n')[0],
        detail: 'Sem cenário cobrindo este item — confirme se precisa de teste ou marque como não testável.',
        jump: r.key.startsWith('TC ') ? 'sec-tcs' : 'sec-acs',
        tag: 'Sem cenário',
      });
    }
  }

  const okScenarios = s.pass + s.warn;
  const assertPct = assertTotal ? Math.round((assertPass / assertTotal) * 100) : 100;
  const runtimeClean = consoleErrors === 0 && networkErrors === 0;
  const covMissing = cov ? cov.acMissing.length + cov.tcMissing.length : 0;
  const scenariosWithoutAsserts = scs.filter((sc) => scenarioMetrics(sc).assertTotal === 0).length;

  let confScore = 100;
  const confReasons = [];
  if (cov && (cov.acs.length || cov.tcs.length)) {
    const totalItems = cov.acs.length + cov.tcs.length;
    const ntCount = cov.notTestable.length;
    if (covMissing) {
      const pen = Math.min(30, Math.round((covMissing / totalItems) * 40));
      confScore -= pen;
      confReasons.push(`${covMissing} sem cenário`);
    }
    if (ntCount) {
      const pen = Math.min(30, Math.round((ntCount / totalItems) * 35));
      confScore -= pen;
      confReasons.push(`${ntCount}/${totalItems} não testável`);
    }
  }
  if (s.total && scenariosWithoutAsserts) {
    const pen = Math.min(20, Math.round((scenariosWithoutAsserts / s.total) * 20));
    confScore -= pen;
    confReasons.push(`${scenariosWithoutAsserts} sem expect*`);
  }
  if (!runtimeClean) {
    confScore -= Math.min(20, (consoleErrors + networkErrors) * 4);
    confReasons.push(`${consoleErrors + networkErrors} erro(s) runtime`);
  }
  if (auditTotal > 0) {
    confScore -= Math.min(15, auditSevere * 6 + (auditTotal - auditSevere) * 2);
    confReasons.push(`${auditTotal} alerta(s) visual`);
  }
  if (s.total && scenariosWithShots < s.total) {
    confScore -= Math.min(10, Math.round(((s.total - scenariosWithShots) / s.total) * 10));
    confReasons.push('cenário sem print');
  }
  confScore = Math.max(0, Math.min(100, confScore));
  const confidence = {
    score: confScore,
    label: confScore >= 85 ? 'Alta' : confScore >= 60 ? 'Parcial' : 'Baixa',
    status: confScore >= 85 ? 'pass' : confScore >= 60 ? 'warn' : 'fail',
    summary: confReasons.length ? confReasons.slice(0, 2).join(' · ') : 'Validação completa e limpa',
  };

  const checks = [
    {
      label: 'Confiança',
      value: `${confidence.label} · ${confidence.score}%`,
      sub: confidence.summary,
      status: confidence.status,
      meter: confidence.score,
    },
    {
      label: 'Cenários',
      value: `${okScenarios}/${s.total}`,
      sub: s.fail ? `${s.fail} falha${s.fail > 1 ? 's' : ''}` : s.blocked ? `${s.blocked} bloqueado${s.blocked > 1 ? 's' : ''}` : s.warn ? `${s.warn} ressalva${s.warn > 1 ? 's' : ''}` : 'Todos passaram',
      status: s.fail ? 'fail' : s.blocked ? 'blocked' : s.warn ? 'warn' : 'pass',
    },
    {
      label: 'Asserções',
      value: assertTotal ? `${assertPass}/${assertTotal}` : '0',
      sub: !assertTotal ? 'Sem expect* no plano' : assertFail ? `${assertFail} falhou · ${assertPct}%` : assertWarn ? `${assertWarn} ressalva · ${assertPct}%` : '100% verificadas',
      status: !assertTotal ? 'warn' : assertFail ? 'fail' : assertWarn ? 'warn' : 'pass',
    },
    {
      label: 'Console & Rede',
      value: runtimeClean ? 'Limpo' : `${consoleErrors + networkErrors} alerta${consoleErrors + networkErrors > 1 ? 's' : ''}`,
      sub: runtimeClean ? '0 console · 0 HTTP erro' : `${consoleErrors} console · ${networkErrors} rede`,
      status: runtimeClean ? 'pass' : 'fail',
    },
    ...(hasAuditData
      ? [
          {
            label: 'Saúde visual',
            value: auditTotal === 0 ? 'Limpo' : `${auditTotal} alerta${auditTotal > 1 ? 's' : ''}`,
            sub: auditTotal === 0 ? '0 overflow · 0 img · 0 corte' : `${auditSevere ? `${auditSevere} crítico${auditSevere > 1 ? 's' : ''}` : 'revisar layout/a11y'}`,
            status: auditTotal === 0 ? 'pass' : auditSevere ? 'fail' : 'warn',
          },
        ]
      : []),
    {
      label: 'Evidências',
      value: `${totalShots} print${totalShots !== 1 ? 's' : ''}`,
      sub: `${scenariosWithShots}/${s.total} cenários com print`,
      status: scenariosWithShots === s.total && totalShots > 0 ? 'pass' : totalShots > 0 ? 'warn' : 'none',
    },
  ];

  if (cov && (cov.acs.length || cov.tcs.length)) {
    const totalItems = cov.acs.length + cov.tcs.length;
    const covered = totalItems - covMissing - cov.notTestable.length;
    checks.push({
      label: 'Cobertura',
      value: `${covered}/${totalItems}`,
      sub: covMissing ? `${covMissing} sem cenário` : cov.notTestable.length ? `${cov.notTestable.length} não testável` : '100% mapeado',
      status: covMissing ? 'warn' : 'pass',
    });
  } else if (results.readonly) {
    checks.push({
      label: 'Proteção PRD',
      value: 'Ativa',
      sub: blockedWrites ? `${blockedWrites} escrita${blockedWrites > 1 ? 's' : ''} barrada${blockedWrites > 1 ? 's' : ''}` : '0 escritas tentadas',
      status: 'pass',
    });
  }

  return {
    assertTotal,
    assertPass,
    assertFail,
    assertWarn,
    assertPct,
    consoleErrors,
    networkErrors,
    blockedWrites,
    auditTotal,
    totalShots,
    scenariosWithShots,
    confidence,
    checks,
    findings,
  };
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const richEsc = (s) => esc(s).replace(/`([^`]+)`/g, '<code class="ic">$1</code>');
export const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
export const headOf = (results, card) => (card ? `${card.type} ${card.id} · ${card.title}` : results.title || (results.workItem ? `Item ${results.workItem}` : 'Desk check'));
export const when = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');
export const formatMs = (ms) => {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
};
export const totalDurationMs = (results) => {
  const sum = (results.scenarios || []).reduce((acc, sc) => acc + (typeof sc.durationMs === 'number' ? sc.durationMs : 0), 0);
  if (sum > 0) return sum;
  const a = Date.parse(results.startedAt || '');
  const b = Date.parse(results.finishedAt || '');
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a : 0;
};
