# Views: the records folder cut small for assistants

A records folder keeps each person's records in two files, `index.json` and
`text.json`, of a few megabytes each for an adult with years of records.
This connector runs on Cloudflare's Workers Free plan. That plan gives a
request 10 ms of CPU, and parsing 2.5 MB of JSON alone takes about 6 ms. So
medrec also writes **views** beside those files: the same records, cut into
small files, each in the order a tool lists them. A call parses only the few
kilobytes its answer needs.

Each view is derived from `household.json` and a person's `index.json` and
`text.json`. `notes.md` has no view. It is small, and the app may change it,
so readers read it as it is.

The reference writer is `src/views/write.ts`. Its output for the demo folder
and the large synthetic folder answers all 154 recorded calls exactly as
`medrec mcp` does (`test/golden.test.ts`, "from the views"). Another writer
(medrec's own) is right when its views pass the same calls:

```sh
VIEWS_WRITER='medrec views write --folder {folder}' npx vitest run test/golden.test.ts
```

The test copies each folder, runs the command with `{folder}` replaced by the
copy's path, and then answers every call from what it wrote. The command
above is an example; use whatever command your writer has.
`npm run views -- <folder>` writes the reference views into a folder on disk.

## Where they are

```
views/views.json                          what was written, and from what
views/<person id>/summary.json
views/<person id>/records-<kind>-<n>.json
views/<person id>/names-<kind>.json
views/<person id>/tests.json
views/<person id>/timeline-<n>.json
views/<person id>/documents.json
views/<person id>/text-<n>.bin
views/<person id>/search-<hex>.json
views/<person id>/search-1-<hex>.json
views/<person id>/search-items.bin
views/<person id>/search-hay.bin
views/<person id>/search-labs-<n>.json
```

`views/` is at the top of the records folder, beside `household.json`. A
person's directory is named by their id in `household.json`, not their name.

JSON files are compact, UTF-8, without a byte-order mark. Binary integers are
little-endian unsigned 32-bit. Strings compare as UTF-8 bytes, as Rust's
`str` compares them. "Newest first" sorts by the date string, descending.
Undated items come last, since a missing date sorts before any string and
the order is reversed.

## When they are written, and when they are stale

Write the views whenever `index.json`, `text.json` or `household.json`
changes, in the same pass. Write `views/views.json` **last**. It records the
MD5 (hex) of each source file, exactly as stored, that the views were made
from:

```json
{"schema":"medrec-views/v1","medrec":"0.6.0","household":"<md5>","people":{"p_…":{"index":"<md5>","text":"<md5>", …}}}
```

`index` or `text` is `null` when that file is absent.

A reader compares these with the MD5s Drive reports (`md5Checksum`).
- **A person whose `index` or `text` MD5 differs has stale views.** The
  connector then reads that person's own files when they total 300,000 bytes
  or less. Otherwise it answers with an error that says the records changed
  after medrec last prepared them, and that the next pass will.
- **A different `household` MD5 makes every person's views stale.**
- **A file that `views.json` names but the folder lacks** is a write in
  progress. The connector answers "being prepared right now, ask again in a
  minute".

A writer that replaces views in place keeps each file whole: write to a
temporary name and rename, or upload a new revision. Remove the files of a
person who left `household.json`.

## `views.json`, per person

| Field | What |
|---|---|
| `index`, `text` | the MD5s above |
| `row` | `documents`, `records`, `studies`, and `newest` and `last_import` when there are any: the person's line in `medrec_summary`'s people list, without `notes` |
| `records` | for each record kind, its shards as `[newest day, oldest day, count]`, newest first; a day is `null` for undated records |
| `timeline` | the timeline's shards, the same way |
| `text_packs` | how many `text-<n>.bin` |
| `search` | `prefixes` and `firsts` (the hex keys of the search shards written), `items` (how many search items), `labs` (how many `search-labs-<n>.json`) |

## Records: `records-<kind>-<n>.json`

`<kind>` is a record's `kind` (`result`, `medication`, …). Each shard is a
JSON array of that kind's records, in the records tool's concise order:
- date, newest first, by **day** (the first 10 characters);
- then by name (`display`, clipped to 200 characters with `…`), ascending;
- then as `index.json` holds them.

Every record keeps its `index.json` fields `id`, `kind`, `date`, `code`,
`display`, `status` and `fields` as they are, when present. `provenance` is
cut to its first entry's `source`, keeping only `fhir_base` and `cli`.

A shard closes once it holds 48,000 bytes or more, but never between two
records of the same day. All undated records count as one day. So a shard's
span tells a reader whether a date range can touch it.

## `names-<kind>.json`

Every distinct name the kind's records carry, as
`[code, display, code display, [shard numbers]]`. `code` and `code display`
are `code.code` and `code.display`, or `null`. A reader filtering by name
opens only the shards a matching name is in.

## `tests.json`

Each test series (records of kind `result` with one `seriesKey`: the code's
`system|code`, or else the folded name), in the order of its newest result.

```json
{"names":[[code, display, code display], …],
 "entries":[[date, name number, shard, place in shard, rank], …]}
```

`entries` lists every result of the series, newest first.
- `shard` and `place` locate the record in `records-result-<shard>.json`.
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

Shards are cut as record shards are.

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

**Item numbers** follow medrec's order for hits of equal score: date, newest
first by the full date string, then documents, records and studies in their
`index.json` order. So hits rank by score, then item number. Every date range
is also one run of numbers.

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
character only, for one-character terms like the "d" in "vitamin d".

### `search-items.bin`

| Bytes | What |
|---|---|
| 4 | `n`, the number of items |
| 4 × (n + 1) | `text[i]`: item *i*'s text runs from `text[i]` to `text[i + 1]` in `search-hay.bin` |
| 4 × (n + 1) | `meta[i]`: item *i*'s details run from `meta[i]` to `meta[i + 1]` in the region below |
| the rest | each item's details, `[date or null, kind, id, title]` as JSON, one after another |

### `search-hay.bin`

Every item's text, UTF-8, in item order, with no separators. A reader fetches
only the byte ranges its snippets need.

### `search-labs-<n>.json`

For the lab queries (`blood test`, `blood tests`, `bloodwork`, `blood work`,
`labs`, `lab work`, `lab test`, `lab tests`, `lab results`), medrec also finds
every lab record by its kind, with score 0.
These are results, reports, and claims with a lab line. Each row is
`[item, date, kind, id, title, snippet]`, where `snippet` is the record's
detail line. Rows are in item order, 256 to a file.
