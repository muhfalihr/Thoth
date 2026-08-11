// json_walk.ts — generic, dependency-free JSON traversal helper.
//
// Version-tolerant network response parsers (Instagram GraphQL today; other
// platforms' captured payloads in later tasks) need to find "the object that
// looks like X" somewhere inside an arbitrarily-shaped, arbitrarily-deep
// response body without knowing the exact path ahead of time — the wrapper
// keys around the payload shift between API versions. This module has zero
// platform knowledge: callers supply the predicate.
//
// Iterative (no recursion — a deep/wide response must not blow the call
// stack) and cycle-safe (a WeakSet, not a depth counter, guards re-entry —
// some captured payloads legitimately nest the same object by reference).
// `maxNodes` bounds total work so a pathological/adversarial response can't
// cause unbounded traversal.

export function findFirstObject<T = Record<string, unknown>>(
  root: unknown,
  predicate: (node: Record<string, unknown>) => boolean,
  maxNodes = 20_000,
): T | null {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  let visited = 0;

  while (stack.length > 0 && visited < maxNodes) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    visited += 1;

    if (Array.isArray(node)) {
      // Push in reverse so pop() (LIFO) still visits index 0 first — keeps
      // traversal order matching insertion order, so a maxNodes budget cuts
      // off the "far" nodes rather than whichever was declared last.
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
      continue;
    }

    const record = node as Record<string, unknown>;
    if (predicate(record)) return record as T;
    const keys = Object.keys(record);
    for (let i = keys.length - 1; i >= 0; i -= 1) stack.push(record[keys[i]]);
  }

  return null;
}
