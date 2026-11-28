// What is current among a person's conditions, allergies and medicines, by
// what each of their sources says of it (medrec 0.9.9 and later), from the
// person's standing.json. No source's word wins over another's. Without a
// current standing.json they are listed by each record's own status, as
// medrec 0.9.8 did. And what is said of any other record or paper whose
// sources differ on whether it is entered in error, from its `says`.
// medrec-cli docs/data-contract.md, "Standing" and "Readers"; medrec's
// src/standing.rs.

import { code, errorsOf, type Errors } from './errors';
import type { Json, JsonObject, RecordEntry } from './model';
import { isObject } from './numbers';

/** The kinds that have a standing. */
export const STANDING_KINDS: ReadonlySet<string> = new Set(['condition', 'allergy', 'medication']);

/** What one word, or all of a record's together, says of it. */
type Is = 'current' | 'on_hold' | 'draft' | 'ended' | 'refuted' | 'visit' | 'error';
const KNOWN: ReadonlySet<unknown> = new Set<Is>(['current', 'on_hold', 'draft', 'ended', 'refuted', 'visit', 'error']);

/** One source's word, `source` its place in `sources`. */
interface Word {
  source: number;
  read?: string;
  is: Is;
  status?: string;
  verification?: string;
  abatement?: string;
  end?: string;
  end_of?: string;
}

interface Fill {
  /** The fill's record: the pharmacy's, or a payer's claim (medrec 0.9.11 and later). */
  record: string;
  date: string;
  /** A payer's claim says so, and no record of the pharmacy's (medrec 0.9.11 and later). */
  from_claim?: true;
}

/** A fill's day, as a list says it. */
const filledOn = (f: Fill) => `${f.date}${f.from_claim ? ' (from a claim)' : ''}`;

/** What a record's words make of it, whatever the day: a medicine that is current is not one after `until`. */
export interface Standing {
  is: Is;
  line: string;
  until?: string;
  until_of?: string;
  differs: boolean;
  differs_after?: string;
  filled: readonly Fill[];
  words: readonly Word[];
  unheard: readonly number[];
}

/** One line of a list: a condition or an allergy of one code or name, or one medicine. */
export interface Line {
  /** Its records, newest first; the first gives its name. */
  records: string[];
  /** Its records of other sources that say otherwise. */
  against: string[];
  differs: boolean;
  /** The last fill the answer may show of one ended by its date. */
  filled?: Fill;
  unheard: readonly number[];
}

/** What is current of one kind, of the records an answer may show. */
export interface Lists {
  current: Line[];
  on_hold: Line[];
  ended_by_date: Line[];
  /** How many are entered in error, and not shown. */
  in_error: number;
  /** The sources that send no problem list, by their places. */
  without_problem_list: number[];
}

/** Where a record is for a reader on a day: `all`, in the list of all only. */
type At = 'current' | 'on_hold' | 'ended_by_date' | 'all' | 'error';

const at = (s: Standing, today: string): At => {
  if (s.is === 'current') return s.until !== undefined && s.until < today ? 'ended_by_date' : 'current';
  return s.is === 'on_hold' || s.is === 'error' ? s.is : 'all';
};

const differsOn = (s: Standing, today: string) => s.differs || (s.differs_after !== undefined && s.differs_after < today);

const isEnded = (w: Word) => w.is === 'ended' || w.is === 'refuted';

/** A word as a line says it, with the day it was read. */
function wordText(w: Word): string {
  const said = [w.status ?? 'no status'];
  if (w.verification !== undefined && code(w.verification) !== 'confirmed') said.push(w.verification);
  if (w.abatement !== undefined) said.push(`ended ${w.abatement}`);
  if (w.end !== undefined) said.push(`ends ${w.end}${w.end_of === undefined ? '' : ` (${w.end_of})`}`);
  return said.join(', ') + (w.read === undefined ? '' : ` (read ${w.read})`);
}

