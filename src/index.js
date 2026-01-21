import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { SequentialFetchVM } = require('sequential-fetch');

class InMemoryStorage {
  constructor() { this.storage = new Map(); }
  async save(task) { this.storage.set(task.id, task); }
  async load(taskId) { return this.storage.get(taskId); }
  async delete(taskId) { this.storage.delete(taskId); }
}

// Normalize code for better DX
function normalize(code) {
  let c = code.trim();

  // Replace newlines with semicolons (but not inside strings/templates)
  let result = '';
  let inString = false;
  let stringChar = '';
  let inTemplate = false;

  for (let i = 0; i < c.length; i++) {
    const char = c[i];
    const prev = c[i - 1];

    if (!inString && !inTemplate && (char === '"' || char === "'")) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar && prev !== '\\') {
      inString = false;
    } else if (!inString && !inTemplate && char === '`') {
      inTemplate = true;
    } else if (inTemplate && char === '`' && prev !== '\\') {
      inTemplate = false;
    }

    if (!inString && !inTemplate && char === '\n') {
      const trimmed = result.trim();
      if (trimmed && !trimmed.endsWith(';') && !trimmed.endsWith('{') && !trimmed.endsWith(',')) {
        result += ';';
      }
    } else {
      result += char;
    }
  }

  // Handle return statement - convert to final expression
  if (result.includes('return ')) {
    const lastReturn = result.lastIndexOf('return ');
    if (lastReturn !== -1) {
      const beforeReturn = result.slice(0, lastReturn);
      let afterReturn = result.slice(lastReturn + 7).replace(/;*$/, '').trim();

      // Convert object shorthand { a, b } to array [a, b] for VM compatibility
      if (afterReturn.startsWith('{') && afterReturn.endsWith('}')) {
        const inner = afterReturn.slice(1, -1).trim();
        // Check if it's shorthand (no colons)
        if (!inner.includes(':')) {
          afterReturn = '[' + inner + ']';
        }
      }

      result = beforeReturn + afterReturn;
    }
  }

  return result;
}

export class SequentialFlow {
  static defaultStorage = new InMemoryStorage();

  static async execute(request, options = {}) {
    const { storage = this.defaultStorage, ttl = 2 * 60 * 60 * 1000 } = options;
    const code = typeof request === 'string' ? request : request.code;
    const taskId = (typeof request === 'object' ? request.id : options.id) || `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const name = typeof request === 'object' ? request.name : undefined;

    const normalizedCode = normalize(code);
    const vm = new SequentialFetchVM();

    try {
      await vm.initialize();
      const result = await vm.executeCode(normalizedCode);

      const task = {
        id: taskId,
        name: name || taskId,
        code: normalizedCode,
        status: result.type === 'pause' ? 'paused' : result.type === 'complete' ? 'completed' : 'error',
        result: result.result,
        error: result.error,
        vmState: result.state,
        pausedState: result.type === 'pause' ? {
          ...vm.paused,
          variables: [...vm.paused.variables.entries()]
        } : null,
        fetchRequest: result.fetchRequest,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttl).toISOString()
      };

      if (task.status === 'paused') await storage.save(task);
      return task;
    } catch (error) {
      return {
        id: taskId,
        name: name || taskId,
        code: normalizedCode,
        status: 'error',
        error: error.message,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttl).toISOString()
      };
    } finally {
      vm.dispose();
    }
  }

  static async resume(taskIdOrRequest, fetchResponse, options = {}) {
    const taskId = typeof taskIdOrRequest === 'string' ? taskIdOrRequest : taskIdOrRequest.taskId;
    const response = typeof taskIdOrRequest === 'string' ? fetchResponse : taskIdOrRequest.fetchResponse;
    const { storage = this.defaultStorage } = typeof taskIdOrRequest === 'string' ? options : (fetchResponse || {});

    const storedTask = await storage.load(taskId);
    if (!storedTask) throw new Error(`Task ${taskId} not found`);

    const vm = new SequentialFetchVM();

    try {
      await vm.initialize();

      if (storedTask.pausedState) {
        vm.paused = {
          ...storedTask.pausedState,
          variables: new Map(storedTask.pausedState.variables)
        };
        for (const [k, v] of vm.paused.variables) {
          vm.variables.set(k, v);
        }
      }

      const result = await vm.resumeExecution(storedTask.vmState, response?.data ?? response);

      const task = {
        id: taskId,
        name: storedTask.name,
        code: storedTask.code,
        status: result.type === 'pause' ? 'paused' : result.type === 'complete' ? 'completed' : 'error',
        result: result.result,
        error: result.error,
        vmState: result.state,
        pausedState: result.type === 'pause' ? {
          ...vm.paused,
          variables: [...vm.paused.variables.entries()]
        } : null,
        fetchRequest: result.fetchRequest,
        updatedAt: new Date().toISOString()
      };

      if (task.status === 'paused') await storage.save(task);
      else await storage.delete(taskId);

      return task;
    } catch (error) {
      await storage.delete(taskId);
      return { id: taskId, name: storedTask.name, code: storedTask.code, status: 'error', error: error.message };
    } finally {
      vm.dispose();
    }
  }

  static async get(taskId, options = {}) {
    return (options.storage ?? this.defaultStorage).load(taskId);
  }

  static async delete(taskId, options = {}) {
    await (options.storage ?? this.defaultStorage).delete(taskId);
  }
}

export { InMemoryStorage };

export function createFlow(storage) {
  return {
    run: (code, opts) => SequentialFlow.execute(code, { storage, ...opts }),
    resume: (id, response, opts) => SequentialFlow.resume(id, response, { storage, ...opts }),
    get: (id) => SequentialFlow.get(id, { storage }),
    delete: (id) => SequentialFlow.delete(id, { storage })
  };
}

export const flow = createFlow(SequentialFlow.defaultStorage);
