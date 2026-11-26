# Views: the records folder cut small for assistants

A records folder keeps each person's records in two files, `index.json` and
`text.json`, of a few megabytes each for an adult with years of records.
This connector runs on Cloudflare's Workers Free plan. That plan gives a
request 10 ms of CPU, and parsing 2.5 MB of JSON alone takes about 6 ms. So
medrec, from 0.8.0, also writes **views** beside those files: the same
records, cut into small files, each in the order a tool lists them. A call
parses only the few kilobytes its answer needs. For a folder no such medrec
prepares, `npm run views -- <folder>` writes them.

Each view is derived from `household.json` and a person's `index.json` and
`text.json`. `notes.md` has no view. It is small, and the app may change it,
so readers read it as it is.

The reference writer is `src/views/write.ts`. Its output for the demo folder,
the large synthetic folder and medrec's own folder for provider labels, with
the views only medrec makes as it wrote them for each (`events.json`,
`bills.json`, `private.json`, `code-names.json`, `providers.json` and
`standing.json`, in `test/fixtures`), and all of medrec's own views for its six
other folders (`words`, `errors`, `given`, `questionnaires`, `child` and
`parts`), answer all the recorded calls exactly as `medrec mcp` does
(`test/golden.test.ts`, "from the views"). Another writer (medrec's) is right
when its views pass the same calls:

```sh
VIEWS_WRITER='medrec views write --folder {folder}' npx vitest run test/golden.test.ts
```

The test copies each folder, runs the command with `{folder}` replaced by the
copy's path, and then answers every call from what it wrote. The command
above is an example; use whatever command your writer has.
`npm run views -- <folder>` writes the reference views into the folder
holding `household.json`, replacing views it wrote before. Views medrec wrote
are replaced only with `--force`.

## Where they are

```
views/views.json                          what was written, and from what
views/<person id>/summary.json
views/<person id>/records-<kind>-<n>.json
views/<person id>/records-<kind>-undated.json
views/<person id>/names-<kind>.json
views/<person id>/tests.json
views/<person id>/timeline-<n>.json
views/<person id>/timeline-undated.json
views/<person id>/documents.json
views/<person id>/text-<n>.bin
views/<person id>/search-<hex>.json
views/<person id>/search-1-<hex>.json
views/<person id>/search-items.bin
views/<person id>/search-hay-<n>.bin
views/<person id>/search-labs-<n>.json
views/<person id>/events.json             medrec 0.9.0 on; medrec's own, below
views/<person id>/bills.json              medrec 0.9.1 on; medrec's own, below
views/<person id>/private.json            medrec 0.9.1 on; medrec's own, below
views/<person id>/code-names.json         medrec 0.9.4 on; medrec's own, below
views/<person id>/providers.json          medrec 0.9.7 on; medrec's own, below
views/<person id>/standing.json           medrec 0.9.9 on; medrec's own, below
views/<person id>/search-parts.json       medrec 0.9.9 on; medrec's own, below
```

`views/` is at the top of the records folder, beside `household.json`. A
person's directory is named by their id in `household.json`, not their name.

These are the views' **names**. Each is **stored** under its name with the
first 12 hex digits of its MD5 before the extension:
`records-result-7.json` with MD5 `0a1b2c3d4e5f…` is stored as
`records-result-7.0a1b2c3d4e5f.json`. `views.json` alone keeps its plain
name. A reader finds a view's stored name from the MD5 that `views.json`
gives it (`files`, below). So a stored file's content never changes, and a
reader holding one `views.json` reads that pass's files or finds them gone.

JSON files are compact, UTF-8, without a byte-order mark. Binary integers are
little-endian unsigned 32-bit. Strings compare as UTF-8 bytes, as Rust's
`str` compares them. "Newest first" sorts by the date string, descending.
Undated items come last, since a missing date sorts before any string and
the order is reversed.

## When they are written, and when they are stale

Write the views whenever `index.json`, `text.json` or `household.json`
changes, in the same pass. Write `views/views.json` **last**. It records the
MD5 (hex) of each source file, exactly as stored, that the views were made
from, and of every view it describes:

```json
{"schema":"medrec-views/v2","medrec":"0.8.0","household":"<md5>",
 "people":{"p_…":{"index":"<md5>","text":"<md5>", …,
                  "files":{"summary.json":"<md5>","records-result-0.json":"<md5>", …}}}}
```

`index` or `text` is `null` when that file is absent. `files` names every
file in the person's directory, `views/<person id>/`, with its MD5.
From medrec 0.9.10, `build` is the commit medrec was built from, and medrec
makes again all views another build wrote, those of `npm run views` too. A reader
does not need it.

A reader compares these with the MD5s Drive reports (`md5Checksum`), all of
which one listing of the folder gives.
- **A person whose `index` or `text` MD5 differs has stale views.** The
  connector then reads that person's own files when they total 300,000 bytes
  or less. Otherwise it answers with an error that says the records changed
  after medrec last prepared them, and that the next pass will.
- **A different `household` MD5 makes every person's views stale.**
- **A view that is missing, or whose MD5 is not the one `files` gives,**
  belongs to a pass still arriving, or to one that replaced it. Uploaders
  send files in any order. When the new views arrive first, they sit beside
  the old ones under new names, and the old `views.json` still reads its
  own. When the new `views.json` arrives first, the views it names are not
  there yet. The connector then answers "being prepared right now, ask
  again in a minute". It never reads two passes together.
- **A person's stale views still give their row** in `medrec_summary`'s
  people list, as last prepared, so one pending refresh does not fail
  everyone's summary.

A pass writes only the stored names the folder lacks, and never changes a
stored file. A view that did not change keeps its name, so it is not
written again. Write `views.json` after the views it names. Then remove the
stored files it no longer names, including every view of a person who left
`household.json`. Remove only files with the stored-name shape, so nothing
else in `views/` is touched. A left person's directory may stay, empty: a
reader lists only the directories of the people `household.json` names.

### The schema

`schema` names the layout. A change that a reader of the current layout
would misread takes the next number (`medrec-views/v3`). A field that
readers may ignore does not. A reader that meets a later number than it
knows reads small people's files whole. For anyone larger, it says the
connector needs updating. Meeting an earlier number, it says the writer's
next pass prepares the current layout. A writer moves to a new number only
in a release whose notes name the connector version that reads it.

This is `medrec-views/v2`. `v1` was written only by the connector's own
`npm run views`, before medrec wrote views: plain names, and one
`search-hay.bin`. A writer that finds a `v1` `views.json` also removes the
files it names (the keys of each person's `files`).

## `views.json`, per person

| Field | What |
|---|---|
| `index`, `text` | the MD5s above |
| `row` | `documents`, `records`, `studies`, and `newest` and `last_import` when there are any: the person's line in `medrec_summary`'s people list, without `notes` |
| `records` | for each record kind, `{"shards": [[newest day, oldest day, count], …], "undated": count}`: its dated shards by number, and how many records its undated file holds |
| `timeline` | the timeline's shards, the same way |
| `search` | `items` (how many search items) and `labs` (how many `search-labs-<n>.json`) |
| `files` | every file in `views/<person id>/` with its MD5, above |

## Records: `records-<kind>-<n>.json`

`<kind>` is a record's `kind` (`result`, `medication`, …). Each shard is a
JSON array of that kind's records, in the records tool's concise order:
- date, newest first, by **day** (the first 10 characters);
- then by name (`display`, clipped to 200 characters with `…`), ascending;
- then as `index.json` holds them.

Every record keeps its `index.json` fields `id`, `kind`, `date`, `code`,
`display`, `status` and `fields` as they are, when present, each number in
them as that file writes it (`4.10`, not `4.1`). `provenance` is
cut to its first entry's `source`, keeping only `fhir_base`, `cli` and
`organization_id` (`null` when it has none), and from medrec 0.9.6 `label`:
what the record came through, as `medrec mcp` shows it, or `null`. A reader
shows the `label`. A result that is a heading has `heading: true` (medrec 0.9.10
and later): a panel that lists results and has no value of its own. It is listed
with `panel` for its `detail`, and is in no series of tests and no latest results.

Views written by medrec 0.9.5 and earlier have no `label`. A CLI, an
organization and a FHIR base do not name a source, and a view does not hold
the import runs that say which patient a record was read as. So this connector
takes the person's own sources (`sources` of `household.json`) with the
record's CLI, organization and FHIR base. The name they all have is the label.
Where they differ, or one has none, or there are none, it is the CLI.

medrec 0.9.3 and earlier leave `organization_id` out too. For such a record,
this connector takes the organization of the person's only sign-in with that
CLI and FHIR base. When the person has several there, it names only the CLI.

A small person's files are read whole, with the import runs: a record is then
of the source whose `patient_id` is that of the run that filed it
(`imported_at` is the record's `filed_at`), else of the run that read it
(`pulled_at` is its `fetched_at`). This is medrec 0.9.6's rule ("Which source"
in its data contract), and `npm run views` writes each `label` by it.

`summary.json`, `timeline-<n>.json` and the `place` in `events.json` hold the
name their writer gave, as they keep no `provenance`. Written by medrec 0.9.5
and earlier, that can be another source's. medrec 0.9.6 rewrites every
person's views on its first pass, and they are right from then on.

Shards are cut from the **oldest** end. `records-<kind>-0.json` holds the
oldest days. A shard closes once it holds 48,000 bytes or more, never inside
a day. The highest-numbered shard is the newest, and the only one still
filling. Inside a shard, records stay in the concise order, newest first. A
reader picks shards by their spans and reads them from the highest number
down.

New records are nearly always the newest, so a pass that adds a few touches
only the newest shard, or starts the next one. Backfilled history reshapes
more, which is rare.

Undated records go in `records-<kind>-undated.json`, in the same order,
outside the numbered run. They come after every dated record, and a date
range leaves them out.

## `names-<kind>.json`

Every distinct name the kind's records carry, as
`[code, display, code display, [shard numbers]]`. `code` and `code display`
are `code.code` and `code.display`, or `null`. Shard `-1` is the undated
file. A reader filtering by name opens only the shards a matching name is
in.

## `tests.json`

Each test series (records of kind `result` with one `seriesKey`: the code's
`system|code`, or else the folded name), in the order of its newest result.

```json
{"names":[[code, display, code display], …],
 "entries":[[date, name number, shard, place in shard, rank], …]}
```

`entries` lists every result of the series that is not entered in error (medrec
0.9.9 and later) and no heading (medrec 0.9.10 and later), newest first.
- `shard` and `place` locate the record in `records-result-<shard>.json`
  (`-1`: `records-result-undated.json`).
- `rank` is the result's place among all those results of the person, newest
  first, stable over `index.json`'s order.

## `timeline-<n>.json`

The person's documents, records and studies as timeline events. Each event is
`{date, kind, id, title, detail, source}`, keys absent when empty, without
`person`.

The order is newest first by full date, then:
- by title clipped to 200 characters,
- then kind,
- then the full title,
- then documents, records and studies in their `index.json` order.

Shards are cut as record shards are: from the oldest end, with undated
events in `timeline-undated.json`.

## `summary.json`

`medrec_summary`'s summary of the person without `person` and `as_of`:
`counts`, `sources`, `medications`, `conditions`, `allergies`,
`immunizations`, `latest_results`, `recent_visits` and `bills`. Each list is
`{items, more}`, at most 25 items. Readers recompute each bill's `past_due`
against the day they answer, so its value here does not matter. A result's
`value` there has its comparator (`<5`) when medrec 0.9.10 or later, or this
version's writer, made it from an index that has one. An earlier writer left it
out, though the records' shards keep it.

## `documents.json` and `text-<n>.bin`

`documents.json` is `index.json`'s `documents`, each without its `given` (what
a source gave and no item shows, which is in no view) and with these fields
added:
- `text_at`: where its text is, as `[pack, byte offset, byte length,
  characters]`. Absent when the document has no text.
- `linked`: the names (`display`) of the first 20 records that list it in
  their `documents`, in `index.json` order, but those entered in error (medrec
  0.9.9 and later). Absent when none do.
- `linked_ids`: the same records' ids, in the same order (medrec 0.9.9 and
  later). `medrec_document` without `person` is an answer about the whole
  household: unless the document is private it leaves out the names whose record
  the person's `private.json` holds back, and all of them when there are no ids
  and any record of theirs is private or may be. With `person`, whose document
  it is, it is an answer about them and has every name.

