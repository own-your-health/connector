# Standing

medrec 0.9.9's `views/<person id>/standing.json` (`medrec-standing/v1`, medrec-cli docs/data-contract.md, "Standing"), what is current among each person's conditions, allergies and medicines by every source's word, byte for byte, as `medrec views write` wrote them:

- `records/<person id>.json`: over `test/fixtures/records`;
- `large/<person id>.json`: over `node scripts/synth.mjs <out-dir>`, run from the same commit;
- `labels/<person id>.json`: over `test/fixtures/labels`.

`node scripts/derived.mjs`, with medrec on `PATH`, rebuilds them with the `events` fixtures. Every value is invented.
