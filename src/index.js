import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { SequentialFetchVM } = require('sequential-fetch');

class InMemoryStorage {
  constructor() { this.data = new Map(); }
  async get(id) { return this.data.get(id); }
  async set(id, value) { this.data.set(id, value); }
  async del(id) { this.data.delete(id); }
}

function normalize(code) {
  let c = code.trim();
  let result = '', inString = false, stringChar = '', inTemplate = false;

  for (let i = 0; i < c.length; i++) {
    const char = c[i], prev = c[i - 1];
    if (!inString && !inTemplate && (char === '"' || char === "'")) { inString = true; stringChar = char; }
    else if (inString && char === stringChar && prev !== '\\') { inString = false; }
    else if (!inString && !inTemplate && char === '`') { inTemplate = true; }
    else if (inTemplate && char === '`' && prev !== '\\') { inTemplate = false; }

    if (!inString && !inTemplate && char === '\n') {
      const t = result.trim();
      if (t && !t.endsWith(';') && !t.endsWith('{') && !t.endsWith(',')) result += ';';
    } else result += char;
  }

  let keys = null;

  // Handle return { a, b } → convert to array, save keys for reconstruction
  if (result.includes('return ')) {
    const i = result.lastIndexOf('return ');
    let expr = result.slice(i + 7).replace(/;*$/, '').trim();

    if (expr.startsWith('{') && expr.endsWith('}')) {
      const inner = expr.slice(1, -1).trim();
      if (!inner.includes(':')) {
        keys = inner.split(',').map(v => v.trim());
        expr = '[' + keys.join(', ') + ']';
      }
    }

    result = result.slice(0, i) + expr;
  }

  return { code: result, keys };
}

function reconstruct(result, keys) {
  if (!keys || !Array.isArray(result)) return result;
  return Object.fromEntries(keys.map((k, i) => [k, result[i]]));
}

export async function run(code, id) {
  const taskId = id || `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { code: normalized, keys } = normalize(code);
  const vm = new SequentialFetchVM();

  try {
    await vm.initialize();
    const r = await vm.executeCode(normalized);

    if (r.type === 'pause') {
      await run.storage.set(taskId, {
        code: normalized, keys,
        state: r.state,
        paused: { ...vm.paused, variables: [...vm.paused.variables.entries()] }
      });
      return { id: taskId, status: 'paused', fetch: r.fetchRequest };
    }
    if (r.type === 'complete') return { id: taskId, status: 'done', result: reconstruct(r.result, keys) };
    return { id: taskId, status: 'error', error: r.error };
  } catch (e) {
    return { id: taskId, status: 'error', error: e.message };
  } finally {
    vm.dispose();
  }
}

export async function resume(id, data) {
  const stored = await run.storage.get(id);
  if (!stored) throw new Error(`Not found: ${id}`);

  const vm = new SequentialFetchVM();

  try {
    await vm.initialize();
    vm.paused = { ...stored.paused, variables: new Map(stored.paused.variables) };
    for (const [k, v] of vm.paused.variables) vm.variables.set(k, v);

    const r = await vm.resumeExecution(stored.state, data);

    if (r.type === 'pause') {
      await run.storage.set(id, {
        code: stored.code, keys: stored.keys,
        state: r.state,
        paused: { ...vm.paused, variables: [...vm.paused.variables.entries()] }
      });
      return { id, status: 'paused', fetch: r.fetchRequest };
    }
    await run.storage.del(id);
    if (r.type === 'complete') return { id, status: 'done', result: reconstruct(r.result, stored.keys) };
    return { id, status: 'error', error: r.error };
  } catch (e) {
    await run.storage.del(id);
    return { id, status: 'error', error: e.message };
  } finally {
    vm.dispose();
  }
}

run.storage = new InMemoryStorage();
export { InMemoryStorage };