/** What each source says of an item that one says is entered in error: `says` of a record or a paper. */
export function saysOf(v: Json | undefined): string[] {
  return list(v)
    .filter(isObject)
    .map((w) => {
      if (w.household === true) return "the household's own file";
      const source = text(w.source) ?? 'a source with no name';
      return `${source}: ${w.unheard === true ? 'not heard' : wordText({ source: 0, is: 'current', read: text(w.read), status: text(w.status), verification: text(w.verification) })}`;
    });
}

/** What a list says of an item its sources differ on; nothing of any other. */
export function differ(v: Json | undefined): { standing?: string; says?: string } {
  const says = saysOf(v);
  return says.length > 0 ? { standing: 'sources differ', says: says.join('; ') } : {};
}

/** What is said of a paper opened by its id that a source says is entered in error, with what the household decided of it. */
export function paperNote(v: Json | undefined, entered: boolean, kept: { decisions: number; payments: number; corrections: number }): string | undefined {
  const says = saysOf(v).join('; ');
  if (!entered) return says === '' ? undefined : `Its sources differ (${says}).`;
  const of = (n: number, one: string, what: string) => (n === 0 ? [] : [`${n} ${one}${n === 1 ? '' : 's'} ${what}`]);
  const all = [...of(kept.decisions, 'decision', 'about its event'), ...of(kept.payments, 'payment', 'on it'), ...of(kept.corrections, 'correction', 'of a provider it names')];
  const note = `Entered in error (${says}): it is in no list, event, bill or total.`;
  return all.length === 0 ? note : `${note} Kept and not applied: ${all.join(', ')}.`;
}

const noProblemList = (source: string) => `No problem list from ${source}; diagnoses from visits are listed under All`;

/** A row of a list of conditions, allergies or medicines: `standing` and `says` are none of a fill. */
export interface Row<T> {
  record: T;
  standing?: string;
  says?: string;
  /** Current ones first, then those on hold, then those ended by their date. */
  group: number;
}

/** A person's standing.json, as a reader lists them. */
export class Standings {
  constructor(
    private readonly sources: readonly (string | null)[],
    private readonly order: ReadonlyMap<string, readonly string[]>,
    private readonly records: ReadonlyMap<string, Standing>,
    private readonly errors: Errors,
    private readonly noList: readonly { source: number; records: readonly string[] }[],
  ) {}

  /** A source's name, as a reader says it. */
  private name(source: number): string {
    return this.sources[source] ?? 'a source with no name';
  }

  /** What a record is on a day, as a reader says it of its line; none of a fill, which has no standing. */
  title(id: string, today: string, line: Line): string | undefined {
    const s = this.records.get(id);
    if (s === undefined) return undefined;
    let is: string;
    switch (at(s, today)) {
      case 'current':
        is = 'current';
        break;
      case 'on_hold':
        is = 'on hold';
        break;
      case 'error':
        is = 'entered in error';
        break;
      case 'ended_by_date':
        is = `ended by its date ${s.until}${s.until_of === undefined ? '' : ` (${s.until_of})`}${line.filled === undefined ? '' : `, filled ${filledOn(line.filled)}`}`;
        break;
      default:
        is = s.is === 'draft' || s.is === 'refuted' ? s.is : s.is === 'visit' ? 'diagnosis from a visit' : 'ended';
    }
    if (line.differs) is += ', sources differ';
    if (line.unheard.length > 0) is += ', not every source heard';
    return is;
  }

  /** What each source says on a line, with its name, each once, and those not heard; none when no one says anything. */
  says(line: Line): string | undefined {
    const out = new Set<string>();
    for (const id of [...line.records, ...line.against]) for (const w of this.records.get(id)?.words ?? []) out.add(`${this.name(w.source)}: ${wordText(w)}`);
    for (const n of line.unheard) out.add(`${this.name(n)}: not heard`);
    return out.size === 0 ? undefined : [...out].join('; ');
  }

