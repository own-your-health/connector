# Private

medrec 0.9.2's `views/<person id>/private.json` (`medrec-private/v1`, medrec-cli docs/data-contract.md, "Private"), the private records, documents and events, for each person, byte for byte, as `medrec views write` wrote them:

- `records/<person id>.json`: over `test/fixtures/records`;
- `large/<person id>.json`: over `node scripts/synth.mjs <out-dir>`, run from the same commit.

`node scripts/derived.mjs`, with medrec on `PATH`, rebuilds them with the `events` fixtures. Every value is invented.
