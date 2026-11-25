# The folder for provider labels

medrec's own fixture for provider labels, from medrec-cli 0.9.8's `tests/fixtures/labels`: one invented person's folder, whose providers belong to nobody.

- `household.json`, `index.json`, `text.json` and `provider-state.json` are byte for byte medrec-cli's. `scripts/labels-folder.mjs` writes them out as a folder.
- `marks.json` is medrec-cli's after `medrec labels set --person Robin --printed "Example Family Practice" --name "Our practice" --phone 555-010-0142`, so that the folder has something the household said.
- `reader.json` is medrec-cli's `providers.json` for its reader's own tests, byte for byte; `test/provider-labels.test.ts` runs the same cases.
