// A person's vaccine schedule as medrec_records `kind: "schedule"` lists it
// (medrec 0.9.12 and later, its data contract's "Schedule"): one item per
// vaccine group of the person's schedule.json, in its order, then the doses on
// file in no group. medrec makes the document from CDC's CDSi supporting data
// on the machine that writes the views; this connector only reads it. It says
// nothing of what is due, and pairs no dose on file with one of the schedule.

import type { JsonObject } from './model';

export const SCHEDULE_SCHEMA = 'medrec-schedule/v1';

/** The first medrec that writes a schedule.json. */
export const SCHEDULE_SINCE = '0.9.12';

/**
 * Why a person has no schedule.json to read: medrec of SCHEDULE_SINCE or later
 * wrote the views on a machine that keeps no schedule table (`tables`), or no
 * such medrec wrote them (`medrec`): there are none, this connector's own
 * script wrote them, or an earlier medrec did.
 */
export interface NoSchedule {
  none: 'tables' | 'medrec';
}

/** `no-schedule` where medrec kept no schedule table: medrec's own words. */
export const NO_TABLES = "no schedule is kept on this machine: `medrec tables fetch cdsi` keeps CDC's";

/** `no-schedule` where no medrec that writes one prepared the views, so the tables alone would not give one. */
export const NO_MEDREC = `no vaccine schedule is among what medrec prepared for assistants: medrec ${SCHEDULE_SINCE} or later prepares one on the household's computer, once \`medrec tables fetch cdsi\` keeps CDC's tables there`;

export interface ScheduleSource {
  id?: string;
  version?: string;
  date?: string;
}

export interface ScheduleDose {
  dose?: number;
  age?: string | null;
  date?: string | null;
  after?: number;
  recurring?: boolean;
  season?: { from?: string; to?: string };
  before_records?: boolean;
  sources?: ScheduleSource[];
}

export interface OnFile {
  id?: string;
  date?: string | null;
  cvx?: number[];
  display?: string;
  from_claim?: boolean;
  why?: string;
}

export interface ScheduleGroup {
  group?: string;
  antigens?: string[];
  lines?: { series?: string[]; doses?: ScheduleDose[] }[];
  on_file?: OnFile[];
}

/** schedule.json as a reader needs it. */
export interface ScheduleView {
  schema?: string;
  person?: string;
  birth_date?: string | null;
  groups?: ScheduleGroup[];
  not_placed?: OnFile[];
  marks_unreadable?: boolean;
}

/** One group, or the doses on file in none: its heading, its lines joined by "; ", and the ids of the records on file it prints, each once. */
export interface ScheduleRow {
  title: string;
  detail: string;
  members: string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** "Mar 15, 2000", from the year, month and day at a date's places, in bytes; anything else as it is. */
export function usDay(iso: string): string {
  const b = encoder.encode(iso);
  // A place inside a letter cuts nothing, as medrec's `str::get` does not.
  const cut = (from: number, to: number) => (b.length >= to && [from, to].every((i) => i === b.length || (b[i]! & 0xc0) !== 0x80) ? decoder.decode(b.subarray(from, to)) : undefined);
  const [y, m, d] = [cut(0, 4), cut(5, 7), cut(8, 10)];
  if (y === undefined || m === undefined || d === undefined) return iso;
  const number = (s: string) => (/^\+?[0-9]+$/.test(s) ? Number(s) : NaN);
  const month = number(m);
  const day = number(d);
  return month >= 1 && month <= 12 && Number.isInteger(day) && day <= 0xffffffff ? `${MONTHS[month - 1]} ${day}, ${y}` : iso;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
/** A JSON value as medrec prints one in its text: a number as it is, anything else as JSON. */
const shown = (v: unknown): string => (v === undefined ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v)));
/** A whole number of none but digits, as serde reads `as_u64`. */
const whole = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

/** The words of one table beside a dose: "CDC CDSi 4.66, Oct 9, 2026". */
function saidBy(s: ScheduleSource): string {
  const id = str(s.id) ?? '';
  const name = id === 'cdsi' ? 'CDC CDSi' : id;
  const date = str(s.date) === undefined ? '' : usDay(s.date!);
  return `${name} ${str(s.version) ?? ''}, ${date}`;
}

