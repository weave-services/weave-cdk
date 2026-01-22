import { createRequire } from 'module';
const require = createRequire(import.meta.url);
function getSequentialFetchVM() {
  const mod = require('sequential-fetch');
  return mod.SequentialFetchVM;
}

/**
 * Extremely small, async-friendly, in-memory KV store.
 * (You can swap this with Redis/S3/etc by providing the same interface.)
 */
class InMemoryStorage {
  constructor() { this.data = new Map(); }
  /** @param {string} id */
  async get(id) { return this.data.get(id); }
  /** @param {string} id @param {any} value */
  async set(id, value) { this.data.set(id, value); }
  /** @param {string} id */
  async del(id) { this.data.delete(id); }
}

/**
 * Internal registry for code transformation + metadata.
 *
 * specs[] is used by transform(), and is the only thing required for the VM rewriting flow.
 * nodeRegistry is optional metadata (but makes SDK/type generation possible).
 */
const specs = [];
const nodeRegistry = {
  /** @type {Map<string, any>} sdkName -> NodeEntry */
  bySdkName: new Map(),
  /** @type {Map<string, any>} rawName -> NodeEntry */
  byRawName: new Map(),
};

const OP_SELECTOR_FALLBACK = 'operation';

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} s */
function isValidIdentifier(s) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) && !isReservedWord(s);
}

/** @param {string} s */
function isReservedWord(s) {
  // Keep it tiny; we just want to avoid generating obviously broken identifiers.
  return new Set([
    'break','case','catch','class','const','continue','debugger','default','delete','do','else',
    'export','extends','finally','for','function','if','import','in','instanceof','new','return',
    'super','switch','this','throw','try','typeof','var','void','while','with','yield','let',
    'enum','await','implements','package','protected','static','interface','private','public',
  ]).has(s);
}

/**
 * Convert arbitrary strings to a safe JS identifier (lowerCamelCase).
 * Ensures stable output and avoids collisions by suffixing when needed.
 *
 * @param {string} raw
 * @param {Set<string>} used
 */
function toSafeIdentifier(raw, used = new Set()) {
  const parts = String(raw)
    .split(/[^A-Za-z0-9]+/g)
    .filter(Boolean);

  let out = parts.length ? parts[0] : 'op';
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    out += p ? p[0].toUpperCase() + p.slice(1) : '';
  }

  if (!out) out = 'op';
  if (/^[0-9]/.test(out)) out = '_' + out;
  if (!/^[A-Za-z_$]/.test(out)) out = '_' + out.replace(/[^A-Za-z0-9_$]/g, '_');
  if (isReservedWord(out)) out = '_' + out;

  // Ensure uniqueness within the same scope.
  if (!used.has(out)) {
    used.add(out);
    return out;
  }
  let i = 2;
  while (used.has(out + '_' + i)) i++;
  const unique = out + '_' + i;
  used.add(unique);
  return unique;
}

/**
 * Determine how a node expresses its "operations".
 *
 * We support the 4 shapes seen in nodes(1).json:
 *  1) Selector: actions[0] is an options selector (type: "options"), options[].name are operations
 *  2) Operation list (name): actions[] entries have {label,name,description?} (no "type")
 *  3) Operation list (operation): actions[] entries have {label,operation,description?}
 *  4) No actions: single implicit operation "run"
 *
 * @param {any} node
 */