`text-<n>.bin` holds the documents' texts as UTF-8, one after another, in
document order. A pack closes before a text would take it past 1,000,000
bytes. A text is never split.

## Search

Search items are what `medrec_search` searches, notes aside:
- **Documents.** The text is the title, then the organization and the
  document type, then the document's text.
- **Records.** The name, then the record's fields flattened: every text and
  number, each with a space after it, but the ids of other items (medrec 0.9.9
  and later).
- **Studies.** The description, then the modalities, body part, facility and
  series.

These are the same strings medrec searches. `src/records/views.ts`
`searchables` spells them out.

**Item numbers** run in the reverse of medrec's order for hits of equal
score. medrec's order is: date, newest first by the full date string, undated
last, then documents, records and studies in their `index.json` order.
Reversed, undated items take the lowest numbers, then dated items follow from
the oldest. The highest number is the newest. Within one date, later
`index.json` entries get lower numbers.

Hits rank by score, then by item number, highest first. Every date range is
one run of numbers. A new item, nearly always the newest, takes a new number,
and only the shards of its own words change.

### `search-<hex>.json` and `search-1-<hex>.json`

Postings by word. Fold each item's text as medrec does (`fold`). Then for
each distinct word, record `[item, occurrences, byte offset of its first
occurrence in the item's text]`, flattened into one array per word, by item
number:

