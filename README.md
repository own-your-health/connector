# Own Your Health connector

A read-only [MCP](https://modelcontextprotocol.io) connector over a household's
[medrec](https://github.com/piekstra/medrec-cli) records folder in Google Drive.
It runs as a Cloudflare Worker in the household's own Cloudflare account. An
assistant that accepts remote MCP connectors (Claude on the web, phone and
desktop, and others; see [Assistants](#assistants)) can then answer questions
from the records, with no computer left on to serve them.

It offers the four tools of `medrec mcp` 0.9.8 under the same names, with the
same descriptions and schemas (`spec/medrec-tools.json`). The answers are the
same too: `test/golden.test.ts` holds 305 recorded calls of `medrec mcp` to
this connector's answers, to the character. One thing differs until medrec
0.9.9: what an event's `fields` leave out (`private_members`, below). The tools'
descriptions and schemas do not mention it.

| Tool | What it answers |
|---|---|
| `medrec_summary` | The household's people; with `person`, their current medicines, conditions, allergies, vaccines, latest results, recent visits and bills |
| `medrec_search` | Every document, record, study and note holding all the query's words |
| `medrec_records` | One kind of record (medications, results, tests, visits, claims, bills, documents, notes, the timeline…), filtered and paged; `events`: what happened, one per visit, ER trip, stay or fill, with what the household owes; `bills`: whether each is paid, or what is left |
| `medrec_document` | A document's extracted text, a part at a time |

Records, documents, events and imaging studies about mental health,
reproductive or sexual health or substance use are private: medrec marks them
in `private.json`, and the household can mark others. A document is private
when a private record links it, and a study when its report is. An answer
about the whole household leaves them out, and its `warnings` say how many
each page left out. An answer about one person includes them, and so does one
that names the item ("sertraline", not "tablets"). Each one it includes
carries `private`, its area. A study with no report is left out, counted and
included the same way, but carries no area: nothing says what it is about.
An event that is not private can have a private record or document. Where an
event's `fields` list its members (with `response_format: "detailed"`, or by
its id), an answer about the whole household leaves those out of `members`,
which can then be empty, and names no private event it is linked to or could
join: `links` or `could_join` is absent when nothing is left of it.
`fields.private_members`, a number, says how many members were left out. It is
absent when none were. An answer about one person lists all of that person's
own. Another person's private document or event is in no answer about the
first, and `private_members` counts such a document there too. The place of
another person's stay, as of a birth, is an event's place only when that stay
holds nothing private.
A claim, a bill or an event can be open with a private part: a service among
others, a diagnosis, a line of the text. When medrec 0.9.9 or later has marked
those, an answer that names no person leaves them out, lists and finds the item
by what is left, and says how much it left out: `not_shown`, or a text's `(1 line
not shown)` and its `hint`. `medrec_document` gives all of the text with
`person`, whose document it is. What an item cost stays.
This is discretion, not access control: anyone the connector lets in can ask
about one person.

What a chart holds about somebody else (a screening a parent answers of
themselves in their child's chart, or a result its source says is of another) is
in no answer. A list of that person's results, tests, timeline or documents says
how many.

A condition with a diagnosis code carries `plain_name` beside the source's
own words when medrec 0.9.4 or later has the code's published name
(`code-names.json`). Nothing is found, sorted or paged by it, and the source's
words are always shown too. An answer about the whole household gives none to a
private item, even one it names. Names that are missing or older than the
records are left out, with no warning.

A claim, document, bill or event that prints a provider, and any record asked
for in detail that does, carries `provider_labels` when medrec 0.9.7 or later
knows who that is (`providers.json`): a name, practice, role and phone, how
sure it is (`household`, `sure` or `likely`) and why, and where the phone is
from. They stand beside the source's own words. Nothing is found, sorted or
paged by one, and `medrec_search` and `medrec_summary` have none. An answer
about the whole household, or a document's text, gives none to a private item,
even one it names, and no reason that names one. Labels that are missing or
older than the records are left out, with no warning. An item's labels that do
not fit a page beside it are left out with a `provider-labels-left-out`
warning, and those of a person whose file one answer has no room to read with a
`provider-labels-not-read` warning.

A condition, allergy or medicine carries `standing`, what all of its sources
make of it today, and `says`, each source's word with the day it was read, when
medrec 0.9.9 or later has prepared them (`standing.json`). `active` lists what
any source says is current, one line for each condition or allergy, then
medicines on hold and those whose end date has passed. Where sources differ, the
line says so and gives each word; none wins. What is entered in error by
every source that has it is in no list, event, bill or total, and an
`entered-in-error` warning says how many; a paper or an event of it opens by its
id, and says so. Any other item its sources differ on says `sources differ` and
each word. A `no-problem-list`
warning names the sources that send only diagnoses from visits. Views from an
earlier medrec are listed by each record's own status.

Not affiliated with Anthropic, Google, OpenAI or Cloudflare.

## How it keeps the records private

- **Read-only.** The Worker asks Google for `drive.file` (or, if you choose,
  `drive.readonly`), and its code has no path that writes.
- **Nothing stored.** Each call looks up the records folder's files with the
  caller's own Google token and reads what it needs. Parsed files are kept only in the
  isolate's memory, and only while their version in Drive is unchanged. Nothing
  goes to KV, D1, R2 or the cache API, and request logs are off
  (`observability` in `wrangler.jsonc`).
- **Only your accounts.** Signing in goes through Google, and only the
  accounts in `ALLOWED_ACCOUNTS` are admitted. The list is checked again on
  every call and every token refresh, so removing an account ends its
  connections.
- **Only your assistants.** Authorization codes go only to the callbacks of
  the assistants you turn on (`ASSISTANTS`). The consent page names where
  access goes, and asks you to continue only if you started connecting
  yourself.
- **Tokens encrypted.** Google's refresh token lives in the connection's grant,
  which [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)
  encrypts in KV with a key only that connection's tokens unlock.
- **An audit with no contents.** Each call records the time, the Google
  account, the connection, the assistant and the tool name in D1. It never
  records arguments or results.
- **Errors without contents.** Tool errors carry no record text, and none of
  Drive's own messages.

What it cannot protect against: anyone who controls your Cloudflare account,
your Google account, or your assistant account. Your assistant's provider
sees what the tools return, as with any connector.

## Costs

Nothing. It runs on Cloudflare's **Workers Free** plan, which gives a request
10 ms of CPU and 50 subrequests, and allows 100,000 requests a day. A
request over a Free plan limit fails; nothing is ever charged.

A call fits because it reads **views** in the records folder: the same
records cut into small files, each in the order a tool lists them
([docs/views.md](docs/views.md)). A call reads only the few kilobytes its
answer needs, instead of parsing each person's megabytes of `index.json` and
`text.json`.

- **medrec 0.8.0 and later** write the views in the same pass as the records.
- **An earlier medrec** writes none. `npm run views -- <folder>` writes them
  into the folder on disk (for example through Google Drive for desktop), and
  has to run again after each refresh. Once medrec writes views there, the
  script leaves them alone unless given `--force`.
- **A person with 300,000 bytes or less** of those files is answered from
  their files, views or not. Anyone larger needs current views. Without them,
  the tool says why it cannot answer (below), never answering from records
  that have since changed.

| Call, over a synthetic folder of six people with views, 6.0 MB of index and 6.5 MB of text, one record in 20 private, every claim with a provider label (255 KB of them) | CPU, cold, least | CPU, cold, median | Requests to Google |
|---|---:|---:|---:|
| `tools/list` (sign-in check and MCP framing) | 0.2 ms | 0.2 ms | 0 |
| `medrec_summary` of one person | 2.0 ms | 2.6 ms | 13 |
| `medrec_search`, one word | 3.3 ms | 4.8 ms | 40 |
| `medrec_search`, one word, 100 hits | 4.8 ms | 8.7 ms | 40 |
| `medrec_search`, three words | 3.2 ms | 4.0 ms | 45 |
| `medrec_search` for one letter, 200 hits (the most a call returns) | 4.2 ms | 5.4 ms | 25 |
| `medrec_search` for "labs" (every lab record, by kind) | 3.2 ms | 5.5 ms | 43 |
| `medrec_records` results, 200 | 3.3 ms | 4.0 ms | 16 |
| `medrec_records` tests, everyone | 4.5 ms | 5.7 ms | 28 |
| `medrec_records` timeline of one person | 2.1 ms | 2.5 ms | 9 |
| `medrec_records` timeline, everyone, 200 | 3.6 ms | 5.1 ms | 23 |
| `medrec_records` claims, everyone, 200, with labels | 5.7 ms | 6.4 ms | 25 |
| `medrec_records` bills, everyone | 3.3 ms | 4.0 ms | 23 |
| `medrec_records` conditions, everyone, 200, with plain names | 2.8 ms | 3.4 ms | 17 |
| `medrec_records` conditions of one person, with plain names | 1.7 ms | 2.1 ms | 8 |
| `medrec_records` events, everyone | 4.2 ms | 5.2 ms | 18 |
| `medrec_records` events of one person, detailed, 200 | 2.8 ms | 3.5 ms | 8 |
| `medrec_records` events with a name, everyone, 200 | 4.2 ms | 5.1 ms | 20 |
| `medrec_records` one event by `id` | 3.2 ms | 4.0 ms | 16 |
| `medrec_document`, a page | 3.1 ms | 4.2 ms | 10 |
| for scale: `JSON.parse` of 0.96 MB | 2.9 ms | 3.0 ms | — |

Measured with `npm run bench:cpu -- bench/views.cpu.ts` (2026-11-25, Apple
silicon, six runs of 15 calls each: the least of all, and the median of the
runs' medians). The Worker answered in Node, through its own OAuth check, MCP
framing, Drive client and views, with Node's own `fetch` work counted. Google
was a local fake on another thread, whose work is not counted. A cold call is
the first on a fresh isolate, which downloads and parses every file it needs.
The machine was busy (load 12 to 23): the scale row takes about 2.2 ms on a quiet
one, and the medians spread with the load. Cloudflare's dashboard shows the
deployed Worker's own CPU times.

At the limits:

- **More than 48 requests to Google.** The tool answers that the question
  needs more of the records than one request may read, and asks for one
  person, fewer dates or fewer words.
- **Views older than the records.** For a person with 300,000 bytes or less,
  the connector reads their files whole. For anyone larger, the tool says
  that person's records changed after medrec last prepared them, and that
  medrec's next pass will. A question about another person by name still
  answers, and so does `medrec_document`. A search or list across everyone
  answers without that person, and its `warnings` (code
  `person-unavailable`) say whose records are missing and why. When no one
  can be read, it gives the error instead.
- **The people list meanwhile.** `medrec_summary` lists everyone. A large
  person whose views are stale appears with the counts and dates of their
  last prepared views, so one pending refresh does not fail every summary.
- **Views still arriving.** Drive may hold some of a new pass's views before
  the rest. A call that would read one of them says the records are being
  prepared and to ask again in a minute. It never mixes two passes.
- **Views from a newer medrec.** A layout this connector does not know reads
  like no views, and a large person's calls say the connector needs updating
  ([Updating](#updating)).
- **Views from an earlier layout.** A folder prepared by this connector's
  first `npm run views` (`medrec-views/v1`) reads like no views for a large
  person, and their calls say so. medrec 0.8.0's next pass, or
  `npm run views`, writes the current layout.
- **Events.** Only medrec groups records into events, so `kind: "events"`
  reads the `events.json` medrec 0.9.0 and later write, for every person,
  small ones too. `npm run views` does not write it. A person whose events
  are missing, or older than their records, their `overrides.json` or a
  linked newborn's or guardian's records, is left out of a question about
  everyone with a warning, and a question about them says why.
- **Private items not known.** Only medrec marks private items, in the
  `private.json` medrec 0.9.5 and later write in full. A person whose
  `private.json` is missing, older than their records, `overrides.json`,
  `marks.json`, `provider-state.json` (medrec 0.9.7) or a linked person's
  records, in a layout this connector does not read, or from medrec 0.9.4 or
  earlier (which says nothing about studies, or of documents a private record
  links), has all their records, documents, events and studies held back from
  answers about everyone. Their notes stay.
  A `private-not-prepared` warning names them and says why. An answer about
  that person includes everything, with the same warning, marked only as far
  as a `private.json` from medrec 0.9.1 to 0.9.4 says. A person
  whose `marks.json` or `provider-state.json` medrec could not read is held
  back the same way, with medrec's `private-marks-unreadable` or
  `private-labels-unreadable` warning. Once a computer with medrec 0.9.7 has
  written a `provider-state.json`, every computer that writes the folder needs
  0.9.7 or later: an earlier one's views are made without it. The
  `private-not-prepared` warning then asks for a pass by 0.9.7 or later, which
  ends it. Each person with any private
  item costs one more request to Google, and so does each other person whose
  document or event the events on a detailed page about one person name, or
  whose stay an event found has its place from. An answer that names no person
  costs one more for each person with a private part among what a search finds,
  or with two claims of one day that it shows by one name. When
  that request fails, or that person's private items are not known, the page
  leaves out theirs with one of those warnings. A series of tests is private when
  any of its results is (medrec 0.9.3): finding a person's private results
  among their series costs one more request, and one per shard that holds
  two results of one date and name. When one of them cannot be found there,
  that person's tests are left out of an answer about everyone with a
  `person-unavailable` warning, and an answer about them says to ask again.
- **Which source a record came from.** A CLI, an organization and a FHIR base
  do not name one. Views from medrec 0.9.6 and later label each record with
  the name of its source, or with the CLI when none is known. In earlier
  views, a list of records or tests names a source only where the person's
  own with those three all have one name. The timeline, the summary and events
  keep the name their writer gave, which can be another source's.
- **Plain names.** Each person with a coded condition on the page costs one
  more request to Google, and one for a summary with any. When that request
  fails, or would pass the limit, the answer comes without the names.
- **Provider labels.** Each person with a printed provider on the page (a
  claim, document, bill or event, and any record with
  `response_format: "detailed"`) costs one more request to Google, and so does
  a document's text. When that request fails or would pass the limit, the
  answer comes without their labels. An answer reads at most 256,000 bytes of
  `providers.json`, people in the household's order. Someone whose file has no
  room left comes without theirs, and a list says so; a question about that
  person alone reads up to 256,000 bytes of theirs.
- **Payments.** `bills.json` (medrec 0.9.1 and later) says which bills the
  household has paid and what is left. A settled bill is never past due, and
  the summary leaves it out. A person without a current `bills.json` has
  their bills listed as their statements asked, with a `bills-not-prepared`
  warning on `kind: "bills"`, and in the summary as medrec 0.9.0 showed
  them.
- **Over 10 ms of CPU.** Cloudflare ends the request, and the assistant
  reports a failed call. Asking again usually succeeds, as warm calls parse
  nothing.

## Set it up

You need: a Cloudflare account, a GitHub account, the Google Cloud project
your medrec signs in with, and Node 22.18 or newer.

### 1. Cloudflare

1. Create a Cloudflare account for the connector, on the Free plan. A
   separate one keeps its usage apart from anything else you run.
2. Open **Workers & Pages** once, so the account gets its `workers.dev`
   subdomain. Note the account id in the right-hand column.
3. Create an account API token: **Manage Account > Account API Tokens >
   Create Token**, with **Workers Scripts: Edit**, **Workers KV Storage:
   Edit** and **D1: Edit**, for this account only. The first deploy creates
   the connector's KV namespace and D1 database itself. Note the expiry date
   you give it (see [Renewing the deploy token](#renewing-the-deploy-token)).

### 2. GitHub

1. Fork this repository, or copy it into one of your own. The public
   repository holds no household's data, and yours never needs to.
2. **Settings > Environments > New environment**, named `production`. Under
   **Deployment branches and tags**, choose **Selected branches** and add
   `main`.
3. In that environment, add two **environment secrets**:
   `CLOUDFLARE_API_TOKEN` (the token from step 1.3) and
   `CLOUDFLARE_ACCOUNT_ID`. Paste the token straight from Cloudflare's page.
   Nothing else goes into GitHub.

Each push to `main` then runs the checks and deploys
(`.github/workflows/ci.yml`). A pull request runs the checks only, and never
sees the environment's secrets. Every action is pinned by commit, and the
workflow's token can only read. The first deploy prints the Worker's address,
`https://records-connector.<subdomain>.workers.dev`.

To deploy from your computer instead, fill in `connector.local.json` (below)
and run `npm ci && npm run deploy`. Wrangler signs you in on first use.

### 3. Google

The connector's own sign-in is a **Web client in the same Cloud project as
medrec's**. Under `drive.file`, the clients of one project share access to
the files any of them made. So the connector can read the records folder
medrec made, and nothing else in the account
([pk-cli-drive's test](https://github.com/piekstra/cli-common/blob/main/crates/pk-cli-drive/docs/google-drive.md#scope-drivefile-or-full-drive)).

That access belongs to the Google account medrec signs in with, which owns
the folder. So an assistant is connected by signing in with **that**
account. Another account on `allowed_accounts` can sign in, but cannot open
the folder.

1. In the Cloud console, **Google Auth Platform > Clients > Create client**,
   type **Web application**.
2. Under **Authorized redirect URIs**, add
   `https://records-connector.<subdomain>.workers.dev/google/callback`.
3. Create it, and click **Download JSON** without copying anything from the
   dialog. The file holds the client secret.
4. Under **Data Access**, the project needs `openid`, `.../auth/userinfo.email`
   and `.../auth/drive.file` (or `drive.readonly`, if your records folder was
   not made by medrec's client).

### 4. Settings

```sh
cp connector.example.json connector.local.json   # git ignores it; fill it in
npm ci
npm run setup -- ~/Downloads/client_secret_….json
rm ~/Downloads/client_secret_….json
```

`npm run setup` sends everything to the Worker in one
`wrangler secret bulk` over stdin. No value is printed or passed as an
argument. It sets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`ALLOWED_ACCOUNTS`, `FOLDER_ID` (once `folder_id` is filled in), and
optionally `TIME_ZONE` (for "past due"), `ASSISTANTS` and `DRIVE_SCOPE`. Deploys never change them. After editing
`connector.local.json`, run `npm run setup -- --settings-only`.

`FOLDER_ID` is the records folder's Drive id: the part after `/folders/` in
its link, in the folder holding `household.json`. Without it, assistants can
connect, and each tool call says it is not set.
Add it later with `npm run setup -- --settings-only`.

The scripts run wrangler on the account `account_id` names, and no other.
To keep this account's wrangler sign-in apart from one you use elsewhere,
set `wrangler_config` to a directory of its own (for example
`~/.config/records-connector/wrangler`). Wrangler then keeps the sign-in
there, and `npx wrangler login` with `XDG_CONFIG_HOME` set to it signs in.

### 5. Connect an assistant

The connector's address is `https://records-connector.<subdomain>.workers.dev/mcp`.

- **Claude** (web, desktop, phone): **Settings > Connectors > Add custom
  connector**, paste the address, then **Connect**. Sign in with the Google
  account that owns the records folder (step 3). A connector added on the
  web also appears in the phone and desktop apps.
- **Claude Code**: `claude mcp add --transport http records <address>`.
- **ChatGPT**: add `chatgpt` to `assistants`, run `npm run setup --
  --settings-only`, then add the address as a connector on chatgpt.com.
- **Gemini**: add `gemini` to `assistants` and run setup, then add the
  address at gemini.google.com in a browser. The app then reaches it with
  `@`.
- **Gemini CLI**: add `loopback`, and in `settings.json` under `mcpServers`,
  `"records": { "httpUrl": "<address>" }`.

## Assistants

| Assistant | `ASSISTANTS` entry | Callback | Tested |
|---|---|---|---|
| Claude (web, desktop, phone) | `claude` (default) | `https://claude.ai/api/mcp/auth_callback` | not yet |
| Claude Code, Gemini CLI, other programs on your computer | `loopback` (default) | `http://localhost:<port>/…`, `http://127.0.0.1:<port>/…` | not yet |
| ChatGPT | `chatgpt` | `https://chatgpt.com/connector/oauth/…`, `https://chatgpt.com/connector_platform_oauth_redirect` | not yet |
| Gemini (web; the phone app uses what the web added) | `gemini` | `https://oauth-redirect.googleusercontent.com/r/…` | not yet |
| Perplexity | `perplexity` | `https://www.perplexity.ai/rest/connections/oauth_callback` | not yet |

`EXTRA_REDIRECT_URIS` (comma-separated, matched exactly) allows any other.

## Updating

A fork updates from this repository: on GitHub, **Sync fork** on your
fork's main page, or `git pull` from this repository and push to your
`main`. Each push to `main` deploys. Settings and connections stay as they
are. A release's notes say when it reads a newer medrec's views. A folder
prepared by `npm run views` needs one more run after an update that changes
what the script writes: the release's notes say so.

## Renewing the deploy token

An account API token can carry an expiry. Once it passes, the deploy job
fails at `wrangler deploy` with an authentication error. The Worker keeps
serving, and nothing changes until the next deploy. To renew it, create a
token as in step 1.3, then replace `CLOUDFLARE_API_TOKEN` in the
`production` environment, pasting it straight from Cloudflare's page. Delete
the old token in Cloudflare.

## Revoking, and seeing who used it

```sh
npm run grants                    # every connection: account, assistant, when, id
npm run grants -- revoke <id>     # end one connection
npm run grants -- revoke --all    # end them all
npm run audit                     # who called what, the last 7 days
npm run audit -- --since 2026-11-01 --limit 500
```

These run wrangler against the account in `connector.local.json`. Ending a
connection deletes its grant and tokens from KV, along with the Google
refresh token inside. A connection also ends on its own after 60 days unused.

The connector never revokes anything at Google: every client of the Cloud
project shares one grant, so a revoke would also sign you out of medrec and
the web app. To cut off the connector's own client entirely, delete it in the
Cloud console.

## Development

```sh
npm ci
npm test            # parity with medrec, the Worker end to end, the pieces
npm run verify      # what CI runs: types, tests, pinned copies, no personal data, bundle
npm run golden      # re-record medrec's answers (needs `medrec` on PATH)
npm run bench:cpu   # CPU per call in Node: bench/views.cpu.ts (views), parts.cpu.ts (files read whole), request.cpu.ts
npm run bench       # CPU per call in workerd under wrangler dev (its local KV and D1 add CPU)
npm run views -- <folder>   # write the reference views into a records folder on disk; --force replaces medrec's
npm run dev         # the Worker on 127.0.0.1:8787
```

The views a tool reads are in `src/views` (the reference writer, and the
store that reads them); docs/views.md is their layout, for medrec's writer.
The goldens run twice, over the files and over the views.

Every record in the tests is invented. `test/fixtures/records` is the web
app's demo folder; `scripts/synth.mjs` grows it to a large family's size.
Google is `test/fake-google.ts`. The Drive client is a pinned copy of
[own-your-health/app](https://github.com/own-your-health/app)'s
(`src/records/app/PIN.json`, checked by `scripts/check-copies.mjs`).

## License

Copyright (C) 2026 Own Your Health contributors. Licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only); see LICENSE.