function deriveOperations(node) {
  const actions = Array.isArray(node?.actions) ? node.actions : [];
  if (!actions.length) {
    return {
      opKey: null,
      operations: [{
        raw: 'run',
        call: 'run',
        path: 'run',
        label: 'Run',
        description: node?.description,
      }],
      actionParams: [],
      operationSelector: null,
    };
  }

  const first = actions[0];

  // Shape 1: selector object with {name,type:"options",options:[...]}
  if (first && typeof first === 'object' && first.type && Array.isArray(first.options) && first.name) {
    const opKey = String(first.name || OP_SELECTOR_FALLBACK);
    const used = new Set();
    const operations = first.options
      .map((opt) => {
        const raw = String(opt?.name ?? '');
        if (!raw) return null;
        const call = isValidIdentifier(raw) ? raw : toSafeIdentifier(raw, used);
        return {
          raw,
          call,
          path: raw, // URL path segment(s) use the raw operation id
          label: opt?.label,
          description: opt?.description,
        };
      })
      .filter(Boolean);

    // All action parameters (including the selector itself) are kept for typing/introspection.
    // BUT the SDK method implies the selector value, so consumers usually only set the remaining ones.
    const actionParams = actions;

    return { opKey, operations, actionParams, operationSelector: first };
  }

  // Shape 3: operation list with {operation: "..."}
  if (first && typeof first === 'object' && 'operation' in first) {
    const used = new Set();
    const operations = actions
      .map((a) => {
        const raw = String(a?.operation ?? '');
        if (!raw) return null;
        const call = isValidIdentifier(raw) ? raw : toSafeIdentifier(raw, used);
        return { raw, call, path: raw, label: a?.label, description: a?.description };
      })
      .filter(Boolean);

    return { opKey: OP_SELECTOR_FALLBACK, operations, actionParams: [], operationSelector: null };
  }

  // Shape 2: operation list with {name: "..."} (no "type")
  if (first && typeof first === 'object' && 'name' in first) {
    const used = new Set();
    const operations = actions
      .map((a) => {
        const raw = String(a?.name ?? '');
        if (!raw) return null;
        const call = isValidIdentifier(raw) ? raw : toSafeIdentifier(raw, used);
        return { raw, call, path: raw, label: a?.label, description: a?.description };
      })
      .filter(Boolean);

    return { opKey: OP_SELECTOR_FALLBACK, operations, actionParams: [], operationSelector: null };
  }

  // Fallback: treat as single operation.
  return {
    opKey: null,
    operations: [{
      raw: 'run',
      call: 'run',
      path: 'run',
      label: 'Run',
      description: node?.description,
    }],
    actionParams: actions,
    operationSelector: null,
  };
}

/**
 * Normalize a node into a NodeEntry with a safe SDK name and a set of methods.
 * Preserves the original node schema verbatim under `schema`.
 *
 * @param {any} node
 */
function normalizeNode(node) {
  const rawName = String(node?.name ?? '');
  if (!rawName) return null;

  const sdkName = isValidIdentifier(rawName) ? rawName : toSafeIdentifier(rawName);

  const { opKey, operations, actionParams, operationSelector } = deriveOperations(node);

  // Convert operations into spec methods (call-path -> url-path mapping).
  const methods = operations.map((op) => ({
    call: op.call,
    path: op.path,
    raw: op.raw,
    label: op.label,
    description: op.description,
  }));

  return {
    rawName,
    sdkName,
    type: node?.type,
    category: node?.category,
    version: node?.version,
    label: node?.label,
    description: node?.description,
    icons: node?.icons,
    incoming: node?.incoming,
    outgoing: node?.outgoing,
    filePath: node?.filePath,
    loadMethods: node?.loadMethods ?? {},
    actions: node?.actions ?? [],
    networks: node?.networks ?? [],
    credentials: node?.credentials ?? [],
    inputParameters: node?.inputParameters ?? [],
    nodeState: node?.nodeState,
    // Derived
    opKey,
    operationSelector,
    operations,
    actionParams,
    methods,
    // Preserve everything (incl. any extra fields)
    schema: node,
  };
}

/**
 * Registered specs for code transformation.
 *
 * A "spec" here means:
 * - `name`: the identifier you use in code (sdkName)
 * - `methods`: array of method descriptors
 *
 * The transform replaces:  <name>.<method>(args...)  -> fetch("<base>/<path>?args=...")
 *
 * Important: this is string rewriting, so keep the method names stable.
 */

/**
 * Register a spec (backward compatible).
 *
 * @param {{ name: string, methods: Array<string | {call:string, path?:string}> }} spec
 * @param {string} endpoint
 */