```json
{"cholesterol":[12,3,40,57,1,0, …],"cholera":[…]}
```

`<hex>` is the lowercase hex of the UTF-8 bytes of the word's first two
characters (Unicode scalar values), or of the whole word when it has only
one. `search-1-<hex>.json` holds the same postings keyed by the first
character only, for one-character terms like the "d" in "vitamin d". A
shard exists only for characters some word starts with: a reader that finds
no shard in `files` knows no word matches.

### `search-items.bin`

| Bytes | What |
|---|---|
| 4 | `n`, the number of items |
| 4 × (n + 1) | `text[i]`: item *i*'s text runs from `text[i]` to `text[i + 1]`, counted over every hay pack in order |
| 4 × (n + 1) | `meta[i]`: item *i*'s details run from `meta[i]` to `meta[i + 1]` in the region below |
| the rest | each item's details, `[date or null, kind, id, title]` as JSON, one after another |

A record's `date` and `title` are its `date` and `display` as `index.json` has
them, unclipped, the same as its entry's and name's in `tests.json`: a reader
matches the two on them.

### `search-hay-<n>.bin`

Every item's text, UTF-8, in item order, with no separators, in packs of 512
items. Pack *n* holds items 512 × *n* to 512 × *n* + 511, so item *i* is in
pack ⌊*i* / 512⌋, starting `text[i] − text[512 × n]` bytes into it. A count
rather than a size keeps a pass's rewrites small: a changed item rewrites
its own pack, and a new newest item only the last. A reader fetches only
the byte ranges its snippets need.