const sourcesSaid = (d: ScheduleDose): string => list<ScheduleSource>(d.sources).map(saidBy).join('; ');

/** A group's heading: "MMR (Measles, Mumps, Rubella)". */
function heading(g: ScheduleGroup): string {
  const antigens = list<unknown>(g.antigens).filter((a): a is string => typeof a === 'string');
  const group = str(g.group) ?? '';
  if (antigens.length === 0 || (antigens.length === 1 && antigens[0] === group)) return group;
  return `${group} (${antigens.join(', ')})`;
}

/** The words of a dose that comes again, or in a season. */
function repeats(d: ScheduleDose): string {
  let s = '';
  if (d.recurring === true) s += ', then again';
  const season = d.season;
  if (season !== null && typeof season === 'object' && !Array.isArray(season)) {
    const day = (k: 'from' | 'to') => (str(season[k]) === undefined ? '' : usDay(season[k]!));
    s += `, in the season ${day('from')} to ${day('to')}`;
  }
  return s;
}

function onFileSaid(f: OnFile): string {
  const day = str(f.date) === undefined ? 'no date' : usDay(f.date!);
  const codes = list<unknown>(f.cvx).map((c) => `CVX ${shown(c)}`);
  let s = `${day}, ${str(f.display) ?? ''}`;
  if (codes.length > 0) s += ` (${codes.join(', ')})`;
  if (f.from_claim === true) s += ', from a claim';
  return s;
}

/** A group's lines: of each of its series, the doses before the person's records begin folded into one, then each other dose with its table; then the doses on file. A group of more than one series names each. */
function groupLines(g: ScheduleGroup): string[] {
  const out: string[] = [];
  const lines = list<{ series?: unknown; doses?: unknown }>(g.lines);
  for (const l of lines) {
    const label = lines.length > 1 ? `${list<unknown>(l?.series).filter((n): n is string => typeof n === 'string').join('; ')}: ` : '';
    const doses = list<ScheduleDose>(l?.doses);
    const before = doses.filter((d) => d?.before_records === true);
    if (before.length > 0) {
      const ages = before.map((d) => {
        const age = str(d.age);
        const after = whole(d.after);
        const at = age !== undefined ? `dose ${shown(d.dose)} at ${age}` : after !== undefined ? `dose ${shown(d.dose)} after dose ${after}` : `dose ${shown(d.dose)}`;
        return `${at}${repeats(d)}`;
      });
      out.push(`${label}Before these records begin: ${ages.join(', ')} (${sourcesSaid(before[0]!)})`);
    }
    for (const d of doses.filter((d) => d?.before_records !== true)) {
      let s = `${label}Dose ${shown(d?.dose)}: `;
      const age = str(d?.age);
      const day = str(d?.date);
      const after = whole(d?.after);
      if (age !== undefined && day !== undefined) s += `recommended at ${age}: ${usDay(day)}`;
      else if (after !== undefined) s += `after dose ${after}, at no age of its own`;
      else s += 'at no age of its own';
      s += repeats(d ?? {});
      s += ` (${sourcesSaid(d ?? {})})`;
      out.push(s);
    }
  }
  for (const f of list<OnFile>(g.on_file)) out.push(`On file: ${onFileSaid(f ?? {})}`);
  return out;
}

/** The ids of the records on file a list prints, each once. */
function ids(files: unknown): string[] {
  const out: string[] = [];
  for (const f of list<JsonObject>(files)) {
    const id = str(f?.id);
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Each group of the schedule as a row, in its order (by the date of its first dose), then the doses on file in no group. */
export function scheduleRows(v: ScheduleView): ScheduleRow[] {
  const out: ScheduleRow[] = list<ScheduleGroup>(v.groups).map((g) => ({ title: heading(g ?? {}), detail: groupLines(g ?? {}).join('; '), members: ids(g?.on_file) }));
  const notPlaced = list<OnFile>(v.not_placed).map((f) => `${onFileSaid(f ?? {})} (${str(f?.why) ?? ''})`);
  if (notPlaced.length > 0) out.push({ title: 'On file, in no group', detail: notPlaced.join('; '), members: ids(v.not_placed) });
  return out;
}
