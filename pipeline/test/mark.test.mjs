import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlan, describeStep } from '../harness/deskcheck/lib/runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = mkdtempSync(join(tmpdir(), 'deskcheck-mark-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const plan = (steps) => ({ scenarios: [{ id: 'S1', title: 't', steps }] });

test('a mark needs a locator', () => {
  assert.deepEqual(validatePlan(plan([{ do: 'screenshot', mark: { text: 'Beta', note: 'x' } }])), []);
  assert.equal(validatePlan(plan([{ do: 'screenshot', mark: [{ note: 'no locator' }] }])).length, 1);
});

test('a marked screenshot says how many marks it has', () => {
  assert.match(describeStep({ do: 'screenshot', label: 'x', mark: [{ text: 'a' }, { text: 'b' }] }), /2 marcação/);
});

test('the screenshot comes out marked where the problem is', (t) => {
  copyFileSync(join(ROOT, 'harness', 'deskcheck', 'examples', 'demo.html'), join(DIR, 'demo.html'));
  writeFileSync(join(DIR, 'plan.json'), JSON.stringify({
    viewport: { width: 1280, height: 800 },
    beforeEach: [{ do: 'goto', url: 'demo.html' }],
    scenarios: [
      { id: 'S1', title: 'manual mark', steps: [{ do: 'screenshot', label: 'marked', mark: [{ text: 'Partner Beta', note: 'Status errado' }, { text: 'does not exist', note: 'missing' }] }] },
      { id: 'S2', title: 'automatic mark', steps: [{ do: 'expectValue', label: 'Filter by status', value: 'Approve', timeout: 1000 }] },
    ],
  }));
  const r = spawnSync(join(ROOT, 'harness', 'bin', 'deskcheck'), ['run', '--plan', join(DIR, 'plan.json'), '--url', `file://${DIR}/`, '--headless', '--no-open', '--profile', join(DIR, 'chrome')],
    { encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, timeout: 120000 });
  if (/Chrome|Chromium|Edge/i.test(r.stderr) && !existsSync(join(DIR, 'results.json'))) return t.skip(`Chrome indisponível: ${r.stderr.trim().split('\n').pop()}`);
  const results = JSON.parse(readFileSync(join(DIR, 'results.json'), 'utf8'));
  const [manual, auto] = results.scenarios.map((s) => s.shots[0]);
  assert.deepEqual(manual.marks.map((m) => [m.n, m.note]), [[1, 'Status errado']]);
  assert.ok(manual.marks[0].width > 0 && manual.marks[0].height > 0);
  for (const k of ['box', 'label']) {
    const a = manual.marks[0][k];
    assert.ok(a.x >= 0 && a.y >= 0 && a.w > 0 && a.h > 0 && a.x + a.w <= 1.01 && a.y + a.h <= 1.01, `${k} in fractions of the screenshot`);
  }
  assert.deepEqual(manual.missingMarks, [{ n: 2, note: 'missing' }]);
  assert.equal(results.scenarios[1].status, 'fail');
  assert.match(auto.marks[0].note, /Filter by status.*→/);
  assert.ok(existsSync(join(DIR, 'shots', manual.file)));
});
