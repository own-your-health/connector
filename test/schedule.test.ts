// A person's vaccine schedule (medrec 0.9.12, its data contract's "Schedule";
// src/records/schedule.ts): medrec writes schedule.json on a machine that
// keeps CDC's tables, and this connector lists it as medrec_records `kind:
// "schedule"` does. test/golden.test.ts holds every answer over medrec's own
// views of test/fixtures/schedule to medrec's; these are the rows' words by the
// contract's own example, and what the connector says where there is no
// current schedule.json.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownFolder } from '../scripts/own-folder.mjs';
import { ParsedCache } from '../src/records/folder';
import { scheduleRows, usDay, type ScheduleView } from '../src/records/schedule';
import { printable } from '../src/records/text';
import { RawStore, type Store } from '../src/records/store';
import { callTool } from '../src/records/tools';
import { VIEWS_INDEX, personDir, storedName } from '../src/views/format';
import { writeViewsAt } from '../src/views/local';
import { ViewsStore } from '../src/views/store';
import { folderAt } from './support';

const PID = 'p_robinaaaaaaaaaaaaaaa';

/** The example of the contract's "Schedule". */
const EXAMPLE: ScheduleView = {
  schema: 'medrec-schedule/v1',
  person: 'p_…',
  birth_date: '2020-02-02',
  groups: [
    {
      group: 'Examplitis',
      antigens: ['Examplitis'],
      lines: [
        {
          series: ['Examplitis 4-dose series'],
          doses: [{ dose: 1, age: '2 months', date: '2020-04-02', before_records: false, sources: [{ id: 'cdsi', version: '4.66', date: '2026-10-09' }] }],
        },
      ],
      on_file: [{ id: 'r_…', date: '2020-04-05', cvx: [951], display: 'Sample vaccine', from_claim: true }],
    },
  ],
  not_placed: [{ id: 'r_…', date: '2020-04-05', cvx: [], display: '…', why: 'no CVX code' }],
};

const CDSI = [{ id: 'cdsi', version: '4.66', date: '2026-10-09' }];

describe("a schedule's rows", () => {
  it("are each group's heading and lines, then the doses on file in no group, as the contract's example gives them", () => {
    expect(scheduleRows(EXAMPLE)).toEqual([
      {
        title: 'Examplitis',
        detail: 'Dose 1: recommended at 2 months: Apr 2, 2020 (CDC CDSi 4.66, Oct 9, 2026); On file: Apr 5, 2020, Sample vaccine (CVX 951), from a claim',
        members: ['r_…'],
      },
      { title: 'On file, in no group', detail: 'Apr 5, 2020, … (no CVX code)', members: ['r_…'] },
    ]);
  });

  it('fold the doses before the records begin into one line, and name each series of a group of several', () => {
    const v: ScheduleView = {
      groups: [
        {
          group: 'Samplepox',
          antigens: ['Samplepox A', 'Samplepox B'],
          lines: [
            {
              series: ['Samplepox A series'],
              doses: [
                { dose: 1, age: '2 months', date: '2020-04-02', before_records: true, sources: CDSI },
                { dose: 2, age: null, date: null, after: 1, before_records: true, sources: CDSI },
                { dose: 3, age: '12 months - 4 days', date: '2021-01-29', before_records: false, sources: CDSI },
              ],
            },
            {
              series: ['Samplepox B series', 'Samplepox B other series'],
              doses: [
                { dose: 1, age: '11 years', date: '2031-02-02', before_records: false, recurring: true, sources: CDSI },
                { dose: 2, age: null, date: null, after: 1, before_records: false, season: { from: '2027-08-01', to: '2028-06-30' }, sources: [...CDSI, { id: 'other', version: '1', date: '2026-01-02' }] },
                { dose: 3, age: null, date: null, before_records: false, sources: CDSI },
              ],
            },
          ],
          on_file: [
            { id: 'r_a', date: null, cvx: [952, 953], display: 'Sample vaccine' },
            { id: 'r_a', date: '2024-10-01', cvx: [952], display: 'Sample vaccine' },
          ],
        },
      ],
    };
    const [row] = scheduleRows(v);
    expect(row!.title).toBe('Samplepox (Samplepox A, Samplepox B)');
    expect(row!.detail.split('; Samplepox B series; ')[0]!.split('; ')).toEqual([
      'Samplepox A series: Before these records begin: dose 1 at 2 months, dose 2 after dose 1 (CDC CDSi 4.66, Oct 9, 2026)',
      'Samplepox A series: Dose 3: recommended at 12 months - 4 days: Jan 29, 2021 (CDC CDSi 4.66, Oct 9, 2026)',
    ]);
    expect(row!.detail).toContain('Samplepox B series; Samplepox B other series: Dose 1: recommended at 11 years: Feb 2, 2031, then again (CDC CDSi 4.66, Oct 9, 2026)');
    expect(row!.detail).toContain(
      'Samplepox B series; Samplepox B other series: Dose 2: after dose 1, at no age of its own, in the season Aug 1, 2027 to Jun 30, 2028 (CDC CDSi 4.66, Oct 9, 2026; other 1, Jan 2, 2026)',
    );
    expect(row!.detail).toContain('Samplepox B series; Samplepox B other series: Dose 3: at no age of its own (CDC CDSi 4.66, Oct 9, 2026)');
    expect(row!.detail.endsWith('; On file: no date, Sample vaccine (CVX 952, CVX 953); On file: Oct 1, 2024, Sample vaccine (CVX 952)')).toBe(true);
    // A record on file twice is one member.
    expect(row!.members).toEqual(['r_a']);
  });

  it('are none, and no row of doses on file, where the views list none', () => {
    expect(scheduleRows({ birth_date: '2020-02-02', groups: [], not_placed: [] })).toEqual([]);
    expect(scheduleRows({ birth_date: null })).toEqual([]);
  });

  it('write a day as medrec does, and anything that is no day as it is', () => {
    expect(usDay('2020-04-02')).toBe('Apr 2, 2020');
    expect(usDay('2020-12-31T10:00:00Z')).toBe('Dec 31, 2020');
    for (const odd of ['2020-13-01', '2020-00-10', '2020-04', 'soon', '2020-xx-02']) expect(usDay(odd)).toBe(odd);
  });
});

