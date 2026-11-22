// 設定 › 許可した送信 (the withdrawal place named in every declared operation's
// disclosure.withdrawal), ported from Kumade (src/allowed-sending.js, AWAI-3819) to the trusted host.
// The canonical broker still asks for consent on each operation; this only narrows what the host
// makes eligible. A withdrawn service is left out of approvedOperations when the host creates the
// broker, so the guest's invoke is refused before any dialog and nothing is sent. It never grants
// anything the broker would not. The state is kept in the host page's own storage, because the
// sandboxed guest has none (until the runtime's host-mediated storage, KOTOBA-968).

export const WITHDRAWAL_TEXT = 'この送信の許可は、設定 › 許可した送信 から、いつでも取り消せます。取り消す前に送ったものには影響しません。';
export const STORAGE_KEY = 'itonami.market-android.allowed-sending.v1';
const SCHEMA = 'itonami.market-android.allowed-sending.v1';

const clean = (state) => (state?.schema === SCHEMA && state.services && typeof state.services === 'object' && !Array.isArray(state.services) ? state.services : {});

/** storage: { load(): object|null, save(object): void } (synchronous; a failing storage keeps the state in memory). */
export function createAllowedSending(storage, { now = () => new Date().toISOString() } = {}) {
  let services = {};
  try { services = { ...clean(storage.load()) }; } catch { services = {}; }
  const listeners = new Set();
  const persist = () => {
    try { storage.save({ schema: SCHEMA, services }); } catch { /* kept in memory for this page */ }
    for (const listener of listeners) listener();
  };
  const isWithdrawn = (service) => services[service]?.status === 'withdrawn';
  return Object.freeze({
    isWithdrawn,
    withdraw(service) {
      if (isWithdrawn(service)) return;
      services = { ...services, [service]: { status: 'withdrawn', withdrawnAt: now() } };
      persist();
    },
    /** Undo a withdrawal; the next send still asks for consent in the canonical dialog. */
    restore(service) {
      if (!isWithdrawn(service)) return;
      const { [service]: _gone, ...rest } = services;
      services = rest;
      persist();
    },
    /** The declared operations the host may make eligible. */
    eligible(operations) { return operations.filter((op) => !isWithdrawn(op.service)); },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
}

export function browserStorage(key = STORAGE_KEY) {
  return {
    load() { const raw = globalThis.localStorage.getItem(key); return raw === null ? null : JSON.parse(raw); },
    save(value) { globalThis.localStorage.setItem(key, JSON.stringify(value)); },
  };
}

export function memoryStorage(initial = null) {
  let value = initial;
  return { load: () => value, save: (next) => { value = structuredClone(next); }, peek: () => value };
}
