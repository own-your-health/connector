# Sample records

A synthetic medrec records folder for the app’s demo mode and tests. Every person, organization and value in it is invented.

The base is [own-your-health/app](https://github.com/own-your-health/app) `public/demo` at d8a914c, without its views and manifest. Added for medrec 0.9.0's events:

- Robin: an ER trip with only the hospital's claim (2025-11-06), a pharmacy claim (2026-07-21), and two office visits and a lab claim on one day (2026-05-12), the lab fitting either visit;
- Sam: a hospital stay (2026-07-27 to 07-30) with the hospital's, a doctor's and an anesthesiologist's claims, Jamie's birth among it;
- Jamie: two newborn-care claims during that stay;
- the plan as a source for Sam and Jamie, and a raw file under `Records/` for each new claim. The tests compare this connector's answers over it with `medrec mcp`'s (`test/golden/`).

Added for medrec 0.9.3's private items and 0.9.5's linked documents and studies:

- Robin: a mental health condition and medicine, a sexual-health test, a visit from a behavioral-health record system, a claim and its portal visit in one private event, a letter from a counseling practice, an older potassium result from that practice (a series whose latest result is not private), and two imaging studies with their reports: one whose report a private visit links, and one that nothing makes private;
- Robin's `marks.json`: the household's private marks on the latex allergy and on a middle potassium result;
- Casey: a person with two records and a `marks.json` that does not read, on purpose;
- payments the household marked: Sam's `marks.json` pays their first bill in full, and Robin's pays part of two, one of them past due.

After changing this folder, run `node scripts/derived.mjs` and `node scripts/golden.mjs` with medrec 0.9.5 on `PATH`.
