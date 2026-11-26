// What a panel or a report lists, as its source says it (medrec 0.9.10 and
// later; medrec-cli docs/data-contract.md, "Panels"; medrec's src/panels.rs).

import type { JsonObject, RecordEntry } from './model';
import { removed } from './numbers';
import { valueText } from './values';

/** What a list says of a heading in place of a value. */
export const HEADING = 'panel';

/** Whether a result is a heading: a panel that lists results, filed or not, and has no value of its own. Views say so on it. */
export function heads(r: RecordEntry): boolean {
  if (r.heading === true) return true;
  if (r.kind !== 'result' || (r.fields?.value !== undefined && valueText(r.fields.value) !== '')) return false;
  return Object.keys(r.lists ?? {}).length > 0 || (r.fields !== undefined && Object.hasOwn(r.fields, 'members'));
}

/** A record's fields without the ids of what is gone in what it lists. */
export function withoutMembers(fields: JsonObject, gone: ReadonlySet<string>): JsonObject {
  const ids = fields.members;
  if (!Array.isArray(ids)) return fields;
  const left = ids.filter((id) => typeof id !== 'string' || !gone.has(id));
  if (left.length === 0) return removed(fields, 'members');
  return left.length === ids.length ? fields : { ...fields, members: left };
}

/** One list of a panel or a report: the ids of the results of it that are there. */
interface List {
  /** The raw file that lists them. */
  path: string;
  ids: readonly string[];
  /** It lists them now; else it did. */
  now: boolean;
  /** It is one of the record's own raw files. */
  own: boolean;
}

/** Every list of each panel and report, by its id: what a source listed before still says what it is of. */
export function everyList(records: readonly RecordEntry[]): [id: string, lists: List[]][] {
  const panels = records.filter(
    (r) => (r.kind === 'result' || r.kind === 'report') && (r.lists !== undefined || r.fields?.members !== undefined || r.given?.some((g) => g.lists !== undefined)),
  );
  if (panels.length === 0) return [];
  const filed = new Map<string, RecordEntry>();
  for (const r of records) if (r.kind === 'result') for (const v of r.provenance ?? []) if (v.raw_path != null) filed.set(v.raw_path, r);
  return panels.flatMap((r): [string, List[]][] => {
    const lists = (of: Record<string, string[]> | undefined, now: boolean): List[] =>
      Object.entries(of ?? {}).map(([path, files]) => {
        const source = path.split('/').slice(0, -2).join('/');
        const found = files.flatMap((f) => filed.get(`${source}/${f}`) ?? []);
        return { path, ids: found.filter((x) => x !== r).map((x) => x.id), now, own: (r.provenance ?? []).some((v) => v.raw_path === path) };
      });
    const members = r.fields?.members;
    // An index that a medrec before 0.9.10 saved has those alone.
    const kept: List[] = Object.keys(r.lists ?? {}).length > 0 || !Array.isArray(members) ? [] : [{ path: '', ids: members.filter((id) => typeof id === 'string'), now: true, own: true }];
    const all = [...kept, ...lists(r.lists, true), ...(r.given ?? []).flatMap((g) => lists(g.lists, false))].filter((l) => l.ids.length > 0);
    return all.length > 0 ? [[r.id, all]] : [];
  });
}

/**
 * Whether a panel or a report lists none but what is `so`, of all its sources
 * together: each of its own raw files does, or lists nothing, now or before,
 * and one lists some. With what is entered in error, or without it.
 */
export function noneBut(lists: readonly List[], inError: ReadonlySet<string>, so: (id: string) => boolean): boolean {
  const own = lists.filter((l) => l.own);
  const such = (errors: boolean) => {
    const of = (l: List) => l.ids.filter((id) => errors || !inError.has(id));
    const is = (l: List) => of(l).every(so);
    const each = own.every((l) => {
      const its = own.filter((x) => x.path === l.path);
      // One before that names nothing says nothing.
      return its.some((x) => is(x) && (x.now || of(x).length > 0)) || !its.some((x) => x.now);
    });
    return each && own.some((l) => is(l) && of(l).length > 0);
  };
  return such(true) || such(false);
}