export function use(spec, endpoint) {
  const { name, methods } = spec;
  const base = endpoint.replace(/\/$/, '');

  const patterns = (methods || []).map((m) => {
    const call = typeof m === 'string' ? m : m.call;
    const path = typeof m === 'string' ? m : (m.path ?? m.call);
    const parts = String(call).split('.');
    const pattern = `${escapeRegExp(name)}\\.${parts.map(escapeRegExp).join('\\.')}\\s*\\(([^)]*?)\\)`;
    return {
      regex: new RegExp(pattern, 'g'),
      urlPath: String(path).replace(/^\//, ''),
      callPath: call,
    };
  }).sort((a, b) => b.urlPath.length - a.urlPath.length);

  specs.push({ name, base, patterns });
}

/**
 * Register ALL nodes from a nodes-registry JSON array.
 *
 * This is the dynamic "SDK spec" bridge from your low-code schema.
 *
 * @param {any[]} nodesRegistryJson
 * @param {string} endpoint Base API endpoint. Each node will be registered at `${endpoint}/${rawNodeName}`.
 * @param {{ includeNonActionNodes?: boolean }} [options]
 */
export function useNodesRegistry(nodesRegistryJson, endpoint, options = {}) {
  const base = endpoint.replace(/\/$/, '');
  const includeNonActionNodes = options.includeNonActionNodes ?? true;

  if (!Array.isArray(nodesRegistryJson)) {
    throw new Error('useNodesRegistry: expected nodesRegistryJson to be an array');
  }

  const results = {
    registered: 0,
    skipped: 0,
    nodes: /** @type {any[]} */ ([]),
  };

  for (const node of nodesRegistryJson) {
    const entry = normalizeNode(node);
    if (!entry) { results.skipped++; continue; }

    if (!includeNonActionNodes && entry.type !== 'action') {
      results.skipped++;
      continue;
    }

    // Register transform spec under the *SDK name* (safe identifier),
    // while routing fetches to the *raw name* endpoint path.
    use(
      { name: entry.sdkName, methods: entry.methods.map(m => ({ call: m.call, path: m.path })) },
      `${base}/${encodeURIComponent(entry.rawName)}`
    );

    nodeRegistry.bySdkName.set(entry.sdkName, entry);
    nodeRegistry.byRawName.set(entry.rawName, entry);

    results.registered++;
    results.nodes.push(entry);
  }

  return results;
}

/**
 * Get a snapshot of the normalized node registry.
 * (Useful for UI/autocomplete/introspection in your editor.)
 */
export function getNodeRegistry() {
  return {
    bySdkName: new Map(nodeRegistry.bySdkName),
    byRawName: new Map(nodeRegistry.byRawName),
  };
}

/**
 * Transform user code by rewriting registered SDK calls into fetch() calls.
 *
 * NOTE: This is intentionally simple. It assumes calls are of the form:
 *   sdkName.methodName(<no unmatched ')'>)
 *
 * If you need fully general JS parsing, swap this for an AST transform.
 *
 * @param {string} code
 */
function transform(code) {
  let result = code;
  for (const { base, patterns } of specs) {
    for (const { regex, urlPath } of patterns) {
      result = result.replace(regex, (_, args) => {
        const argsStr = String(args ?? '').trim();
        if (!argsStr) return `fetch("${base}/${urlPath}")`;
        return `fetch("${base}/${urlPath}?args="+encodeURIComponent(JSON.stringify([${argsStr}])))`;
      });
    }
  }
  return result;
}

/**
 * Normalize user code:
 * - Trim
 * - Transform SDK calls -> fetch()
 * - Insert semicolons on line breaks where appropriate
 * - If code contains `return ...`, rewrite to return-expression-only (so the VM can evaluate it)
 *
 * @param {string} code
 */
function normalize(code) {
  let c = transform(code.trim());
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

  if (result.includes('return ')) {
    const i = result.lastIndexOf('return ');
    let expr = result.slice(i + 7).replace(/;*$/, '').trim();

    // Support: return { a, b } -> return [a,b] with later reconstruction
    if (expr.startsWith('{') && expr.endsWith('}')) {
      const inner = expr.slice(1, -1).trim();
      if (inner && !inner.includes(':')) {
        keys = inner.split(',').map(v => v.trim()).filter(Boolean);
        expr = '[' + keys.join(', ') + ']';
      }
    }

    result = result.slice(0, i) + expr;
  }

  return { code: result, keys };
}

/** @param {any} result @param {string[] | null} keys */
function reconstruct(result, keys) {
  if (!keys || !Array.isArray(result)) return result;
  return Object.fromEntries(keys.map((k, i) => [k, result[i]]));
}

/**
 * Execute a workflow snippet.
 *
 * @param {string} code
 * @param {string} [id]
 */
export async function run(code, id) {
  const taskId = id || `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { code: normalized, keys } = normalize(code);
  const SequentialFetchVM = getSequentialFetchVM();
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
    return { id: taskId, status: 'error', error: e?.message ?? String(e) };
  } finally {
    vm.dispose();
  }
}

/**
 * Resume a paused workflow snippet.
 *
 * @param {string} id
 * @param {any} data
 */
export async function resume(id, data) {
  const stored = await run.storage.get(id);
  if (!stored) throw new Error(`Not found: ${id}`);

  const SequentialFetchVM = getSequentialFetchVM();
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
    return { id, status: 'error', error: e?.message ?? String(e) };
  } finally {
    vm.dispose();
  }
}

run.storage = new InMemoryStorage();
export { InMemoryStorage };

/**
 * OPTIONAL: Create a runtime SDK (Proxy-based) instead of string-transform usage.
 *
 * This is handy if you want to call nodes programmatically without rewriting code,
 * while still benefiting from SequentialFetchVM pausing on fetch().
 *
 * @param {any[]} nodesRegistryJson
 * @param {string} endpoint Base API endpoint
 */
export function createSDK(nodesRegistryJson, endpoint) {
  // Ensure registry is populated (idempotent-ish, but repeated calls will register duplicates in specs[]).
  // If you don't want duplicates, call useNodesRegistry() once at process startup.
  const { nodes } = useNodesRegistry(nodesRegistryJson, endpoint);

  /** @type {Map<string, any>} */
  const bySdkName = new Map(nodes.map(n => [n.sdkName, n]));
  /** @type {Map<string, any>} */
  const byRawName = new Map(nodes.map(n => [n.rawName, n]));

  const root = {};
  return new Proxy(root, {
    get(_t, prop) {
      if (prop === '__registry') return { bySdkName, byRawName };
      const key = String(prop);

      const node = bySdkName.get(key) || byRawName.get(key);
      if (!node) return undefined;

      const nodeBase = `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(node.rawName)}`;

      return new Proxy({}, {
        get(_t2, opProp) {
          if (opProp === '__node') return node;
          const opKey = String(opProp);

          const op = node.methods.find(m => m.call === opKey);
          if (!op) return undefined;

          return (...args) => {
            if (!args.length) return fetch(`${nodeBase}/${op.path.replace(/^\//, '')}`);
            return fetch(`${nodeBase}/${op.path.replace(/^\//, '')}?args=` +
              encodeURIComponent(JSON.stringify(args)));
          };
        }
      });
    }
  });
}

