import assert from 'node:assert';
import { parseDossier } from './dossier_parse.ts';

// 1) JSON valid dengan noise di sekitar → terparse + ter-normalisasi.
const raw = `bla bla ${JSON.stringify({
  topic: '  Kasus X  ',
  entities: [{ term: ' Nvidia ', kind: 'ORG', summary: 'bikin chip' }, { term: '', summary: 'buang' }],
  relations: ['A kaitan B', '  '],
  angles: ['sudut 1', ''],
  search_queries: [{ q: ' chip ai ', for: 'entity:nvidia' }, { q: '' }],
  timeline: ['t1'],
  extra_field: 'diabaikan',
})} tail`;
const d = parseDossier(raw)!;
assert.equal(d.topic, 'Kasus X');
assert.equal(d.entities.length, 1);
assert.equal(d.entities[0].term, 'Nvidia');
assert.equal(d.entities[0].kind, 'org'); // di-lowercase
assert.deepEqual(d.relations, ['A kaitan B']);
assert.deepEqual(d.angles, ['sudut 1']);
assert.equal(d.search_queries.length, 1);
assert.equal(d.search_queries[0].q, 'chip ai');

// 2) Tak ada JSON → null (caller fallback).
assert.equal(parseDossier('maaf saya tidak bisa'), null);

// 3) JSON tanpa field dossier → objek kosong-aman (bukan throw).
const empty = parseDossier('{"topic":"t"}')!;
assert.deepEqual(empty.entities, []);
assert.deepEqual(empty.search_queries, []);

console.log('ok dossier_parse');
