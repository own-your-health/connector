// What is entered in error (src/records/standing.ts, tools.ts): the parts that
// medrec's answers in test/golden do not reach, over medrec's own fixture and views.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ownFolder } from '../scripts/own-folder.mjs';
import type { Json } from '../src/records/model';
import { billsInError, differ, paperNote, papersStanding, saysOf } from '../src/records/standing';
import { callTool } from '../src/records/tools';
import { VIEWS_INDEX, personDir, storedName, type ViewsIndex } from '../src/views/format';
import { ViewsStore } from '../src/views/store';
import { folderAt } from './support';

describe('what is said of what is entered in error', () => {
  it('counts bills, and those the household marked a payment on', () => {
    expect([billsInError(1, 0), billsInError(2, 0), billsInError(1, 1), billsInError(2, 1), billsInError(2, 2), billsInError(3, 2)]).toEqual([
      '1 bill entered in error, not shown',
      '2 bills entered in error, not shown',
      '1 bill entered in error, with a payment you marked',
      '2 bills entered in error, 1 with a payment you marked',
      '2 bills entered in error, each with a payment you marked',
      '3 bills entered in error, 2 with a payment you marked',
    ]);
  });

  it('gives each word, whatever it lacks', () => {
    const says: Json = [
      { source: 'Example Health', read: '2024-07-02', status: 'current' },
      { source: 'Example Clinic', verification: 'entered-in-error' },
      { source: null, unheard: true },
      { source: 'Example Lab', status: 'final', verification: 'Confirmed' },
      { source: 'a file', unheard: true, household: true },
    ];
    expect(saysOf(says)).toEqual(['Example Health: current (read 2024-07-02)', 'Example Clinic: no status, entered-in-error', 'a source with no name: not heard', 'Example Lab: final', "the household's own file"]);
    expect(differ(says)).toEqual({ standing: 'sources differ', says: saysOf(says).join('; ') });
    for (const none of [undefined, null, [], 'x', {}]) expect(differ(none)).toEqual({});
  });

  it('says of a paper what is kept, and nothing of one no source says it of', () => {
    const says = [{ source: 'Example Health', status: 'entered-in-error' }];
    const nothing = { decisions: 0, payments: 0, corrections: 0 };
    const error = 'Entered in error (Example Health: entered-in-error): it is in no list, event, bill or total.';
    expect(paperNote(says, true, nothing)).toBe(error);
    expect(paperNote(says, true, { decisions: 1, payments: 2, corrections: 0 })).toBe(`${error} Kept and not applied: 1 decision about its event, 2 payments on it.`);
    expect(paperNote(says, true, { decisions: 2, payments: 1, corrections: 1 })).toBe(`${error} Kept and not applied: 2 decisions about its event, 1 payment on it, 1 correction of a provider it names.`);
    expect(paperNote(says, false, { decisions: 1, payments: 1, corrections: 1 })).toBe('Its sources differ (Example Health: entered-in-error).');
    expect(paperNote(undefined, false, nothing)).toBeUndefined();
  });

  it('makes a statement its next copy where its first is entered in error', () => {
    const papers = [{ id: 'a' }, { id: 'b', same_statement_as: 'a' }, { id: 'c', same_statement_as: 'a' }, { id: 'd', same_statement_as: null }, { id: 'e', same_statement_as: 'd' }];
    const of = (...errors: string[]) => papersStanding(papers, new Set(errors)).map((d) => [d.id, d.same_statement_as ?? null]);
    expect(of()).toEqual([['a', null], ['b', 'a'], ['c', 'a'], ['d', null], ['e', 'd']]);
    expect(of('a')).toEqual([['b', null], ['c', 'b'], ['d', null], ['e', 'd']]);
    expect(of('a', 'b', 'e')).toEqual([['c', null], ['d', null]]);
  });
});

describe("over medrec's views", () => {
  const PAPER = 'd_skinbillaaaaaaaaaaaa';
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-errors-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let n = 0;
  let root = '';
  beforeEach(() => {
    root = ownFolder('errors', join(scratch, String(n++)), { views: true });
  });
  const ask = async (name: string, args: Record<string, unknown>) => (await callTool(name, args, { store: new ViewsStore(folderAt(root)), today: '2026-11-25' }))!.structuredContent as Record<string, any>;
  /** A pass that has not uploaded one of the person's views yet. */
  const without = (view: string) => {
    const [pid, v] = Object.entries((JSON.parse(readFileSync(join(root, VIEWS_INDEX), 'utf8')) as ViewsIndex).people)[0]!;
    rmSync(join(root, personDir(pid) + storedName(view, v.files[view]!)));
  };
  const bills = async () => {
    const r = await ask('medrec_records', { kind: 'bills', person: 'Robin' });
    return { ids: r.items.map((i: { id: string }) => i.id), warnings: r.warnings.map((w: { code: string; message: string }) => (w.code === 'entered-in-error' ? w.message : w.code)) };
  };

  it('lists the bills that stand without a current bills.json, which payments were marked on not known', async () => {
    const now = await bills();
    expect(now).toEqual({ ids: ['d_eyebillaaaaaaaaaaaaa'], warnings: ['2 bills entered in error, 1 with a payment you marked'] });
    without('bills.json');
    expect(await bills()).toEqual({ ids: now.ids, warnings: ['2 bills entered in error, not shown', 'bills-not-prepared'] });
  });

  it('opens a paper entered in error with what it can read of what is kept', async () => {
    const error = 'Entered in error (Sample Clinic East: entered-in-error (read 2024-07-03)): it is in no list, event, bill or total.';
    const text = 'No text was extracted from this document: an image without OCR, or a file medrec cannot read.';
    expect((await ask('medrec_document', { id: PAPER })).hint).toBe(`${error} Kept and not applied: 1 payment on it. ${text}`);
    without('bills.json');
    expect((await ask('medrec_document', { id: PAPER })).hint).toBe(`${error} ${text}`);
    without('events.json');
    without('private.json');
    expect((await ask('medrec_document', { id: PAPER })).hint).toBe(`${error} ${text}`);
  });
});