describe("a person's name in a warning", () => {
  it("is without what can steer a terminal or hide text, as medrec's `printable` cases have it", () => {
    for (const [input, shown] of [
      ['Outside Records are not available', 'Outside Records are not available'],
      ['a\u{1b}[2Jb\u{1b}]0;title\u{7}c', 'a[2Jb]0;titlec'],
      ['line\nbreak\r\ttab', 'linebreaktab'],
      ['abc\u{202E}fed\u{2066}x\u{2069}', 'abcfedx'],
      ['zero\u{200B}width\u{FEFF}\u{2028}', 'zerowidth'],
      ['tag\u{E0041}', 'tag'],
      ['Cl\u{00ED}nica S\u{00E3}o Paulo', 'Cl\u{00ED}nica S\u{00E3}o Paulo'],
      ['soft\u00ADhyphen\u0600\u061C\u06DD\u070F\u180E\u2060\u2064\uFFF9\uFFFB\u0085', 'softhyphen'],
      ['', ''],
    ]) expect(printable(input!), JSON.stringify(input)).toBe(shown);
  });
});

describe('kind schedule', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oyh-schedule-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let n = 0;
  const ask = async (store: Store, args: Record<string, unknown> = { kind: 'schedule', person: 'Robin' }) => (await callTool('medrec_records', args, { store, today: '2026-11-28' }))!;
  const views = (root: string) => new ViewsStore(folderAt(root, new ParsedCache()));
  /** medrec's views of test/fixtures/schedule, with `edit` made to them; views.json follows a file that changed. */
  const medrecs = (edit: (dir: string, index: Record<string, any>) => void = () => {}) => {
    const root = ownFolder('schedule', join(scratch, String(n++)), { views: true });
    const at = join(root, VIEWS_INDEX);
    const index = JSON.parse(readFileSync(at, 'utf8'));
    edit(join(root, personDir(PID)), index);
    writeFileSync(at, JSON.stringify(index));
    return root;
  };
  const scheduleFile = (dir: string) => readdirSync(dir).find((f) => f.startsWith('schedule.'))!;

  it("lists medrec's schedule.json, one item per group in its order, with no date", async () => {
    const r = await ask(views(medrecs()));
    const s = r.structuredContent as { items: Record<string, unknown>[]; warnings?: unknown };
    expect(r.isError).toBeFalsy();
    expect(s.items.map((i) => i.title)).toEqual(['Examplitis', 'Samplepox (Samplepox A, Samplepox B, Samplepox C)', 'On file, in no group']);
    expect(s.items.every((i) => i.kind === 'schedule' && i.date === undefined && typeof i.detail === 'string')).toBe(true);
    expect(s.items.map((i) => i.id)).toEqual([0, 1, 2].map((k) => `schedule:${PID}:${k}`));
    expect(s.warnings).toBeUndefined();
  });

  it('says no schedule is kept where the views have none, from the files, and from views this connector wrote', async () => {
    const files = ownFolder('schedule', join(scratch, 'files'));
    const own = ownFolder('schedule', join(scratch, 'own'));
    writeViewsAt(own);
    const none = medrecs((dir, index) => {
      rmSync(join(dir, scheduleFile(dir)));
      delete index.people[PID].files['schedule.json'];
      delete index.people[PID].schedule_tables;
    });
    const stores = [new RawStore(folderAt(files, new ParsedCache())), views(own), views(none)];
    for (const store of stores) {
      const s = (await ask(store)).structuredContent as { items: unknown[]; warnings: { code: string; message: string }[] };
      expect(s.items).toEqual([]);
      // Before what is said of what is private, which the files and these views do not say.
      expect(s.warnings[0]).toEqual({ code: 'no-schedule', message: "no schedule is kept on this machine: `medrec tables fetch cdsi` keeps CDC's" });
      expect(s.warnings.slice(1).map((w) => w.code)).toEqual(store === stores[2] ? [] : ['private-not-prepared']);
    }
  });

  it('says a person has no birth date where the schedule has none, and lists the doses on file alone', async () => {
    const root = medrecs((dir, index) => {
      const name = scheduleFile(dir);
      const v = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const doses = v.groups.flatMap((g: { on_file: unknown[] }) => g.on_file);
      const bytes = JSON.stringify({ ...v, birth_date: null, groups: [], not_placed: [...doses, ...v.not_placed].map((f) => ({ ...f, why: 'no birth date on file' })) });
      const md5 = createHash('md5').update(bytes).digest('hex');
      rmSync(join(dir, name));
      writeFileSync(join(dir, storedName('schedule.json', md5)), bytes);
      index.people[PID].files['schedule.json'] = md5;
    });
    const s = (await ask(views(root))).structuredContent as { items: Record<string, unknown>[]; warnings: { code: string; message: string }[] };
    expect(s.items.map((i) => i.title)).toEqual(['On file, in no group']);
    expect(s.warnings).toEqual([{ code: 'no-birth-date', message: 'Robin Example has no birth date on file, so no schedule: `medrec people edit <PERSON> --birth-date YYYY-MM-DD` gives one' }]);
  });

  it('refuses a schedule the records changed after, one still arriving, and one in a layout it does not read', async () => {
    const changed = medrecs();
    writeFileSync(join(changed, 'Robin Example/marks.json'), '{"schema":"medrec-marks/v1"}');
    const arriving = medrecs((dir, index) => (index.people[PID].files['schedule.json'] = '0'.repeat(32)));
    const other = medrecs((dir, index) => {
      const name = scheduleFile(dir);
      const bytes = JSON.stringify({ ...JSON.parse(readFileSync(join(dir, name), 'utf8')), schema: 'medrec-schedule/v2' });
      const md5 = createHash('md5').update(bytes).digest('hex');
      writeFileSync(join(dir, storedName('schedule.json', md5)), bytes);
      index.people[PID].files['schedule.json'] = md5;
    });
    for (const [root, said] of [
      [changed, /Robin Example's records changed after medrec last prepared their vaccine schedule for assistants/],
      [arriving, /Robin Example's records are being prepared for assistants right now/],
      [other, /medrec prepared Robin Example's vaccine schedule in a layout \(medrec-schedule\/v2\) this connector does not read.*needs updating/],
    ] as const) {
      const r = await ask(views(root));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(said);
    }
  });

  it('takes one person, and neither active, since nor until', async () => {
    const store = views(medrecs());
    for (const args of [{ kind: 'schedule' }, { kind: 'schedule', person: 'Robin', active: true }, { kind: 'schedule', person: 'Robin', since: '2021-01-01' }, { kind: 'schedule', person: 'Robin', until: '2021-01-01' }]) {
      const r = await ask(store, args);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/^usage: kind `schedule` takes a person, and not active, since or until\. /);
    }
  });

  it('is in no view the connector writes', () => {
    const own = ownFolder('schedule', join(scratch, 'written'));
    writeViewsAt(own);
    const index = JSON.parse(readFileSync(join(own, VIEWS_INDEX), 'utf8'));
    expect(index.people[PID].files['schedule.json']).toBeUndefined();
    expect(index.people[PID].schedule_tables).toBeUndefined();
  });
});
