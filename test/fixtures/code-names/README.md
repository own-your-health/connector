# Code names

medrec 0.9.4's `views/<person id>/code-names.json` (`medrec-code-names/v1`, medrec-cli docs/data-contract.md, "Code names"), the plain names of the diagnosis codes a person's records use, byte for byte, as `medrec views write` wrote them:

- `records/<person id>.json`: over `test/fixtures/records`;
- `large/<person id>.json`: over `node scripts/synth.mjs <out-dir>`, run from the same commit.

A person with no named code has no file. The titles are invented: medrec was built with a six-row table in place of the published one, so `table` says `invented`. `scripts/derived.mjs` does not rebuild them, and `scripts/golden.mjs` puts them in the folders' views before it records.