### `search-labs-<n>.json`

For the lab queries (`blood test`, `blood tests`, `bloodwork`, `blood work`,
`labs`, `lab work`, `lab test`, `lab tests`, `lab results`), medrec also finds
every lab record by its kind, with score 0.
These are results, reports, and claims with a lab line. Each row is
`[item, date, kind, id, title, snippet]`, where `snippet` is the record's
detail line. Rows are by item number, lowest first, 256 to a file. A reader
reads them from the last file back.

## `events.json` (medrec 0.9.0 and later)

What happened, one event per visit, ER trip, stay, test or fill: medrec
groups each person's claims, encounters, results and papers by its own
matching rules. Its layout, `medrec-events/v1`, is medrec's, in medrec's
`docs/data-contract.md`. The reference writer here does not write it.

It is stored and listed in `files` like every view. Each person's entry in
`views.json` also gives what else their events were made from, and only the
views medrec makes itself (`events.json`, `bills.json`, `private.json`,
`code-names.json`, `providers.json`) depend on these:

| Field | What |
|---|---|
| `overrides` | the MD5 of `<person folder>/overrides.json`, the household's "not the same visit" and "attach to this visit" decisions; `null` when there is none |
| `linked` | for each person whose records the newborn rules read (a newborn's guardians, a guardian's newborns), `{"index": <md5>, "text": <md5>}` of their files, each `null` when absent |

