import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_CONFIG = join(ROOT, 'pipeline.config.json');
const HOME_CONFIG = join(homedir(), '.config', 'deskcheck', 'pipeline.config.json');
export const CONFIG_FILE = process.env.DESKCHECK_PIPELINE_CONFIG || (existsSync(LOCAL_CONFIG) || !existsSync(HOME_CONFIG) ? LOCAL_CONFIG : HOME_CONFIG);
export const CONFIG_EXAMPLE = join(ROOT, 'pipeline.config.example.json');

const expand = (p) => (typeof p === 'string' && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p || '');

function read() {
  if (!existsSync(CONFIG_FILE)) return { raw: {}, error: 'missing' };
  try {
    return { raw: JSON.parse(readFileSync(CONFIG_FILE, 'utf8')), error: '' };
  } catch (e) {
    return { raw: {}, error: `JSON inválido: ${e.message}` };
  }
}

const { raw, error } = read();

export const CONFIG = {
  error,
  azure: { org: process.env.DESKCHECK_ORG || raw.azure?.org || '', project: process.env.DESKCHECK_PROJECT || raw.azure?.project || '' },
  github: { org: process.env.GH_ORG || raw.github?.org || '', user: process.env.GH_USER || raw.github?.user || '' },
  reposDir: expand(process.env.REPOS_DIR || raw.reposDir || '~/deskcheck-repos'),
  repoPrefix: raw.repoPrefix || '',
  repos: (raw.repos || []).filter((r) => r?.name).map((r) => ({ name: r.name, app: r.app || r.name, port: Number(r.port) || 3100, kit: expand(r.kit) })),
  envs: Object.fromEntries((raw.envs || []).filter((e) => e?.id && e?.base).map((e) => [e.id, { id: e.id, label: e.label || String(e.id).toUpperCase(), base: e.base, adminUsers: e.adminUsers || '', appUsers: e.appUsers || '' }])),
  localGuide: expand(raw.localGuide),
  zoneRole: raw.zoneRole || '',
  allowInstallScripts: raw.allowInstallScripts === true,
  translate: raw.translate === true,
  agents: (raw.agents || []).filter((a) => a?.id && a?.bin && Array.isArray(a.args)),
  markFields: (raw.markFields || []).filter((f) => f?.label).map((f) => ({ label: f.label, ref: f.ref || '', value: f.value })),
};

export const workItemUrl = (id) => `https://dev.azure.com/${CONFIG.azure.org}/${CONFIG.azure.project}/_workitems/edit/${id}`;

export function configProblems() {
  if (CONFIG.error === 'missing') return [`sem ${CONFIG_FILE}: copie pipeline.config.example.json para pipeline.config.json e preencha`];
  if (CONFIG.error) return [`${CONFIG_FILE}: ${CONFIG.error}`];
  const out = [];
  if (!CONFIG.azure.org || !CONFIG.azure.project) out.push('azure.org e azure.project');
  if (CONFIG.azure.org === 'my-org' || CONFIG.github.org === 'my-github-org') return [`${CONFIG_FILE} ainda está com os valores de exemplo: preencha com os dados do seu time`];
  if (!CONFIG.github.org) out.push('github.org');
  if (!CONFIG.repos.length) out.push('repos (pelo menos um)');
  if (!Object.keys(CONFIG.envs).length) out.push('envs (pelo menos um)');
  if (!CONFIG.agents.length) out.push('agents (pelo menos um)');
  return out.length ? [`faltam em pipeline.config.json: ${out.join(', ')}`] : [];
}
