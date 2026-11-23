# Own Your Health connector

A read-only [MCP](https://modelcontextprotocol.io) connector over a household's
[medrec](https://github.com/piekstra/medrec-cli) records folder in Google Drive.
It runs as a Cloudflare Worker in the household's own Cloudflare account. An
assistant that accepts remote MCP connectors (Claude on the web, phone and
desktop, and others; see [Assistants](#assistants)) can then answer questions
from the records, with no computer left on to serve them.

It offers the four tools of `medrec mcp` 0.5.0 under the same names, with the
same descriptions and schemas (`spec/medrec-tools.json`). The answers are the
same too: `test/golden.test.ts` holds 154 recorded calls of `medrec mcp` to
this connector's answers, to the character.

| Tool | What it answers |
|---|---|
| `medrec_summary` | The household's people; with `person`, their current medicines, conditions, allergies, vaccines, latest results, recent visits and bills |
| `medrec_search` | Every document, record, study and note holding all the query's words |
| `medrec_records` | One kind of record (medications, results, tests, visits, claims, bills, documents, notes, the timeline…), filtered and paged |
| `medrec_document` | A document's extracted text, a part at a time |

Not affiliated with Anthropic, Google, OpenAI or Cloudflare.

## How it keeps the records private

- **Read-only.** The Worker asks Google for `drive.file` (or, if you choose,
  `drive.readonly`), and its code has no path that writes.
- **Nothing stored.** Each call lists the records folder with the caller's own
  Google token and reads what it needs. Parsed files are kept only in the
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

Run it on **Workers Paid ($5 a month)**. The Free plan allows 10 ms of CPU a
request, and a folder of a few years' records needs more on the first call after a quiet
spell:

| Call, over a synthetic folder of 5.5 MB of index and 6.5 MB of text | CPU, warm | CPU, cold |
|---|---:|---:|
| `tools/list` (sign-in check and MCP framing) | 6.5 ms | — |
| `medrec_summary` of one person | 16 ms | 32 ms |
| `medrec_search` | 16 ms | 134 ms |
| `medrec_records` results, 200 | 11 ms | — |
| `medrec_records` timeline | 12 ms | — |
| `medrec_document`, 16,000 characters | 12 ms | — |

Measured with `npm run bench` (workerd under `wrangler dev` on an Apple
silicon Mac, mean of 40 calls, 2026-11-23); runs differ by about 5 ms. The
local KV and D1 simulators add CPU that production does not spend. A call is
cold on a fresh isolate or after a file changed. Workers
Paid allows 30 s and includes far more requests than one household makes.
Cloudflare's dashboard shows the deployed Worker's own CPU times.

## Set it up

You need: a Cloudflare account, a GitHub account, the Google Cloud project
your medrec signs in with, and Node 22.18 or newer.

### 1. Cloudflare

1. Create a Cloudflare account for the connector. A separate one keeps its
   usage apart from anything else you run.
2. Open **Workers & Pages** once, so the account gets its `workers.dev`
   subdomain. Note the account id in the right-hand column.
3. Subscribe the account to **Workers Paid** (see [Costs](#costs)).
4. Create an account API token: **Manage Account > Account API Tokens >
   Create Token**, with **Workers Scripts: Edit**, **Workers KV Storage:
   Edit** and **D1: Edit**, for this account only. The first deploy creates
   the connector's KV namespace and D1 database itself.

### 2. GitHub

1. Fork this repository, or copy it into one of your own. The public
   repository holds no household's data, and yours never needs to.
2. **Settings > Environments > New environment**, named `production`. Under
   **Deployment branches and tags**, choose **Selected branches** and add
   `main`.
3. In that environment, add two **environment secrets**:
   `CLOUDFLARE_API_TOKEN` (the token from step 1.4) and
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
`ALLOWED_ACCOUNTS`, `FOLDER_ID`, and optionally `TIME_ZONE` (for "past due"),
`ASSISTANTS` and `DRIVE_SCOPE`. Deploys never change them. After editing
`connector.local.json`, run `npm run setup -- --settings-only`.

`FOLDER_ID` is the records folder's Drive id: the part after `/folders/` in
its link, in the folder holding `household.json`.

### 5. Connect an assistant

The connector's address is `https://records-connector.<subdomain>.workers.dev/mcp`.

- **Claude** (web, desktop, phone): **Settings > Connectors > Add custom
  connector**, paste the address, then **Connect**. Sign in with an admitted
  Google account. A connector added on the web also appears in the phone and
  desktop apps.
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
npm run bench       # CPU per call in workerd, over a large synthetic folder
npm run dev         # the Worker on 127.0.0.1:8787
```

Every record in the tests is invented. `test/fixtures/records` is the web
app's demo folder; `scripts/synth.mjs` grows it to a large family's size.
Google is `test/fake-google.ts`. The Drive client is a pinned copy of
[own-your-health/app](https://github.com/own-your-health/app)'s
(`src/records/app/PIN.json`, checked by `scripts/check-copies.mjs`).

## License

MIT