Both are present whenever `files` lists `events.json`: `overrides` as
`null` and `linked` as `{}` when there is nothing to name. A reader refuses
events listed without them. It serves a person's events only when their
views are current and both still match. A reader that does not read `events.json`
ignores them. Every person has an `events.json`, even with no events, so a
missing one means medrec has not prepared them.

## `bills.json` and `private.json` (medrec 0.9.1 and later)

Two more views only medrec makes, in its layouts `medrec-bills/v1` and
`medrec-private/v1` (medrec's `docs/data-contract.md`, "Bills" and
"Private"). The reference writer here does not write them.

- **`bills.json`**, by document id: what was paid against each bill and
  what is left, from receipts and the household's payments. A reader shows
  a `settled` bill as paid and never past due, leaves it out of the
  summary, and shows `left` when it differs from what the statement asked.
- **`private.json`**, by id within `records`, `documents`, `events` and, from
  medrec 0.9.5, `studies`: the person's private items, each with its `area`
  and why (`from`). `marks_unreadable` says medrec could not read the
  household's marks, so any of the person's records, documents, events and
  studies may be private. `labels_unreadable` (medrec 0.9.7 and later, with
  `marks_unreadable`) says the same of what the person's provider labels make
  private. From medrec 0.9.5, `unreported_studies` lists the
  imaging studies with no report to judge them by (absent when there are
  none). A reader holds those back from an answer about the whole household
  as it does private items, counts them in the same `private-left-out`
  count, and shows them in an answer about their person with no area. From
  medrec 0.9.9, `parts` has what of an open item is private (Private parts,
  below), `{}` when there is none. `clear_events` has the open events whose stay
  another's event may name ("An event's members, links and `could_join`",
  below), and is absent when there are none.

Both are made from the person's views, their `overrides.json`, the
`linked` people's records, and their `marks.json` (the household's payments
and private marks). `private.json` is made from their `provider-state.json`
too (medrec 0.9.7 and later). The person's entry in `views.json` gives these:

| Field | What |
|---|---|
| `marks` | the MD5 of `<person folder>/marks.json`; `null` when there is none |
| `provider_state` | the MD5 of `<person folder>/provider-state.json`, what a provider directory gave; absent when there is none |

A reader uses either only when the person's views are current and
`overrides`, `marks` and `linked` still match, and for `private.json` (and
`code-names.json` and `providers.json`, below) `provider_state` too. `events.json` does not depend
on `marks`, and neither it nor `bills.json` on `provider_state`. A
`provider-state.json` that is not the one named, one where none is named, and
one that is gone are each a difference. The file is medrec's own: a reader
compares its MD5, and never reads or serves it. medrec 0.9.6 and earlier leave
the file and make the views without it, so every computer that writes the
folder needs 0.9.7 or later once one has. A pass by 0.9.7 or later makes any
of these current again.

medrec writes both views for every person, even with nothing in them.

`summary.json` is made without the payments: its bills are cut to 25 before
a reader leaves the settled ones out. When it holds more than it lists and
any bill is settled, this connector makes the bills section again from
`documents.json`, by medrec's rule (the newest statement of each account
with an amount due).

## `code-names.json` (medrec 0.9.4 and later)

The published ICD-10-CM name of each diagnosis code the person's conditions
and claims use, in medrec's layout `medrec-code-names/v1` (medrec's
`docs/data-contract.md`, "Code names"). `codes` has the codes an item that is
not private uses, `private_codes` those only private items use. A key is
`icd10cm|` and the code in capitals, dotted after its third character; each
condition in `summary.json` carries its key as `name_key`. A person with no
named code has no file. The reference writer here does not write it, and
writes `name_key` in `summary.json`.

It depends on the same files as `private.json`, and a reader uses it only when
current by the same rule. A reader only labels with it: it looks a name up for
a condition it is already showing, and never lists, searches or serves the
file. It shows the source's own words too, and by those alone filters,
searches, sorts, pages, and decides whether a question names a private item.
An answer about the whole household uses `codes` only, and gives no name to a
private item or to one whose person's private items are not known. An answer
about one person uses `codes`, then `private_codes`. Missing, stale or
unreadable, it changes nothing else and gives no warning. This connector reads
it for `kind: "conditions"` and a person's summary, after the page is cut, for
the people with a coded condition on it.

## An event's members, links and `could_join`