  /** A record by itself. */
  private alone(id: string, s: Standing, mayShow: (id: string) => boolean, today: string): Line {
    return {
      records: [id],
      against: [],
      differs: differsOn(s, today),
      filled: at(s, today) === 'ended_by_date' ? s.filled.find((f) => mayShow(f.record)) : undefined,
      unheard: s.unheard,
    };
  }

  /** One line of the records of one code or name. */
  private merged(of: readonly (readonly [string, Standing])[], today: string): Line {
    const words = of.flatMap(([, s]) => s.words);
    const so = new Set(words.filter((w) => w.is === 'current').map((w) => w.source));
    // Sources that say it is not so, and nowhere that it is.
    const not = new Set(words.filter((w) => isEnded(w) && !so.has(w.source)).map((w) => w.source));
    const current = of.filter(([, s]) => at(s, today) === 'current');
    return {
      records: current.map(([id]) => id),
      against: of.filter(([, s]) => at(s, today) !== 'current' && s.words.some((w) => isEnded(w) && not.has(w.source))).map(([id]) => id),
      differs: (so.size > 0 && not.size > 0) || current.some(([, s]) => differsOn(s, today)),
      unheard: [...new Set(of.flatMap(([, s]) => s.unheard))],
    };
  }

  /** The lists of one kind, of the records an answer may show. */
  lists(kind: string, mayShow: (id: string) => boolean, today: string): Lists {
    const shown = (this.order.get(kind) ?? []).flatMap((id) => {
      const s = this.records.get(id);
      return s !== undefined && mayShow(id) ? [[id, s] as const] : [];
    });
    const lines = new Map<string, (readonly [string, Standing])[]>();
    if (kind !== 'medication') {
      for (const x of shown) {
        if (x[1].is === 'error') continue;
        const of = lines.get(x[1].line);
        if (of) of.push(x);
        else lines.set(x[1].line, [x]);
      }
    }
    const out: Lists = { current: [], on_hold: [], ended_by_date: [], in_error: 0, without_problem_list: [] };
    for (const [id, s] of shown) {
      const where = at(s, today);
      if (where === 'on_hold' || where === 'ended_by_date') out[where].push(this.alone(id, s, mayShow, today));
      else if (where === 'current' && kind === 'medication') out.current.push(this.alone(id, s, mayShow, today));
      else if (where === 'current') {
        // At the first of its line, and once.
        const of = lines.get(s.line);
        if (of) out.current.push(this.merged(of, today));
        lines.delete(s.line);
      }
    }
    for (const id of this.errors.get(kind) ?? []) if (mayShow(id)) out.in_error++;
    if (kind === 'condition') out.without_problem_list = this.noList.filter((n) => n.records.some(mayShow)).map((n) => n.source);
    return out;
  }

  /** What a list says of the sources that send no problem list. */
  notes(l: Lists): string[] {
    return l.without_problem_list.map((n) => noProblemList(this.name(n)));
  }

  /** One record of the list of all, with its own words. */
  row<T extends { id: string }>(record: T, mayShow: (id: string) => boolean, today: string, group = 0): Row<T> {
    const s = this.records.get(record.id);
    if (s === undefined) return { record, group };
    const line = this.alone(record.id, s, mayShow, today);
    return { record, standing: this.title(record.id, today, line), says: this.says(line), group };
  }

