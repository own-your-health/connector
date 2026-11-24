# Events

medrec 0.9.5's `views/<person id>/events.json` (`medrec-events/v1`, medrec-cli docs/data-contract.md, "Events") for each person, byte for byte, as `medrec views write` wrote them:

- `records/<person id>.json`: over `test/fixtures/records`;
- `large/<person id>.json`: over `node scripts/synth.mjs <out-dir>`, run from the same commit.

`node scripts/derived.mjs`, with medrec on `PATH`, rebuilds these and the `bills` and `private` fixtures beside them. Run it after changing either folder or `scripts/synth.mjs`. Every value is invented.

The shapes they hold:

| Shape | Person | Event |
|---|---|---|
| A stay with the hospital's and doctors' claims, linked to the newborn | Sam | 2026-07-27, `inpatient`, links `newborn` |
| The newborn's care in that stay | Jamie | 2026-07-28, `stay_no_facility`, links `born_during` |
| An ER trip with only the hospital's claim | Robin | 2025-11-06, `er`, expected `doctor_claims` and `bill` |
| An office visit with its portal visit, results and papers | Robin | 2026-10-01 and 2026-11-18 |
| A bill matched to its claim by the amount due | Robin | 2026-10-01 and 2026-10-03, rule `D3s` |
| A fill, from a claim and from the portal | Robin | 2026-07-21, and 2026-08-14 and 2026-11-12, `fill` |
| A lab claim that fits two visits that day | Robin | 2026-05-12, `unsure`, `could_join` two events |
| Portal visits with no claim yet | Jamie | 2026-08-31 and 2026-09-29 |
| Vaccines | Alex, Robin | `vaccine` |
