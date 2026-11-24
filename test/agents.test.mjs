import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgent, listAgents, extractJson, parseItemEvent } from '../server/agents.mjs';

const plain = buildAgent({ id: 'agent', bin: 'my-agent', args: ['-p', '{prompt}', '{dirs:--add-dir}', '--include', '{dirsCsv}'] });
const events = buildAgent({ id: 'agent-events', name: 'Events', bin: 'other', output: 'events-json', install: 'install it', args: ['exec', '--json', '-C', '{cwd}', '--output-last-message', '{lastMessage}', '{prompt}'] });

test('an agent definition becomes what the pipeline needs', () => {
  for (const a of [plain, events]) {
    assert.ok(a.id && a.name && a.bin && a.install && a.output, a.id);
    assert.ok(a.args({ prompt: 'P', cwd: '/w', dirs: ['/a', '/b'], lastMessage: '/tmp/u' }).includes('P'), `${a.id} receives the prompt`);
  }
  assert.equal(plain.output, 'text');
  assert.equal(plain.name, 'agent');
  assert.equal(buildAgent({ id: 'x', bin: 'x', args: [], output: 'weird' }).output, 'text');
});

test('argument templates expand folders, paths and the prompt', () => {
  assert.deepEqual(plain.args({ prompt: 'P', cwd: '/w', dirs: ['/a', '/b'] }), ['-p', 'P', '--add-dir', '/a', '--add-dir', '/b', '--include', '/a,/b']);
  assert.deepEqual(events.args({ prompt: 'P', cwd: '/w', dirs: [], lastMessage: '/tmp/u' }), ['exec', '--json', '-C', '/w', '--output-last-message', '/tmp/u', 'P']);
});

test('reports which agents are installed', () => {
  for (const a of listAgents('/bin:/usr/bin')) assert.equal(typeof a.available, 'boolean');
});

test('takes the last valid json block from the answer', () => {
  const text = 'text\n```json\n{"verdict":"x"}\n```\nmore\n```json\n{"verdict":"approved","scenarios":[]}\n```\n```json\n{broken\n```';
  assert.equal(extractJson(text).verdict, 'approved');
  assert.equal(extractJson('no json'), null);
  assert.equal(extractJson('Done.\n{"verdict":"rejected","scenarios":[{"id":"S1","status":"fail"}]}\nbye').verdict, 'rejected');
  assert.equal(extractJson('```json\n{"verdict":"approved",}\n```\n{"other":1}'), null);
});

test('parses item events from a json stream', () => {
  const cmd = parseItemEvent(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'deskcheck run --plan p.json' } }));
  assert.equal(cmd.kind, 'tool');
  assert.match(cmd.text, /^Bash: deskcheck run/);
  const msg = parseItemEvent(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }));
  assert.equal(msg.kind, 'agent');
  assert.equal(msg.fullText, 'Done');
  assert.equal(parseItemEvent(JSON.stringify({ type: 'error', message: '403 Forbidden' })).level, 'bad');
});