  /**
   * The rows of an `active` list of one kind, over all of the person's records
   * of it: one for each line of what is current, on hold or ended by its date,
   * the first of its records the question fits (`asked`). A record the answer
   * may not show (`shows`) has a row in the group it would be in alone, and one
   * entered in error has one with the current ones: both are there to be left
   * out and counted.
   */
  active<T extends RecordEntry>(
    of: readonly T[],
    kind: string,
    today: string,
    asked: (x: T) => boolean,
    shows: (x: T) => boolean,
    claimShows: (id: string) => boolean,
  ): { rows: Row<T>[]; notes: string[] } {
    const by = new Map(of.map((x) => [x.id, x]));
    // A fill of a medicine can be a claim, which is none of `of`: it shows where the answer may show its id.
    const mayShow = (id: string) => {
      const x = by.get(id);
      return x !== undefined ? shows(x) : claimShows(id);
    };
    const lists = this.lists(kind, mayShow, today);
    const rows: Row<T>[] = [];
    for (const [group, lines] of [lists.current, lists.on_hold, lists.ended_by_date].entries()) {
      for (const line of lines) {
        const x = line.records.map((id) => by.get(id)!).find(asked);
        if (x !== undefined) rows.push({ record: x, standing: this.title(x.id, today, line), says: this.says(line), group });
      }
    }
    const errors = this.errors.get(kind);
    const alone: readonly At[] = ['current', 'on_hold', 'ended_by_date'];
    for (const x of of) {
      if (!asked(x)) continue;
      const s = this.records.get(x.id);
      const group = shows(x) ? (errors?.has(x.id) ? 0 : -1) : s === undefined ? -1 : alone.indexOf(at(s, today));
      if (group >= 0) rows.push(this.row(x, mayShow, today, group));
    }
    return { rows, notes: this.notes(lists) };
  }
}

export const STANDING_SCHEMA = 'medrec-standing/v1';

/** standing.json as a reader needs it. */
export type StandingView = Partial<Record<'schema' | 'person' | 'sources' | 'order' | 'records' | 'in_error' | 'no_problem_list', Json>>;

const text = (v: Json | undefined) => (typeof v === 'string' ? v : undefined);
const list = (v: Json | undefined): readonly Json[] => (Array.isArray(v) ? v : []);
const entries = (v: Json | undefined) => (isObject(v) ? Object.entries(v) : []);
const numbers = (v: Json | undefined) => list(v).filter((x) => typeof x === 'number');
const texts = (v: Json | undefined) => list(v).filter((x) => typeof x === 'string');

/** A reader takes what it does not know as current, and shows the word. */
const isOf = (v: Json | undefined): Is => (KNOWN.has(v) ? (v as Is) : 'current');

function wordOf(v: JsonObject): Word {
  return {
    source: typeof v.source === 'number' ? v.source : -1,
    read: text(v.read),
    is: isOf(v.is),
    status: text(v.status),
    verification: text(v.verification),
    abatement: text(v.abatement),
    end: text(v.end),
    end_of: text(v.end_of),
  };
}

function standingOf(v: JsonObject): Standing {
  return {
    is: isOf(v.is),
    line: text(v.line) ?? '',
    until: text(v.until),
    until_of: text(v.until_of),
    differs: v.differs === true,
    differs_after: text(v.differs_after),
    filled: list(v.filled).flatMap((f) =>
      isObject(f) && typeof f.record === 'string' && typeof f.date === 'string' ? [{ record: f.record, date: f.date, ...(f.from_claim === true ? { from_claim: true as const } : {}) }] : [],
    ),
    words: list(v.words).filter(isObject).map(wordOf),
    unheard: numbers(v.unheard),
  };
}

/** A person's standings; null when the view is another person's. */
export function standingsOf(view: StandingView, person: string): Standings | null {
  if (view.person !== person) return null;
  return new Standings(
    list(view.sources).map((s) => text(s) ?? null),
    new Map(entries(view.order).map(([kind, ids]) => [kind, texts(ids)])),
    new Map(entries(view.records).flatMap(([id, r]) => (isObject(r) ? [[id, standingOf(r)] as const] : []))),
    errorsOf(view.in_error),
    list(view.no_problem_list).flatMap((n) => (isObject(n) && typeof n.source === 'number' ? [{ source: n.source, records: texts(n.records) }] : [])),
  );
}
