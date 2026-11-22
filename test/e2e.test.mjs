import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { chromeCandidates } from '../src/cdp.mjs';
import { reportHtml, reportMarkdown } from '../src/report.mjs';
import { runPlan } from '../src/runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hasChrome = chromeCandidates().some((p) => existsSync(p));

test('roda o plano de exemplo na demo: 3 passam, 1 falha com print', { skip: !hasChrome && 'sem Chrome', timeout: 120_000 }, async () => {
  const plan = JSON.parse(readFileSync(path.join(here, '..', 'skill', 'examples', 'plan.json'), 'utf8'));
  const out = mkdtempSync(path.join(os.tmpdir(), 'deskcheck-e2e-'));
  const results = await runPlan(plan, {
    baseUrl: `${pathToFileURL(path.join(here, 'fixtures')).href}/`,
    outDir: out,
    profileDir: path.join(out, 'chrome'),
  });
  assert.deepEqual(results.scenarios.map((s) => s.status), ['pass', 'pass', 'pass', 'fail']);
  const s4 = results.scenarios[3];
  assert.match(s4.error, /Pending my actions/);
  assert.ok(s4.shots.some((s) => /falha/.test(s.file) && existsSync(path.join(out, 'shots', s.file))));
  assert.match(reportMarkdown(results, null), /reprovado: 1 de 4/i);
  assert.match(reportHtml(results, null, out), /data:image\/(png|jpeg);base64,/);
});