An event in `events.json` is private with a private claim or portal visit, or
when all its own members are private. One that is not can still have a private
member, and any event can name another person's document (a member with
`person`) or event (a link with `person`). A reader judges each by its own
person's `private.json`:

| Named in an event | Answer about the whole household | Answer about the event's person |
|---|---|---|
| the person's own private member | left out, unless the event is private and the question names it | listed |
| another person's private document | left out | left out |
| a private event in `links` or `could_join` | left out | left out when it is another person's |

`private_members` (a number, absent when zero) counts the members left out, and
`members` stays, empty or not. `links` or `could_join` is absent when nothing is
left of it.

Items of someone whose private items are not known, or who is no longer in the
household, are left out the same way. In an answer about the event's person the
reader reads the other's `private.json` only to decide this: when it cannot, it
leaves theirs out, answers the rest, and names them in a warning
(`private-not-prepared`, `private-marks-unreadable` or
`private-labels-unreadable`).

An event whose `place_from` is `linked` has the place of another person's stay.
A reader shows it, in an answer about the event's person too, only when the
event has a `born_during` link, each of them is to an event in that person's
`clear_events`, and what is private of theirs is known. Otherwise the event has
no place: no name finds it by that, no provider label is of it, and nothing
takes its place.

## Private parts (medrec 0.9.9 and later)

A claim of several services, a bill, a receipt, an explanation of benefits or an
event can be open with a private part: a service, a diagnosis or a payer's note
in a claim, a line of a paper's text, and what such a claim or a private paper
says of an event. `private.json` has each in `parts`, by the item's id:

| Item | Its part |
|---|---|
| claim | `lines`, `diagnoses` and `payer_notes`: places from 0 in its `items`, `diagnoses` and `payer_notes`, each absent when there is none; `display`, the name it is shown by; `date`, its date; `category` when the lines that are left have another, `null` when none has |
| bill, receipt, explanation of benefits | `text`: `[offset, length]` of each private line, in bytes of its text |
| event | any of `kind`, `title`, `what`, `what_from`, `place`, `place_from`, `clinicians`, `money`, `differences` and `expected`, to take the event's own place, `null` for none |

`says` is how much is left out ("1 service not shown"); an event whose open
claims have no private line has none. An item with a part is not private, and is
counted in no `private-left-out`.

Only an answer that names no person leaves the parts out; one about the person
gives the items whole. Where it leaves them out, an item is listed, filtered by
name, sorted and paged by what is left of it:

- a list of claims, the timeline and events carry `says` as `not_shown`. A
  claim's `fields` lose the lines, diagnoses and notes, and a list with nothing
  left its key. An event calls a claim among its `members` by the claim's
  `display`.
- a paper's text has `(1 line not shown)`, or `(2 lines not shown)` for lines
  that follow one another on a page, in place of the lines, and its size and
  pages are those of what is given.
- a search hit carries `not_shown`, whatever its kind.

Claims of one day that are shown by one name are in the files' order. A shard has
those with one name of their own in it, and search items' numbers, which run the
other way, those of one date. Of two claims of one day, one with a time, that
neither says the order of, a reader gives the later by its full date first.

Places are those of the `index.json` and `text.json` the view was made from. A
list they are not places of is left out, and a text they are not places of is
empty.

A search answers from the postings, which hold the whole text, so it needs to
know what of it is left. `search-parts.json` says that, by search item number,
and is current when `private.json` is. A person with no part has `{}`:

```json
{"12": {"cuts": [[0, 41], [58, 9]], "words": {"form": [1, 6], "quick": [0]}, "lab": false}}
```

- `cuts` are the bytes of the item's text that are left out, in order. The text
  that is left is the rest, after the part's `display` and a line break when the
  first cut starts at 0.
- `words` are those that are there another number of times, or first at another
  place, than the postings say: `[times, offset of the first]`, or `[0]` for one
  that is gone. Any other word is there as often as the postings say, its first
  place moved by the cuts before it and by the `display`.
- `lab: false` is an item no lab query finds without its part.

An item whose whole text holds every term, or that a lab query finds, is a hit
when what is left does too, ranked and excerpted by that. Otherwise it is held
back as a private item is, and counted as one. An item with a part that
`search-parts.json` does not name, or of a person whose views have no such file,
is held back from every search that names no person.

