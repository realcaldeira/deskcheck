import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { CONFIG } from './config.mjs';

const expandArgs = (template, vars) =>
  (template || []).flatMap((arg) => {
    const each = /^\{dirs:(.+)\}$/.exec(arg);
    if (each) return vars.dirs.flatMap((d) => [each[1], d]);
    return [String(arg).replace(/\{(prompt|cwd|lastMessage|dirsCsv)\}/g, (_, k) => (k === 'dirsCsv' ? vars.dirs.join(',') : vars[k] ?? ''))];
  });

export function buildAgent(def) {
  return {
    id: def.id,
    name: def.name || def.id,
    bin: def.bin,
    fallbacks: def.fallbacks || [],
    install: def.install || `instale o comando ${def.bin}`,
    output: ['stream-json', 'events-json'].includes(def.output) ? def.output : 'text',
    args: ({ prompt, cwd, dirs = [], lastMessage = '' }) => expandArgs(def.args, { prompt, cwd, dirs, lastMessage }),
  };
}

export const AGENTS = CONFIG.agents.map(buildAgent);

export function which(bin, PATH = process.env.PATH || '') {
  if (!bin || /[\\/]/.test(bin)) return bin && existsSync(bin) ? bin : '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of String(PATH).split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, bin + ext);
      try {
        if (!statSync(file).isFile()) continue;
        if (process.platform !== 'win32') accessSync(file, constants.X_OK);
        return file;
      } catch { continue; }
    }
  }
  return '';
}

export function resolveBin(agent, PATH) {
  const found = which(agent.bin, PATH);
  if (found) return found;
  for (const candidate of agent.fallbacks || []) if (existsSync(candidate)) return candidate;
  return '';
}

export function listAgents(PATH) {
  return AGENTS.map((a) => {
    const path = resolveBin(a, PATH);
    return { id: a.id, name: a.name, bin: a.bin, available: !!path, path, install: a.install };
  });
}

export function parseItemEvent(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  if (ev.type === 'error' && ev.message) return { kind: 'error', level: 'bad', text: String(ev.message).slice(0, 260) };
  if (ev.type === 'turn.failed' && ev.error?.message) return { kind: 'error', level: 'bad', text: String(ev.error.message).slice(0, 260) };
  const item = ev.item;
  if (!item) return null;
  if (ev.type === 'item.started' && item.type === 'command_execution' && item.command) {
    return { kind: 'tool', level: '', command: String(item.command), text: `Bash: ${String(item.command).replace(/\s+/g, ' ').trim().slice(0, 180)}` };
  }
  if (ev.type === 'item.completed' && (item.type === 'agent_message' || item.type === 'message') && item.text) {
    return { kind: 'agent', level: '', fullText: String(item.text), text: String(item.text).trim().slice(0, 260) };
  }
  if (ev.type === 'item.completed' && item.type === 'error' && item.message) {
    return { kind: 'error', level: 'warn', text: String(item.message).slice(0, 260) };
  }
  return null;
}

export const findAgent = (id) => AGENTS.find((a) => a.id === id);

export function extractJson(text) {
  const blocks = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/g)];
  for (const b of blocks.reverse()) {
    try { return JSON.parse(b[1]); } catch { continue; }
  }
  const raw = String(text || '');
  for (let end = raw.lastIndexOf('}'); end >= 0; end = raw.lastIndexOf('}', end - 1)) {
    for (let start = raw.lastIndexOf('{', end); start >= 0; start = raw.lastIndexOf('{', start - 1)) {
      try {
        const obj = JSON.parse(raw.slice(start, end + 1));
        if (obj && typeof obj === 'object' && 'verdict' in obj) return obj;
      } catch { continue; }
      if (end - start > 200_000) break;
    }
    if (raw.length - end > 20_000) break;
  }
  return null;
}
