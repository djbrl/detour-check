// In-memory stand-in for @forge/kvs: get, set (with FAIL_IF_EXISTS), delete and prefix queries.
export const store = new Map();
export const WhereConditions = { beginsWith: (prefix) => ({ prefix }) };
export const kvs = {
  get: async (k) => structuredClone(store.get(k)),
  set: async (k, v, opts = {}) => {
    if (opts.keyPolicy === 'FAIL_IF_EXISTS' && store.has(k)) throw new Error('Key already exists');
    store.set(k, structuredClone(v));
  },
  delete: async (k) => { store.delete(k); },
  query: () => {
    const q = { prefix: '', n: 100, from: 0 };
    const chain = {
      where: (_, c) => { q.prefix = c.prefix; return chain; },
      limit: (n) => { q.n = n; return chain; },
      cursor: (c) => { q.from = Number(c); return chain; },
      getMany: async () => {
        const all = [...store.entries()].filter(([k]) => k.startsWith(q.prefix)).sort(([a], [b]) => a.localeCompare(b));
        const page = all.slice(q.from, q.from + q.n);
        return { results: page.map(([key, value]) => ({ key, value: structuredClone(value) })), nextCursor: q.from + q.n < all.length ? String(q.from + q.n) : undefined };
      },
    };
    return chain;
  },
};
