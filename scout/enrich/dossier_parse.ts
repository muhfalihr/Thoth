// dossier_parse.ts — parse + normalisasi output LLM Topic Dossier. Murni (tanpa I/O) → testable.
export type DossierEntity = { term: string; kind: string; summary: string };
export type DossierQuery = { q: string; for: string };
export type Dossier = {
  topic: string;
  entities: DossierEntity[];
  relations: string[];
  angles: string[];
  search_queries: DossierQuery[];
  timeline: string[];
};

const s = (v: unknown) => String(v ?? '').trim();
const strList = (v: unknown, cap: number) =>
  (Array.isArray(v) ? v : []).map(s).filter(Boolean).slice(0, cap);

export function parseDossier(raw: string): Dossier | null {
  const m = (raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: any;
  try { o = JSON.parse(m[0]); } catch { return null; }
  return {
    topic: s(o.topic),
    entities: (Array.isArray(o.entities) ? o.entities : [])
      .map((e: any) => ({ term: s(e.term), kind: s(e.kind).toLowerCase(), summary: s(e.summary) }))
      .filter((e: DossierEntity) => e.term && e.summary)
      .slice(0, 12),
    relations: strList(o.relations, 12),
    angles: strList(o.angles, 6),
    search_queries: (Array.isArray(o.search_queries) ? o.search_queries : [])
      .map((q: any) => ({ q: s(q.q), for: s(q.for) }))
      .filter((q: DossierQuery) => q.q)
      .slice(0, 16),
    timeline: strList(o.timeline, 12),
  };
}
