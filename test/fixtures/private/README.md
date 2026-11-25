# Private

medrec 0.9.7's `views/<person id>/private.json` (`medrec-private/v1`, medrec-cli docs/data-contract.md, "Private"), the private records, documents, events and imaging studies, and the studies no report judges, for each person, byte for byte, as `medrec views write` wrote them:

- `records/<person id>.json`: over `test/fixtures/records`;
- `large/<person id>.json`: over `node scripts/synth.mjs <out-dir>`, run from the same commit;
- `labels/<person id>.json`: over `test/fixtures/labels`.

`node scripts/derived.mjs`, with medrec on `PATH`, rebuilds them with the `events` fixtures. Every value is invented.
