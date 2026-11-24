import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCard, cardMarkdown, frontsOf, htmlToText, parseSteps, splitCriteria } from '../src/card.mjs';

test('critérios em <li> viram AC-n', () => {
  const ac = splitCriteria('<div>Given:</div><ul><li>1. Filter opens in <b>All Status</b></li><li>Status goes to the API&nbsp;request</li></ul>');
  assert.deepEqual(ac, [
    { id: 'AC-1', text: 'Filter opens in All Status' },
    { id: 'AC-2', text: 'Status goes to the API request' },
  ]);
});

test('lista + texto solto: os dois entram', () => {
  const ac = splitCriteria('<ul><li>Outlet above reach</li><li>Date above reach</li></ul><br><div>Test with different text lengths; the author stays at the bottom.</div>');
  assert.deepEqual(ac.map((a) => a.text), ['Outlet above reach', 'Date above reach', 'Test with different text lengths; the author stays at the bottom.']);
});

test('critérios em Gherkin são agrupados por cenário', () => {
  const ac = splitCriteria('<div>Scenario: open list</div><div>Given I am Reviewer</div><div>Then I see All Status</div><div>Scenario: filter</div><div>When I pick Approve</div>');
  assert.equal(ac.length, 2);
  assert.match(ac[0].text, /^Scenario: open list\nGiven I am Reviewer\nThen I see All Status$/);
});

test('critérios em linhas soltas, Given/When/Then juntam com a anterior', () => {
  const ac = splitCriteria('<p>- User sees the table</p><p>When filtering</p><p>- Empty state message</p>');
  assert.deepEqual(ac.map((a) => a.text), ['User sees the table\nWhen filtering', 'Empty state message']);
});

test('sem critério → lista vazia', () => {
  assert.deepEqual(splitCriteria('<div><br></div>'), []);
  assert.deepEqual(splitCriteria(undefined), []);
  assert.deepEqual(splitCriteria('<div>-</div>'), []);
  assert.deepEqual(splitCriteria('<p>N/A</p>'), []);
});

test('htmlToText decodifica entidades e mantém quebras', () => {
  assert.equal(htmlToText('<p>A &amp; B</p><p>C&#39;s &lt;x&gt;</p>'), "A & B\nC's <x>");
});

test('passos do Test Case (XML) viram ação e esperado', () => {
  const xml = '<steps id="0" last="3"><step id="2" type="ActionStep"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Open the list&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;All Status&lt;/P&gt;</parameterizedString><description/></step><step id="3" type="ValidateStep"><parameterizedString isformatted="true">Pick Approve</parameterizedString><parameterizedString isformatted="true"></parameterizedString></step></steps>';
  assert.deepEqual(parseSteps(xml), [
    { n: 1, action: 'Open the list', expected: 'All Status' },
    { n: 2, action: 'Pick Approve', expected: '' },
  ]);
});

test('frente sai das tags e do título', () => {
  assert.deepEqual(frontsOf('[FRONT]; release-1', '[BACK] Fix'), ['FRONT', 'BACK']);
  assert.deepEqual(frontsOf('FRONT', ''), ['FRONT']);
  assert.deepEqual(frontsOf('', 'No tag'), []);
});

test('buildCard separa Test Cases e Defects', () => {
  const us = {
    id: 1,
    fields: {
      'System.WorkItemType': 'User Story', 'System.Title': '[FRONT] Filters', 'System.State': 'Development',
      'System.Tags': '[FRONT]', 'System.AreaPath': 'A', 'System.IterationPath': 'I',
      'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>One</li></ul>', 'Custom.DeskCheckStandard': false,
    },
    relations: [
      { rel: 'Microsoft.VSTS.Common.TestedBy-Forward', url: 'https://x/_apis/wit/workItems/10' },
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://x/_apis/wit/workItems/11' },
      { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://x/_apis/wit/workItems/99' },
    ],
  };
  const rel = [
    { id: 10, fields: { 'System.WorkItemType': 'Test Case', 'System.Title': 'TC', 'System.State': 'Design', 'System.CreatedDate': '2026-01-01' } },
    { id: 11, fields: { 'System.WorkItemType': 'Defect', 'System.Title': 'D', 'System.State': 'New', 'System.CreatedDate': '2026-01-02', 'Custom.StepIdentifiedDefectStandard': 'Tests' } },
  ];
  const c = buildCard(us, rel);
  assert.equal(c.testCases.length, 1);
  assert.equal(c.defects[0].identified, 'Tests');
  assert.deepEqual(c.fronts, ['FRONT']);
  assert.equal(c.acceptanceCriteriaMissing, false);
  assert.equal(c.parent, null);

  const withParent = buildCard(us, [
    ...rel,
    { id: 99, fields: { 'System.WorkItemType': 'Feature', 'System.Title': '[Q4] Portal | Filters', 'System.State': 'Execution', 'System.CreatedDate': '2026-01-01' } },
  ]);
  assert.deepEqual(withParent.parent, {
    id: 99,
    type: 'Feature',
    title: '[Q4] Portal | Filters',
    state: 'Execution',
    url: '99',
  });
  assert.match(cardMarkdown(withParent), /Pai: Feature 99 · \[Q4\] Portal \| Filters \(Execution\)/);
});
