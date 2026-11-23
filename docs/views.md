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

The reference writer is `src/views/write.ts`. Its output for the demo folder
and the large synthetic folder answers all 154 recorded calls exactly as
`medrec mcp` does (`test/golden.test.ts`, "from the views"). Another writer
(medrec's) is right when its views pass the same calls:

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
`display`, `status` and `fields` as they are, when present. `provenance` is
cut to its first entry's `source`, keeping only `fhir_base` and `cli`.

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

`entries` lists every result of the series, newest first.
- `shard` and `place` locate the record in `records-result-<shard>.json`
  (`-1`: `records-result-undated.json`).
- `rank` is the result's place among all the person's results, newest first,
  stable over `index.json`'s order.

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
against the day they answer, so its value here does not matter.

## `documents.json` and `text-<n>.bin`

`documents.json` is `index.json`'s `documents`, each with two fields added:
- `text_at`: where its text is, as `[pack, byte offset, byte length,
  characters]`. Absent when the document has no text.
- `linked`: the names (`display`) of the first 20 records that list it in
  their `documents`, in `index.json` order. Absent when none do.

`text-<n>.bin` holds the documents' texts as UTF-8, one after another, in
document order. A pack closes before a text would take it past 1,000,000
bytes. A text is never split.

## Search

Search items are what `medrec_search` searches, notes aside:
- **Documents.** The text is the title, then the organization and the
  document type, then the document's text.
- **Records.** The name, then the record's fields flattened.
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
