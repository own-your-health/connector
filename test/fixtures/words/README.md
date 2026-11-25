# What each source says

medrec's own fixture for what each source says of a condition, an allergy or a medicine, from medrec-cli 0.9.9's `tests/fixtures/standing`: one invented person's records.

- `household.json`, `index.json`, `lists.json` and `standing.json` are byte for byte medrec-cli's. The folders of `errors`, `given`, `questionnaires` and `parts` have this `household.json` too.
- `marks.json` is what `medrec private mark` wrote for five of the records, so that the folder has private ones.
- `views/` is all that `medrec views write` wrote for the folder (`scripts/own-folder.mjs`). `node scripts/derived.mjs`, with medrec on `PATH`, rebuilds it.

`test/standing.test.ts` holds this connector's reading of `standing.json` to `lists.json`. Every value is invented.