/**
 * OPTIONAL: Generate TypeScript declarations from a nodes registry.
 *
 * This returns a .d.ts string you can write to disk, for IDE autocomplete.
 *
 * NOTE: For big registries, the output will be large.
 *
 * @param {any[]} nodesRegistryJson
 */
export function generateTypes(nodesRegistryJson) {
  if (!Array.isArray(nodesRegistryJson)) throw new Error('generateTypes: expected an array');

  /** @type {any[]} */
  const nodes = nodesRegistryJson.map(normalizeNode).filter(Boolean);

  const lines = [];
  lines.push('/* eslint-disable */');
  lines.push('// AUTO-GENERATED. DO NOT EDIT BY HAND.');
  lines.push('');
  lines.push('export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue };');
  lines.push('export type AnyRecord = Record<string, any>;');
  lines.push('');
  lines.push('export interface FetchLike { (input: RequestInfo | URL, init?: RequestInit): Promise<Response>; }');
  lines.push('');
  lines.push('export interface InMemoryStorageLike { get(id: string): Promise<any>; set(id: string, value: any): Promise<void>; del(id: string): Promise<void>; }');
  lines.push('');

  // Helper: map schema param -> TS type
  function tsTypeForParam(p) {
    const t = p?.type;
    if (t === 'string' || t === 'code') return 'string';
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'date') return 'string | Date';
    if (t === 'json') return 'AnyRecord | JSONValue';
    if (t === 'object') return 'AnyRecord';
    if (t === 'file') return 'Blob | File | string';
    if (t === 'string[]') return 'string[]';

    if (t === 'options') {
      const opts = Array.isArray(p?.options) ? p.options : [];
      const names = [...new Set(opts.map(o => o?.name).filter(Boolean))];
      if (!names.length) return 'string';
      // Avoid generating insanely long unions for very large option lists:
      if (names.length > 250) return 'string';
      return names.map(n => JSON.stringify(String(n))).join(' | ');
    }

    if (t === 'asyncOptions') return 'string';

    if (t === 'array') {
      // Two shapes:
      //  - { type:'array', items:{type:'string'} } (JSON schema-ish)
      //  - { type:'array', array:[ {name,type,...}, ... ] } (UI schema)
      if (p?.items?.type) {
        const inner = tsTypeForParam(p.items);
        return `Array<${inner}>`;
      }
      const arr = Array.isArray(p?.array) ? p.array : null;
      if (arr) {
        const fields = new Map();
        for (const f of arr) {
          const nm = f?.name;
          if (!nm) continue;
          const ft = tsTypeForParam(f);
          const prev = fields.get(nm);
          fields.set(nm, prev ? `${prev} | ${ft}` : ft);
        }
        const fieldLines = [];
        for (const [nm, ft] of fields.entries()) {
          fieldLines.push(`${JSON.stringify(nm)}?: ${ft};`);
        }
        return `Array<{ ${fieldLines.join(' ')} }>`;
      }
      return 'any[]';
    }

    if (t === 'collection') {
      const opts = Array.isArray(p?.options) ? p.options : null;
      if (!opts) return 'AnyRecord';
      const fieldLines = [];
      for (const f of opts) {
        if (!f?.name) continue;
        const optional = !!f.optional || f.required === false;
        fieldLines.push(`${JSON.stringify(f.name)}${optional ? '?:' : ':'} ${tsTypeForParam(f)};`);
      }
      return `{ ${fieldLines.join(' ')} }`;
    }

    // Unknown/custom types => any
    return 'any';
  }

  // Produce namespaces per node
  lines.push('export namespace Nodes {');
  for (const node of nodes) {
    lines.push(`  export namespace ${node.sdkName} {`);
    lines.push(`    export type RawNodeName = ${JSON.stringify(node.rawName)};`);
    lines.push(`    export type NodeType = ${JSON.stringify(node.type ?? 'action')};`);
    lines.push(`    export type Category = ${JSON.stringify(node.category ?? '')};`);
    lines.push(`    export type Version = ${JSON.stringify(node.version ?? '')};`);
    lines.push('');

    // operations
    const opCalls = node.methods.map(m => m.call);
    lines.push(`    export type Operations = ${opCalls.map(n => JSON.stringify(n)).join(' | ') || 'never'};`);
    lines.push('');

    // For each operation, compute params type by including:
    //  - inputParameters filtered by `show: { "actions.<opKey>": [rawOp] }` if possible
    //  - action parameters (excluding the op selector itself) similarly filtered
    //  - networks + credentials (unfiltered; but keep optional/required flags)
    const opKey = node.opKey;

    const inputParams = Array.isArray(node.inputParameters) ? node.inputParameters : [];
    const actionParams = Array.isArray(node.actionParams) ? node.actionParams : [];
    const networkParams = Array.isArray(node.networks) ? node.networks : [];
    const credParams = Array.isArray(node.credentials) ? node.credentials : [];

    // helper: decide if param is relevant to op raw id
    function includeForOp(param, opRaw) {
      if (!param) return false;
      const show = param.show && typeof param.show === 'object' ? param.show : null;
      const hide = param.hide && typeof param.hide === 'object' ? param.hide : null;
      if (opKey && show && Object.prototype.hasOwnProperty.call(show, `actions.${opKey}`)) {
        const allowed = show[`actions.${opKey}`];
        if (Array.isArray(allowed)) return allowed.map(String).includes(String(opRaw));
      }
      if (opKey && hide && Object.prototype.hasOwnProperty.call(hide, `actions.${opKey}`)) {
        const hidden = hide[`actions.${opKey}`];
        if (Array.isArray(hidden)) return !hidden.map(String).includes(String(opRaw));
      }
      return true;
    }

    // Determine "secondary" action params (excluding selector at index 0 if selector-shape)
    const isSelectorShape = Array.isArray(node.actions) && node.actions.length && node.actions[0] && node.actions[0].type && Array.isArray(node.actions[0].options);
    const secondaryActionParams = isSelectorShape ? actionParams.slice(1) : actionParams;

    for (const op of node.operations) {
      const opCall = node.methods.find(m => m.raw === op.raw || m.path === op.path)?.call ?? op.call;

      const fields = [];

      // Include secondary actions as "flat" top-level keys
      for (const p of secondaryActionParams) {
        if (!p?.name) continue;
        if (!includeForOp(p, op.raw)) continue;
        const optional = !!p.optional || p.required === false;
        fields.push({ name: p.name, optional, type: tsTypeForParam(p), desc: p.description ?? p.label });
      }

      for (const p of inputParams) {
        if (!p?.name) continue;
        if (!includeForOp(p, op.raw)) continue;
        const optional = !!p.optional || p.required === false;
        fields.push({ name: p.name, optional, type: tsTypeForParam(p), desc: p.description ?? p.label });
      }

      // networks
      for (const p of networkParams) {
        if (!p?.name) continue;
        // show/hide for networks may depend on other fields; keep optional
        const optional = true;
        fields.push({ name: p.name, optional, type: tsTypeForParam(p), desc: p.description ?? p.label });
      }

      // credentials
      for (const p of credParams) {
        if (!p?.name) continue;
        const optional = !(p.required === true) || !!p.optional;
        fields.push({ name: p.name, optional, type: tsTypeForParam(p), desc: p.description ?? p.label });
      }

      // De-dupe by name (shouldn't collide, but be safe)
      const byName = new Map();
      for (const f of fields) {
        const prev = byName.get(f.name);
        if (!prev) byName.set(f.name, f);
        else byName.set(f.name, {
          name: f.name,
          optional: prev.optional && f.optional,
          type: `${prev.type} | ${f.type}`,
          desc: prev.desc || f.desc,
        });
      }

      lines.push(`    export interface ${opCall}Params {`);
      for (const f of byName.values()) {
        // Keep comments short; avoid huge output
        const comment = f.desc ? ` /** ${String(f.desc).replace(/\s+/g, ' ').slice(0, 120)} */` : '';
        lines.push(`      ${comment}`);
        lines.push(`      ${JSON.stringify(f.name)}${f.optional ? '?:' : ':'} ${f.type};`);
      }
      lines.push(`    }`);
      lines.push('');
    }

    lines.push('  }');
  }
  lines.push('}');
  lines.push('');

  // SDK interface
  lines.push('export interface SDK {');
  for (const node of nodes) {
    lines.push(`  ${node.sdkName}: {`);
    for (const m of node.methods) {
      lines.push(`    ${m.call}(params?: Nodes.${node.sdkName}.${m.call}Params): Promise<any>;`);
    }
    lines.push('  };');
  }
  lines.push('}');
  lines.push('');

  lines.push('export function createSDK(nodesRegistryJson: any[], endpoint: string): SDK;');
  lines.push('export function useNodesRegistry(nodesRegistryJson: any[], endpoint: string, options?: { includeNonActionNodes?: boolean }): { registered: number; skipped: number; nodes: any[] };');
  lines.push('export function generateTypes(nodesRegistryJson: any[]): string;');
  lines.push('export function run(code: string, id?: string): Promise<{ id: string; status: \"paused\"; fetch: any } | { id: string; status: \"done\"; result: any } | { id: string; status: \"error\"; error: any }>;');
  lines.push('export function resume(id: string, data: any): Promise<{ id: string; status: \"paused\"; fetch: any } | { id: string; status: \"done\"; result: any } | { id: string; status: \"error\"; error: any }>;');
  lines.push('export const InMemoryStorage: { new(): InMemoryStorageLike };');

  return lines.join('\n');
}
