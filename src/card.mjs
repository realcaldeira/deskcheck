const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|table|pre|blockquote)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join('\n')
    .trim();
}

const GHERKIN_START = /^(scenario|cenário|cenario|scenario outline|esquema do cenário)\b\s*:?/i;
const GHERKIN_CONT = /^(given|when|then|and|but|dado|dada|quando|então|entao|e|mas)\b/i;

function cleanItem(s) {
  return s.replace(/^\s*(?:[-*•▪◦]|\(?\d+[.)]|[a-z][.)]|AC[- ]?\d+\s*[:.)-])\s*/i, '').trim();
}

export function splitCriteria(html) {
  const raw = String(html ?? '');
  if (!htmlToText(raw)) return [];
  let items = [];
  const lis = [...raw.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => htmlToText(m[1]).replace(/\n+/g, ' ').trim());
  if (lis.filter(Boolean).length >= 1) {

    const outside = htmlToText(raw.replace(/<(ul|ol)\b[\s\S]*?<\/\1>/gi, '<br>'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/:$/.test(l));
    items = [...lis.filter(Boolean), ...outside];
  } else {
    const lines = htmlToText(raw).split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.some((l) => GHERKIN_START.test(l))) {
      let cur = null;
      for (const l of lines) {
        if (GHERKIN_START.test(l)) {
          if (cur) items.push(cur);
          cur = l;
        } else if (cur) cur += `\n${l}`;
        else items.push(l);
      }
      if (cur) items.push(cur);
    } else {

      for (const l of lines) {
        if (items.length && GHERKIN_CONT.test(l)) items[items.length - 1] += `\n${l}`;
        else items.push(l);
      }
    }
  }

  const empty = (t) => !/[\p{L}\p{N}]/u.test(t) || /^(n\/?a|tbd|tbc|none|nenhum|-+)$/i.test(t.trim());
  return items.map(cleanItem).filter((t) => t && !empty(t)).map((text, i) => ({ id: `AC-${i + 1}`, text }));
}

export function parseSteps(xml) {
  const out = [];
  const src = String(xml ?? '');
  for (const m of src.matchAll(/<step\b[^>]*>([\s\S]*?)<\/step>/gi)) {
    const parts = [...m[1].matchAll(/<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>/gi)].map((p) => htmlToText(decodeEntities(p[1])));
    out.push({ n: out.length + 1, action: parts[0] || '', expected: parts[1] || '' });
  }
  return out;
}

const FRONTS = ['ARQ', 'APP', 'BACK', 'FRONT', 'QA'];

export function frontsOf(tags, title) {
  const found = new Set();
  for (const t of String(tags ?? '').split(';').map((x) => x.trim())) {
    const k = t.replace(/[[\]]/g, '').toUpperCase();
    if (FRONTS.includes(k)) found.add(k);
  }
  for (const m of String(title ?? '').matchAll(/\[([a-z]+)\]/gi)) {
    const k = m[1].toUpperCase();
    if (FRONTS.includes(k)) found.add(k);
  }
  return [...found];
}

const person = (v) => (v && typeof v === 'object' ? v.displayName : v) || null;
const relId = (r) => Number(String(r.url).split('/').pop());

export const RELATED_FIELDS = [
  'System.Id',
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.Reason',
  'System.AssignedTo',
  'System.CreatedDate',
  'Microsoft.VSTS.TCM.Steps',
  'Custom.StepIdentifiedDefectStandard',
];

