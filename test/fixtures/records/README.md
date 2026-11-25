# Sample records

A synthetic medrec records folder for the tests. Every person, organization and value in it is invented. medrec 0.9.7 wrote every file of it, from raw invented FHIR, papers and images, by

```sh
MEDREC=<medrec 0.9.7> node scripts/records.mjs <own-your-health/app at d897428> <a new folder>
```

but for Casey's `marks.json`, which does not read, on purpose. The same sources give the same bytes. The base is [own-your-health/app](https://github.com/own-your-health/app) `public/demo` at d897428, without its views and manifest. `scripts/records/more.mjs` adds, for what this connector's tests need of medrec's contract:

- **Events**: Robin's ER trip with only the hospital's claim (2026-02-14); two office visits and a lab claim on one day (2026-06-16), the lab fitting either; Sam's hospital stay (2024-04-08 to 04-11), in which Jamie was born, and Jamie's claim in it.
- **Private items and payments**: Robin's condition by its code, medicine by its name and result by its test; a record system whose records are all of one area (its visits, one with its claim in one event, and an older potassium result, a series whose latest is not private, whose value its source writes as `4.0`); a claim's paper; a letter from a practice whose name says its area; two imaging studies with reports, one report from such a practice; the household's private marks on the latex allergy and on a middle potassium result; payments of Sam's in full and of Robin's in part on two bills, one of them past due as of 2026-11-24; Casey's `marks.json`.
- **Source names**: one sign-in key (CLI, organization, FHIR base) with two of Casey's sources and one of Robin's, each with a name and a patient of its own, and a source of Casey's with no name. Two of Casey's visits were filed by a load of each patient's own, two by loads of both at one moment, so that two names are left, and one from the source with no name.
- **Notes**: one of the same day and words for each of Robin, Sam, Alex and Jamie, and one of Robin's about a document.
- **Views**: none. `scripts/derived.mjs` and `scripts/golden.mjs` make them.

After changing this folder, run `node scripts/derived.mjs` and `node scripts/golden.mjs` with the medrec the tests compare with on `PATH`, and rebuild `test/fixtures/code-names` (its README).
