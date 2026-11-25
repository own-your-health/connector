// Private items (medrec 0.9.1 and later): records, documents, events and, from
// medrec 0.9.5, imaging studies (private when their report is) about
// mental health, reproductive or sexual health or substance use, from each
// person's private.json. It is discretion, not access control. An answer about
// the whole household leaves them out unless the question names the item, and
// says per page how many it left out. An answer about one person includes them.
// Each one an answer includes carries `private`, its area. medrec-cli
// docs/data-contract.md, "Private" and "Readers"; medrec's src/private.rs
// `names` and src/mcp.rs `PrivateItems`.

import type { Warning } from './partial';
import type { Person } from './model';
import { fold } from './text';

/**
 * What a reader knows of one person's private items. `areas` gives each
 * private item's area by id. `unjudged` names the imaging studies no report
 * judges, held back without an area. `unknown` says why any of their items may be
 * private beyond those: medrec could not read their marks.json
 * (`marks-unreadable`) or their provider-state.json (`labels-unreadable`,
 * medrec 0.9.7), or this connector has no current private.json for
 * them (`not-prepared`, with why, and the medrec that makes it when a later
 * one than usual is needed). Either way their items are held back from
 * answers about the whole household.
 */
export interface Privacy {
  areas: ReadonlyMap<string, string>;
  unjudged?: ReadonlySet<string>;
  unknown?: { why: 'marks-unreadable' | 'labels-unreadable' } | { why: 'not-prepared'; detail: string; needs?: string };
}

export const NO_PRIVATE: Privacy = { areas: new Map() };

/** medrec's: words that name no item on their own, as forms, units, kinds of record and visit, and the words between them. */
const GENERIC = new Set([
  'tablet', 'tablets', 'capsule', 'capsules', 'oral', 'solution', 'suspension', 'injection', 'cream', 'patch',
  'extended', 'release', 'delayed', 'chewable', 'hcl', 'mg', 'mcg', 'ml', 'unit', 'units', 'dose', 'visit',
  'office', 'encounter', 'appointment', 'telehealth', 'video', 'follow', 'hospital', 'clinic', 'test', 'tests',
  'result', 'results', 'lab', 'labs', 'panel', 'screen', 'screening', 'report', 'note', 'notes', 'letter', 'bill',
  'statement', 'summary', 'record', 'records', 'document', 'total', 'serum', 'blood', 'urine', 'level', 'disorder',
  'unspecified', 'other', 'episode', 'single', 'recurrent', 'moderate', 'mild', 'severe', 'major', 'minor',
  'history', 'chronic', 'acute', 'with', 'without', 'type', 'the', 'and', 'for', 'from',
]);

/** The ids private.json can name: records, documents, events and studies. */
const HELD = /^[rdem]_/;

const words = (s: string) => fold(s).split(/[^\p{Alphabetic}\p{N}]+/u).filter((w) => w !== '');

/**
 * Whether a question names an item: every word of it starts a word of the
 * item's title, and one of those title words is its own (not a form, unit or
 * kind of record), so "tablets" names no medicine and "escitalopram" does.
 */
export function names(title: string, query: string): boolean {
  const asked = new Set(words(query));
  const inTitle = new Set(words(title));
  const starts = (w: string) => [...inTitle].filter((t) => t.startsWith(w));
  if (asked.size === 0) return false;
  for (const w of asked) if (starts(w).length === 0) return false;
  for (const w of asked) {
    if ([...w].length >= 3 && starts(w).some((t) => !GENERIC.has(t) && /\p{Alphabetic}/u.test(t))) return true;
  }
  return false;
}

/**
 * The private items of the people an answer covers, as it is built in the
 * tool's order. `keep` decides each item: one held back from an answer about
 * the whole household that does not name it is counted and left out. The
 * count a page reports is the held-back items after the previous page's last
 * item, up to its own last item; the last page counts to the end.
 */
export class Gate {
  private held = 0;
  /** For each item kept, how many were held back before it. */
  private readonly before: number[] = [];

  constructor(
    /** Whether the answer is about the whole household. */
    private readonly household: boolean,
    private readonly people: ReadonlyMap<string, Privacy>,
  ) {}

  /** The item's area when it is private; a test series' is its latest result's, else the first of its other results' (`members`, newest first). */
  area(p: Person, id: string, members: readonly string[] = []): string | undefined {
    const areas = this.people.get(p.id)?.areas;
    if (!areas) return undefined;
    return areas.get(id) ?? members.map((m) => areas.get(m)).find((a) => a !== undefined);
  }

