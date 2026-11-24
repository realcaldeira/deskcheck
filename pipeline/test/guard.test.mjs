import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'harness', 'guard');
const DESKCHECK = join(ROOT, 'harness', 'bin', 'deskcheck');
const env = { ...process.env, PATH: `${GUARD}:${dirname(process.execPath)}:${process.env.PATH}` };
const SANDBOX = mkdtempSync(join(tmpdir(), 'deskcheck-guard-'));
const CANARY = join(SANDBOX, 'canary.txt');
spawnSync('git', ['init', '-q', SANDBOX]);
writeFileSync(CANARY, 'must survive');
spawnSync('git', ['-C', SANDBOX, 'add', '.']);
after(() => rmSync(SANDBOX, { recursive: true, force: true }));
const run = (cmd, args, extraEnv = {}) => spawnSync(cmd, args, { env: { ...env, ...extraEnv }, encoding: 'utf8', cwd: SANDBOX });

for (const [cmd, args] of [
  ['git', ['commit', '-m', 'x']], ['git', ['push']], ['git', ['-C', '.', 'reset', '--hard']], ['git', ['-c', 'a=b', 'commit']],
  ['git', ['--git-dir', '.git', 'rebase', 'x']], ['git', ['--no-pager', 'merge', 'x']],
  ['git', ['-c', 'alias.st=push', 'st']], ['git', ['-calias.st=push', 'st']], ['git', ['--config-env=alias.st=X', 'st']], ['git', ['config', 'alias.st', 'push']], ['git', ['stash']], ['git', ['remote', 'set-url', 'origin', 'x']],
  ['git', ['config', 'user.name', '--get']], ['git', ['config', 'alias.x', '!sh -c "x" --list ']], ['git', ['remote', 'add', 'x', 'remote -v ']], ['git', ['remote', '-v', 'add', 'x', 'y']],
  ['git', ['branch', '-D', 'main']], ['git', ['branch', 'new-branch']], ['git', ['checkout', '.']], ['git', ['worktree', 'remove', 'x']], ['git', ['update-index', '--refresh']], ['git', ['unknown-subcommand']],
  ['git', ['grep', '-Otouch', 'x']], ['git', ['grep', '--open-files-in-pager=touch', 'x']], ['git', ['log', '--output=canary.txt']], ['git', ['diff', '-o', 'canary.txt']], ['git', ['show', '--output', 'canary.txt']],
  ['git', ['fetch', '--upload-pack=touch x', 'origin']], ['git', ['clone', 'x']], ['git', ['archive', 'HEAD']], ['git', ['ls-remote', '--upload-pack=x', '.']], ['git', ['-p', 'log']], ['git', ['--exec-path=/tmp', 'status']], ['git', ['--paginate', 'status']],
  ['git', ['branch', '--list', 'new']], ['git', ['branch', '-v', 'new']], ['git', ['branch', '--contains', 'x', 'new']], ['git', ['stash', 'list', '--output=x']],
  ['gh', ['pr', 'comment', '1', '-b', 'x']], ['gh', ['pr', 'create']], ['gh', ['api', 'repos/x/y']],
  ['az', ['boards', 'work-item', 'update', '--id', '1']], ['az', ['devops', 'invoke']],
]) {
  test(`blocks ${cmd} ${args.join(' ')}`, () => {
    const r = run(join(GUARD, cmd), args);
    assert.equal(r.status, 87);
    assert.match(r.stderr, /esteira: bloqueado/);
  });
}

test('lets git reads through', () => {
  const r = run(join(GUARD, 'git'), ['--version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /git version/);
  assert.equal(run(join(GUARD, 'git'), ['-C', SANDBOX, 'status', '--short']).status, 0);
  assert.equal(run(join(GUARD, 'git'), ['remote', '-v']).status, 0);
  assert.equal(run(join(GUARD, 'git'), ['config', '--list']).status, 0);
  for (const args of [['log', '--oneline', '-1'], ['diff', '--stat'], ['branch', '--show-current'], ['branch', '-a'], ['rev-parse', '--git-dir'], ['worktree', 'list'], ['ls-files'], ['ls-files', '-o'], ['--no-pager', 'log', '-1'], ['-C', '.', 'status'], ['grep', '-n', 'must', 'canary.txt'], ['config', '--get', 'user.name']]) {
    assert.notEqual(run(join(GUARD, 'git'), args).status, 87, args.join(' '));
  }
});

test('no blocked command touched the files', () => {
  assert.equal(readFileSync(CANARY, 'utf8'), 'must survive');
});

for (const sub of ['defect', 'evidence', 'mark', 'apply', 'discard']) {
  test(`blocks deskcheck ${sub}`, () => {
    assert.equal(run(DESKCHECK, [sub, '1']).status, 87);
  });
}

test('no environment variable unlocks Azure writes', () => {
  assert.equal(run(DESKCHECK, ['apply', 'A7K2'], { ESTEIRA_SOMENTE_LEITURA: '0' }).status, 87);
  assert.equal(run(DESKCHECK, ['apply', 'A7K2'], { DESKCHECK_PIPELINE: '' }).status, 87);
  for (const args of [['--root', '.deskcheck', 'mark', '123'], ['--dir', 'x', 'defect', '1', '--scenario', 'S1'], ['--root=x', 'evidence', '1'], ['--root', 'x', 'discard', 'A7K2']]) {
    const r = run(DESKCHECK, args);
    assert.equal(r.status, 87, args.join(' '));
    assert.match(r.stderr, /esteira: bloqueado/);
  }
});

test('deskcheck without a command prints the help', () => {
  const r = run(DESKCHECK, []);
  assert.match(r.stdout + r.stderr, /deskcheck/);
});
