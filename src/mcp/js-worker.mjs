/** The persistent evaluator lives off the host thread. Only API calls cross the bridge. */
import { createEvaluator } from './js-evaluator.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';

const scope = new AsyncLocalStorage();
const pending = new Map();
const handles = new WeakMap();
let sequence = 0;
let active;
const evaluator = await createEvaluator();

function fatal(error) {
  parentPort.postMessage({ kind: 'fatal', error: errorData(error) });
  process.exit(1);
}
// Escaped async exceptions invalidate the worker, unlike ordinary cell failures.
process.on('uncaughtExceptionMonitor', fatal);
process.on('unhandledRejection', fatal);

function currentRun() {
  const run = scope.getStore();
  if (!run || run !== active) throw new Error('This js call has finished. Run and await API operations inside an active js call.');
  return run;
}

// Track dispatched RPCs without turning a handled rejection into a cell failure.
function track(run, operation) {
  const observation = { observed: false };
  run.tasks.add(operation.then(
    () => ({ ok: true, observation }),
    error => ({ ok: false, error, observation }),
  ));
  return {
    then(resolve, reject) { observation.observed = true; return operation.then(resolve, reject); },
    catch(reject) { observation.observed = true; return operation.catch(reject); },
    finally(callback) { observation.observed = true; return operation.finally(callback); },
  };
}

async function drain(run, outcome) {
  while (run.tasks.size) {
    const tasks = [...run.tasks];
    run.tasks.clear();
    const results = await Promise.all(tasks);
    const failed = results.find(result => !result.ok && !result.observation.observed);
    if (outcome.ok && failed) outcome = { ok: false, error: failed.error };
  }
  return outcome;
}
const errorData = e => ({ name: e?.name ?? 'Error', message: e?.message ?? String(e), stack: e?.stack, code: e?.code, hint: e?.hint ?? (e?.name === 'SyntaxError' && /Illegal return statement/.test(e.message)
  ? 'This cell runs at REPL top level. Replace `return value;` with `value;` or use `nodeRepl.write(value)`. `return` is valid inside functions.'
  : undefined), data: e?.data });

function encode(value, seen = new WeakSet()) {
  if (value && handles.has(value)) return handles.get(value);
  if (typeof value === 'function') return { $function: value.toString() };
  if (!value || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || types.isAnyArrayBuffer(value)) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  let result;
  if (types.isDate(value)) result = value.toISOString();
  else if (types.isMap(value)) result = [...value].map(entry => encode(entry, seen));
  else if (types.isSet(value)) result = [...value].map(entry => encode(entry, seen));
  else if (types.isNativeError(value)) result = encode(errorData(value), seen);
  else result = Array.isArray(value) ? value.map(v => encode(v, seen)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v, seen)]));
  seen.delete(value);
  return result;
}
function decode(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.$remote !== undefined) return remote(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  return Array.isArray(value) ? value.map(decode) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
}
function remote(descriptor, path = []) {
  const proxy = new Proxy(path.length || descriptor.callable ? function () {} : {}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      if (key === 'toJSON') return () => descriptor.summary ?? { type: 'API' };
      if (typeof key !== 'string') return undefined;
      if (!path.length && Object.hasOwn(descriptor.props ?? {}, key)) return descriptor.props[key];
      return remote(descriptor, [...path, key]);
    },
    apply(_target, _this, args) {
      const run = currentRun();
      const id = ++sequence;
      return track(run, new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { parentPort.postMessage({ kind: 'call', run: run.id, id, target: descriptor.$remote, path, args: encode(args) }); }
        catch (error) { pending.delete(id); reject(error); }
      }));
    },
  });
  handles.set(proxy, { $remote: descriptor.$remote, path });
  return proxy;
}
const emit = (kind, value) => parentPort.postMessage({ kind, run: currentRun().id, value: encode(value) });
evaluator.context.nodeRepl = {
  write: value => emit('write', value),
  emitImage: async value => emit('image', value),
};
evaluator.context.console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, (...values) => emit('log', { level, values })]));
Object.assign(evaluator.context, decode(workerData.globals));
parentPort.on('message', message => {
  if (message.kind === 'reply') {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error));
    else request.resolve(decode(message.value));
    return;
  }
  if (message.kind !== 'run') return;
  const run = { id: message.run, tasks: new Set() };
  active = run;
  void scope.run(run, async () => {
    let evaluated = await evaluator.evaluate(message.code, run.id);
    if (evaluated.ok) {
      try { evaluated.value = await evaluated.value; }
      catch (error) { evaluated = { ok: false, error }; }
    }
    parentPort.postMessage({ kind: 'draining', run: run.id });
    const outcome = await drain(run, evaluated);
    try {
      parentPort.postMessage({ kind: 'done', run: run.id, ...(outcome.ok
        ? { ok: true, value: encode(outcome.value) }
        : { ok: false, error: errorData(outcome.error) }) });
    } catch (error) {
      parentPort.postMessage({ kind: 'done', run: run.id, ok: false, error: errorData(error) });
    } finally { active = undefined; }
  }).catch(fatal);
});
