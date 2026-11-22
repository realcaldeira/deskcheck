import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.resolve(process.env.DESKCHECK_SKILL || path.join(os.homedir(), '.agents', 'skills', 'deskcheck'));

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(path.join(root, 'skill'), dest, { recursive: true });
mkdirSync(path.join(dest, 'bin'), { recursive: true });
cpSync(path.join(root, 'bin', 'deskcheck.mjs'), path.join(dest, 'bin', 'deskcheck.mjs'));
mkdirSync(path.join(dest, 'lib'), { recursive: true });
cpSync(path.join(root, 'src'), path.join(dest, 'lib'), { recursive: true });
mkdirSync(path.join(dest, 'examples'), { recursive: true });
cpSync(path.join(root, 'test', 'fixtures', 'demo.html'), path.join(dest, 'examples', 'demo.html'));
console.log(`skill copiada para ${dest}`);

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const extraDirs = (process.env.DESKCHECK_SKILL_LINKS || '')
  .split(path.delimiter)
  .map((s) => s.trim())
  .filter(Boolean);

for (const rawDir of extraDirs) {
  const dir = path.resolve(rawDir);
  const link = path.join(dir, 'deskcheck');
  mkdirSync(dir, { recursive: true });
  if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) {
    const st = lstatSync(link);
    if (st.isSymbolicLink() && path.resolve(dir, readlinkSync(link)) === dest) {
      console.log(`ok   ${link}`);
      continue;
    }
    if (!st.isSymbolicLink()) {
      console.log(`pulei ${link}: já existe uma pasta de verdade ali (não mexi)`);
      continue;
    }
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(dest, link, linkType);
  console.log(`link ${link} → ${dest}`);
}
