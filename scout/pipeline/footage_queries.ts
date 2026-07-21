// footage_queries.ts — tentukan daftar {obj, query} untuk build_footage.
// Primer: dossier.search_queries (dari topic_dossier). Fallback: footageObjects (objek+subjek main).
type Task = { obj: string; query: string };
type FootageObjects = { subjects: string[]; objects: string[]; people: string[] };

// composeQuery: objek + subjek utama (dipindah dari build_footage agar reusable & testable).
export function composeQuery(obj: string, subject: string): string {
  if (!subject) return obj;
  const o = (obj || '').toLowerCase();
  const hit = subject.toLowerCase().split(/\s+/).some((t) => t.length >= 3 && o.includes(t));
  return hit ? obj : `${obj} ${subject}`;
}

export async function resolveFootageTasks(
  set: any,
  footageObjectsFn: (input: { description: string; headline: string; comments: string }) => Promise<FootageObjects>,
  topComments: (set: any) => string = () => '',
): Promise<Task[]> {
  const q = set?.dossier?.search_queries;
  if (Array.isArray(q) && q.length) {
    // Query dossier LANGSUNG jadi obj+query (obj = query, dipakai sebagai gate token & field footage.query).
    return q.map((e: any) => String(e.q || '').trim()).filter(Boolean).map((query: string) => ({ obj: query, query }));
  }
  // Fallback: footageObjects lama.
  const main = set.main || {};
  const ex = await footageObjectsFn({ description: main.description || '', headline: main.title || '', comments: topComments(set) });
  const primarySubject = ex.subjects[0] || '';
  const tasks: Task[] = ex.objects.map((obj) => ({ obj, query: composeQuery(obj, primarySubject) }));
  if (ex.people[0] && ex.objects[0] && primarySubject)
    tasks.push({ obj: ex.objects[0], query: `${composeQuery(ex.objects[0], primarySubject)} ${ex.people[0]}` });
  return tasks;
}