  /** The person's private records' ids, for a test series to find among its results. */
  records(p: Person): ReadonlySet<string> {
    return new Set([...(this.people.get(p.id)?.areas.keys() ?? [])].filter((id) => id.startsWith('r_')));
  }

  /**
   * Whether the item is one an answer about the whole household holds back:
   * a private one, a study no report judges, or any record, document, event
   * or study of a person whose private items are not known (notes are never
   * private).
   */
  heldBack(p: Person, id: string): boolean {
    const v = this.people.get(p.id);
    if (v === undefined) return false;
    return v.areas.has(id) || (v.unjudged?.has(id) ?? false) || (v.unknown !== undefined && HELD.test(id));
  }

  /**
   * Whether the item stays in the answer: `named` says whether the question
   * names it. A test series is held back when any of its results is
   * (`members`), and counted once.
   */
  keep(p: Person, id: string, named: () => boolean, members: readonly string[] = []): boolean {
    if (this.household && (this.heldBack(p, id) || members.some((m) => this.heldBack(p, m))) && !named()) {
      this.held++;
      return false;
    }
    this.before.push(this.held);
    return true;
  }

  /** Counts an item held back that the answer never asked `keep` about: search's, skipped where it ranks. */
  skipped(): void {
    this.held++;
  }

  /** Records a kept item that `keep` did not see: search's, at its rank. */
  kept(): void {
    this.before.push(this.held);
  }

  /**
   * How many items the page of kept items from `offset`, `returned` long, left
   * out: those after the previous page's last item, up to its own last item,
   * or to the end of what was read when `last`. A page past the kept items (a
   * cursor from before the list shrank) follows the true last page, which
   * counted the rest (medrec's views::LeftOut::on_page).
   */
  leftOut(offset: number, returned: number, last: boolean): number {
    if (offset > 0 && offset >= this.before.length) return 0;
    // Held back before the kept item `i`; past the kept items read, every one held back so far.
    const below = (i: number) => (i >= 0 && i < this.before.length ? this.before[i]! : this.held);
    const from = offset > 0 ? this.before[offset - 1]! : 0;
    const to = last ? this.held : below(offset + returned - 1);
    return to - from;
  }

  /**
   * The page's warnings, medrec's first: how many it left out, and for each of
   * the people whose marks.json or provider-state.json does not read, or who
   * have no current private.json here, that their items are held back.
   */
  warnings(people: Person[], leftOut: number): Warning[] {
    const out: Warning[] = [];
    if (leftOut > 0) {
      out.push({
        code: 'private-left-out',
        message: `${leftOut} private item${leftOut === 1 ? '' : 's'} left out of this page of a household-wide answer: ask about one person, or name the item, to include ${leftOut === 1 ? 'it' : 'them'}`,
      });
    }
    for (const p of people) {
      const why = this.people.get(p.id)?.unknown?.why;
      if (why === 'marks-unreadable') {
        out.push({
          code: 'private-marks-unreadable',
          message: `${p.name}'s marks.json does not read, so the household's private marks are not applied: ${p.name}'s items are left out of household-wide answers until it is fixed`,
        });
      } else if (why === 'labels-unreadable') {
        out.push({
          code: 'private-labels-unreadable',
          message: `${p.name}'s provider-state.json does not read, so which items provider labels make private is not known: ${p.name}'s items are left out of household-wide answers until medrec tables fetch nppes, then medrec views write, run on one machine (a newer medrec's file needs this one updated)`,
        });
      }
    }
    for (const p of people) {
      const u = this.people.get(p.id)?.unknown;
      if (u?.why !== 'not-prepared') continue;
      out.push({
        code: 'private-not-prepared',
        message: `medrec has not marked ${p.name}'s private items for assistants (${u.detail}): ${p.name}'s items are left out of household-wide answers until it does, and may not all be marked in answers about ${p.name}. Tell the user medrec ${u.needs ?? '0.9.5'} or later marks them on its next pass on the household's computer (medrec refresh)${u.needs ? `, and every computer that writes the folder needs medrec ${u.needs} or later` : ''}`,
      });
    }
    return out;
  }

  /**
   * The people held back for want of a current private.json, for a cursor to
   * bind: a later page asked once they have one would not line up. Those whose
   * marks.json or provider-state.json does not read are medrec's own case, and
   * its cursors do not say.
   */
  notPreparedIds(people: Person[]): string[] {
    return people.filter((p) => this.people.get(p.id)?.unknown?.why === 'not-prepared').map((p) => `private:${p.id}`);
  }
}
