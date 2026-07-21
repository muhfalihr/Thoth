import assert from 'node:assert';
import { resolveFootageTasks } from './footage_queries.ts';

// 1) Ada dossier.search_queries → dipakai; footageObjects TIDAK dipanggil.
let calledFallback = false;
const withDossier = {
  main: { title: 'T', description: 'D' },
  comments: [],
  dossier: { search_queries: [{ q: 'chip ai nvidia', for: 'entity:nvidia' }, { q: 'jensen huang', for: 'angle:1' }] },
};
const t1 = await resolveFootageTasks(withDossier, async () => { calledFallback = true; return { subjects: [], objects: [], people: [] }; });
assert.equal(calledFallback, false);
assert.deepEqual(t1.map((x) => x.query), ['chip ai nvidia', 'jensen huang']);
assert.deepEqual(t1.map((x) => x.obj), ['chip ai nvidia', 'jensen huang']);

// 2) Tak ada dossier → fallback footageObjects (objek + subjek utama).
const noDossier = { main: { title: 'T', description: 'D' }, comments: [] };
const t2 = await resolveFootageTasks(noDossier, async () => ({ subjects: ['nvidia'], objects: ['chip ai'], people: [] }));
assert.equal(t2.length >= 1, true);
assert.equal(t2[0].query.includes('chip ai'), true);

console.log('ok footage_queries');