export function buildCard(item, related = [], { link = (id) => String(id) } = {}) {
  const f = item.fields || {};
  const rels = item.relations || [];
  const testedBy = new Set(rels.filter((r) => r.rel === 'Microsoft.VSTS.Common.TestedBy-Forward').map(relId));
  const children = new Set(rels.filter((r) => r.rel === 'System.LinkTypes.Hierarchy-Forward').map(relId));
  const parentId = rels.filter((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse').map(relId).find(Number.isFinite);
  const byId = new Map(related.map((r) => [Number(r.id), r]));
  const parentRaw = parentId ? byId.get(parentId) : null;
  const parent = parentRaw
    ? {
        id: Number(parentRaw.id),
        type: parentRaw.fields?.['System.WorkItemType'] || '',
        title: parentRaw.fields?.['System.Title'] || '',
        state: parentRaw.fields?.['System.State'] || '',
        url: link(parentRaw.id),
      }
    : null;
  const pick = (type) =>
    related
      .filter((r) => r.fields?.['System.WorkItemType'] === type && (testedBy.has(Number(r.id)) || children.has(Number(r.id))))
      .sort((a, b) => String(a.fields['System.CreatedDate']).localeCompare(String(b.fields['System.CreatedDate'])) || a.id - b.id);

  const acHtml = [f['Microsoft.VSTS.Common.AcceptanceCriteria'], f['Custom.BusinessAcceptanceCriteriaStandard'], f['Custom.TechnicalAcceptanceCriteriaStandard']]
    .filter((x) => x && htmlToText(x).replace(/[^\p{L}\p{N}]/gu, ''))
    .join('<br>');
  const criteria = splitCriteria(acHtml);
  const card = {
    id: Number(item.id),
    url: link(item.id),
    type: f['System.WorkItemType'],
    title: f['System.Title'],
    state: f['System.State'],
    assignedTo: person(f['System.AssignedTo']),
    tags: String(f['System.Tags'] || '').split(';').map((t) => t.trim()).filter(Boolean),
    fronts: frontsOf(f['System.Tags'], f['System.Title']),
    areaPath: f['System.AreaPath'],
    iterationPath: f['System.IterationPath'],
    parent,
    deskCheck: f['Custom.DeskCheckStandard'] ?? null,
    description: htmlToText(f['System.Description'] || f['Microsoft.VSTS.TCM.ReproSteps'] || ''),
    acceptanceCriteriaText: htmlToText(acHtml),
    acceptanceCriteria: criteria,
    acceptanceCriteriaMissing: criteria.length === 0,
    testCases: pick('Test Case').map((r) => ({
      id: Number(r.id),
      url: link(r.id),
      title: r.fields['System.Title'],
      state: r.fields['System.State'],
      assignedTo: person(r.fields['System.AssignedTo']),
      steps: parseSteps(r.fields['Microsoft.VSTS.TCM.Steps']),
    })),
    defects: pick('Defect').map((r) => ({
      id: Number(r.id),
      url: link(r.id),
      title: r.fields['System.Title'],
      state: r.fields['System.State'],
      identified: r.fields['Custom.StepIdentifiedDefectStandard'] || null,
    })),
    tasks: pick('Task').map((r) => ({ id: Number(r.id), title: r.fields['System.Title'], state: r.fields['System.State'] })),
    stories: ['User Story', 'Technical Story', 'Bug', 'No Code'].flatMap((t) => pick(t)).map((r) => ({ id: Number(r.id), type: r.fields['System.WorkItemType'], title: r.fields['System.Title'], state: r.fields['System.State'], url: link(r.id) })),
    fetchedAt: new Date().toISOString(),
  };
  card.unknownRelated = [...testedBy, ...children].filter((id) => !byId.has(id));
  return card;
}

export async function fetchCard(az, id) {
  const item = await az.getWorkItem(id);
  const ids = (item.relations || [])
    .filter((r) => r.rel === 'Microsoft.VSTS.Common.TestedBy-Forward' || r.rel === 'System.LinkTypes.Hierarchy-Forward' || r.rel === 'System.LinkTypes.Hierarchy-Reverse')
    .map(relId)
    .filter(Number.isFinite);
  const related = ids.length ? await az.getWorkItems(ids, RELATED_FIELDS) : [];
  return buildCard(item, related, { link: az.link });
}

export function cardMarkdown(c) {
  const L = [];
  L.push(`# ${c.type} ${c.id} · ${c.title}`, '');
  L.push(`- Link: ${c.url}`);
  if (c.parent) L.push(`- Pai: ${c.parent.type} ${c.parent.id} · ${c.parent.title} (${c.parent.state})`);
  L.push(`- Estado: ${c.state} · Responsável: ${c.assignedTo || '-'} · Desk Check: ${c.deskCheck === true ? 'marcado' : 'não marcado'}`);
  L.push(`- Frente: ${c.fronts.length ? c.fronts.map((x) => `[${x}]`).join(' ') : '(sem tag de frente)'} · Tags: ${c.tags.join(', ') || '-'}`);
  L.push(`- Iteration: ${c.iterationPath || '-'}`, '');
  if (c.description) L.push('## Descrição', '', c.description, '');
  L.push('## Critérios de aceite', '');
  if (c.acceptanceCriteriaMissing) L.push('**Sem critério de aceite.** Pelo processo, a história não deve ser testada sem eles: avise o usuário.', '');
  for (const a of c.acceptanceCriteria) L.push(`- **${a.id}** ${a.text.replace(/\n/g, '\n  ')}`);
  L.push('');
  L.push(`## Test Cases (${c.testCases.length})`, '');
  if (!c.testCases.length) L.push('Nenhum Test Case ligado (Tested By). Os cenários saem só dos critérios de aceite.', '');
  for (const t of c.testCases) {
    L.push(`### TC ${t.id} · ${t.title} (${t.state})`);
    for (const s of t.steps) L.push(`${s.n}. ${s.action.replace(/\n/g, ' ')}${s.expected ? `\n   → Esperado: ${s.expected.replace(/\n/g, ' ')}` : ''}`);
    L.push('');
  }
  if (c.stories?.length) {
    L.push(`## Filhos (${c.stories.length})`, '');
    for (const st of c.stories) L.push(`- ${st.type} ${st.id} · ${st.title} (${st.state})`);
    L.push('');
  }
  L.push(`## Defects já abertos (${c.defects.length})`, '');
  for (const d of c.defects) L.push(`- ${d.id} · ${d.title} (${d.state}${d.identified ? ` · ${d.identified}` : ''})`);
  if (!c.defects.length) L.push('Nenhum.');
  L.push('');
  return L.join('\n');
}
