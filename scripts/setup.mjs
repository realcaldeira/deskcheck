import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, 'pipeline', 'pipeline.config.json');
const home = path.join(os.homedir(), '.config', 'deskcheck', 'pipeline.config.json');
const example = path.join(root, 'pipeline', 'pipeline.config.example.json');
const say = (s) => process.stdout.write(`${s}\n`);

try {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) say(`! Node ${process.versions.node}: o deskcheck precisa do Node 22 ou mais novo.`);

  if (process.env.DESKCHECK_PIPELINE_CONFIG) say(`Configuração: ${process.env.DESKCHECK_PIPELINE_CONFIG}`);
  else if (existsSync(local)) say(`Configuração: ${local}`);
  else if (existsSync(home)) say(`Configuração: ${home}`);
  else {
    copyFileSync(example, local);
    say(`Configuração criada a partir do exemplo: ${local}`);
    say('  Preencha com os dados do seu time, ou copie a sua para ~/.config/deskcheck/pipeline.config.json.');
  }

  say('\nAmbiente:');
  const r = spawnSync(process.execPath, [path.join(root, 'pipeline', 'bin', 'doctor.mjs'), '--quick'], { encoding: 'utf8', timeout: 60_000 });
  say((r.stdout || r.stderr || '').trim());
  say('\nPara subir: yarn dev (abre http://localhost:4310) ou yarn start.');
} catch (e) {
  say(`setup: ${e.message}`);
}
