# Sample records

A synthetic medrec records folder for the app’s demo mode and tests. Every person, organization and value in it is invented.

Copied from [own-your-health/app](https://github.com/own-your-health/app) `public/demo` at b16c4bd, with Jamie Example's dates moved 160 days earlier. Added since, for medrec 0.9.0's events:

- `amounts` on Robin's five claims, from their plan totals, as medrec 0.8.2 and later file them;
- Robin: an ER trip with only the hospital's claim (2026-08-14), a pharmacy claim (2026-10-02), and two office visits and a lab claim on one day (2026-09-08), the lab fitting either visit;
- Sam: a birth stay (2026-05-31 to 06-02) with the hospital's, the obstetrician's and the anesthesiologist's claims;
- Jamie: two newborn-care claims during that stay;
- the plan as a source for Sam and Jamie, and a raw file under `Records/` for each new claim. The tests compare this connector's answers over it with `medrec mcp`'s (`test/golden/`).

Added for medrec 0.9.3's private items, all invented:

- Robin: a mental health condition and medicine, a sexual-health test, a visit from a behavioral-health record system, a claim and its portal visit in one private event, a letter from a counseling practice, and an older potassium result from that practice (a series whose latest result is not private);
- Robin's `marks.json`: the household's private marks on the latex allergy and on a middle potassium result;
- Casey: a person with two records and a `marks.json` that does not read.
