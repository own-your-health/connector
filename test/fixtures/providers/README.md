# Provider labels

medrec 0.9.8's `views/<person id>/providers.json` (`medrec-providers/v1`, medrec-cli docs/data-contract.md, "Provider labels"), who the providers a person's items print are, byte for byte, as `medrec views write` wrote them:

- `records/<person id>.json`: over `test/fixtures/records`;
- `large/<person id>.json`: over `node scripts/synth.mjs <out-dir>`, run from the same commit;
- `labels/<person id>.json`: over `test/fixtures/labels`.

A person with no labelled provider has no file. `node scripts/derived.mjs`, with medrec on `PATH`, rebuilds them with the `events` fixtures; the labels' ids are new each time, as they come from the folder's random salt. Every value is invented.