`private.json` from an earlier medrec has neither key, as it judged no parts: its
open items are shown whole until a later medrec makes the views again, and no
place is taken from a linked stay.

## `providers.json` (medrec 0.9.7 and later)

Who the providers a person's items print are, in medrec's layout
`medrec-providers/v1` (medrec's `docs/data-contract.md`, "Provider labels"):
each label's name, practice, role and phone, with how sure medrec is
(`confidence`) and why (`evidence`). `labels`, `by_name`, `by_item`, `claims`
and `overrides` have what the person's open items say, and `private` the same
of what only private ones do. A person with no labelled provider may have no
file. The reference writer here does not write it.

It depends on the same files as `private.json`, and a reader uses it only when
current by the same rule. A reader only labels with it: it looks up, exactly
as printed and by the item first, what an item it is already showing prints,
and never lists, searches, sorts or filters by a label, or serves the file.
The label stands beside the source's own words. A likely one whose every
reason is left out (below) is left out too, a confidence the reader does not
know is likely, and a phone is shown only with where it is from.

A label that a first name told apart (`first_name`, medrec 0.9.8 and later)
says which printed text did, once for each text that shares the label. A reader
shows a text its own, and all of them for a text that has none. A claim on the
timeline has no fields, so this connector takes the one of the label's texts
that the claim's title ends with.

An answer about the whole household uses nothing of `private`. It gives no
label to a private item, even one it names, to one whose person's private items
are not known, or to anything an event prints when that event is such an item.
It leaves out a reason or a phone from such an item's paper, and one from what
the household said of private items only. An answer about one person looks a
private item up in `private` alone, and takes its label from `private.labels`,
then `labels`. `medrec_document` answers by the first rule without `person`, and
by the second with it.

Missing, stale or unreadable, it changes nothing else and gives no warning.
This connector reads at most 256,000 bytes of them for one answer, since the
CPU of more could cost the answer: people's files in the household's order, each
that has room. Its own `provider-labels-not-read` warning names everyone whose
file had none and who has an item with a printed provider on the page. It reads
them before the page is cut, for the people with a printed provider among the
items that fit the page without labels: claims, documents, bills and events, and
any record in detail. The labels count in the page's size. An item keeps the
first of its labels that fit a page beside it, and the
`provider-labels-left-out` warning counts the items that lost any.

## `standing.json` (medrec 0.9.9 and later)

What each of a person's sources says of their conditions, allergies and
medicines, and what that makes of each, in medrec's layout
`medrec-standing/v1` (medrec's `docs/data-contract.md`, "Standing"). No
source's word wins over another's. The reference writer here does not write it.

It is made from `household.json` and the person's `index.json` alone, so it is
current whenever the person's views are. Two other views come with it:

- **`views.json`** has `people.<id>.in_error`, the same object as
  `standing.json`'s: the ids of the person's records entered in error, by kind,
  and of their papers, as `document`; it is absent when there are none. A reader
  that leaves them out of an answer opens no other view for it.
- **`summary.json`** has `standing`: each medicine, condition and allergy that
  is current or on hold, uncut, for a reader to make the summary's lists of.
  `medications`, `conditions` and `allergies` beside it are by each record's
  own `status`, for a reader without `standing.json`.

This connector makes the lists by medrec's rules ("As a reader lists them"), on
the day it answers and of the records the answer may show: a private one it may
not show makes no line current and no line differ. It reads `standing.json` for
`kind: "conditions"`, `"allergies"` and `"medications"` and for a person's
summary. With `active`, it reads all of the person's records of the kind, since
a line's records may be of any date. Without a current `standing.json` it lists
by status, as views from 0.9.8 and earlier are, and says nothing of sources
that differ.

## What is entered in error (medrec 0.9.9 and later)

A record or paper is entered in error when every source of it says so. medrec's
views hold it, and make everything else without it: events, bills, totals,
labels, and the summary's other lists. A reader shows it in no list, the
timeline or the search, and counts it (an `entered-in-error` warning, or a
summary list's `note`). What the household decided of it is kept, and is not
applied while it is. These views say what they leave out, by id:

- **`events.json`**: `in_error` on an event (a list of the person's own items it
  would have) and `not_applied` (the decisions naming one), `events_in_error`
  (the events that are none without it), and the document's own `in_error` (an
  object, by item). An event says how many of its own there are, of those the
  answer may show. One in `events_in_error` is listed for nobody, and shown as
  `entered in error` when it is asked for by its id.
- **`bills.json`**: `in_error`, by document id, with what each is (`as`) and the
  payments kept on it. A bill is all the papers that are one statement, so one
  whose first paper is entered in error is its next copy's, and this connector
  lists as bills those in `bills`, counting those that are `bill` in `in_error`.
  Without a current `bills.json` it works that out from `documents.json`. A page
  that leaves out a bill with a payment the household marked says so.
- **`providers.json`**: `applied: false` on what the household said of one.
- **`documents.json` and the records' shards**: `says`, what each source says, on
  one that some source says is entered in error. One its sources differ on
  stays, and an answer shows it with `sources differ` and those words. A
  condition, allergy or medicine has its words in `standing.json` instead.

The reference writer here judges the same from `index.json` alone, by medrec's
rule (medrec's `docs/data-contract.md`, "Entered in error";
`src/records/errors.ts`). It writes `people.<id>.in_error` and leaves those out
of `tests.json`, the summary's lists and documents' `linked`. It writes no
`says`, and none of the views above that it does not write. This connector
judges so where it reads a person's `index.json` whole. Views from before medrec
0.9.9 name none: what they list, it lists, and counts none.

`medrec_document` of a paper entered in error says so first in its `hint`, with
how many decisions, payments and corrections are kept. For those alone it reads
`events.json`, `bills.json` and `providers.json`, and leaves out what it cannot
read. One its sources differ on says what each says.

## What is about another person (medrec 0.9.9 and later)

A person's chart can hold what is about somebody else: a screening a parent
answers of themselves, a result its source says is of another, or (medrec 0.9.10
and later) a panel or report that lists none but those. medrec's views
leave it out of everything, and `people.<id>.about_another` in `views.json` has
the ids, records and documents, in order; it is absent when there is none. A
reader says how many on the first page of that person's results, tests, timeline
or documents (an `about-another` warning), and nothing else of it.

The reference writer here does the same, by medrec's rule (medrec's
`docs/data-contract.md`, "About another person"; `src/records/about.ts`). So does
this connector where it reads a person's `index.json` whole, and it leaves out
the ids `views.json` names there too, though the person's files changed since.
Both leave those ids out of the `members` of a panel or report too. Views from
before medrec 0.9.9 leave out nothing.

## Without a current `private.json` or `bills.json`

A reader without a current `private.json` for a person (none yet, stale, or
in a layout it does not read) holds back all their records, documents, events
and studies from answers about the whole household, with a
`private-not-prepared` warning naming them, and includes them unmarked, with
the same warning, in answers about that person. A `private.json` without
`studies` (medrec 0.9.4 and earlier; the layout's name did not change, so
this is the sign) is handled the same way, as it names no private study and no
document for being linked by a private record. What it does mark stays marked
in answers about the person. An `unreported_studies` that is not a list of ids
counts as missing too. `marks_unreadable` comes before either: the person's
items are held back with the `private-marks-unreadable` warning, whichever
medrec wrote the file. With `labels_unreadable`, which medrec never writes
without it, the warning is `private-labels-unreadable` alone, as medrec's own
is. Without a current
`bills.json`, bills are shown by their statements with a
`bills-not-prepared` warning. medrec's own reader judges from the files, so
it gives neither warning.

A series of tests (`kind: "tests"`) is private when any of its results in
the answer's range is (medrec 0.9.3 and later, whose own reader does the
same), and takes the area of its latest result, else of its newest private
one. `tests.json` locates each result by shard and place, not id. This
connector finds a private result's entry by its date and name in
`search-items.bin`, and reads a shard only when two entries share both. A
private record that `search-items.bin` does not list, or a private result
that has no entry, cannot hold its series back: the person's tests then
answer as views still arriving do, leaving them out of an answer about
everyone with a `person-unavailable` warning. A heading, which `private.json`
says one is (`heading: true`, medrec 0.9.10 and later), has none to find. A
connector before medrec 0.9.10's does not read `heading`, and answers so for
every person with a private heading in views from medrec 0.9.10: update the two
together.

