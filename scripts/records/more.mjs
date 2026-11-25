// What the connector's tests need beyond the app's sample: raw FHIR as
// invented providers would serve it, papers and images as a household would
// keep them, and the marks they would make. Written from medrec's data
// contract (docs/data-contract.md: Events, Private, "Which source"). Invented.
//
// Nothing here is a field of medrec's: medrec's release reads these and writes
// the records (../records.mjs).

/** `lib`: the app's builders (scripts/sample/{fhir,papers,dicom}.mjs); `sample`: its streams and sources. */
export function more({ lib, sample }) {
  const { allergy, claim, condition, encounter, line, order, paper, pdf, result, rid, vaccine, image } = lib;
  const { SOURCES } = sample;

  const people = {
    jamie: { name: 'Jamie Example', born: '2024-04-09', args: ['--child', '--guardian', 'Robin Example', '--guardian', 'Sam Example'] },
    casey: { name: 'Casey Example', born: '1985-05-05', args: ['--adult'] },
  };

  const CARE_PLAN = SOURCES.samPlan.org;
  const PEDIATRICS = SOURCES.alexPeds.org;
  const COUNSELING = { id: 'example-counseling', name: 'Example Counseling', fhir_base: 'https://notes.example.org/r4', vendor: 'notes' };
  // One sign-in key, the CLI, organization and FHIR base: its sources differ
  // only in whose they are and in the patient.
  const SHARED = { cli: 'athena', version: '0.6.1', login: 'casey', relationship: 'self' };
  const shared = (name, id = 'example-records') => ({ id, name, fhir_base: 'https://records.example.net/fhir/r4', vendor: 'athena' });
  const sources = {
    jamiePlan: { cli: 'kp', version: '0.4.0', person: 'jamie', login: 'sam', org: CARE_PLAN, patient: 'pat-71f4e5', relationship: 'child' },
    jamiePeds: { cli: 'athena', version: '0.6.1', person: 'jamie', login: 'alex', org: PEDIATRICS, patient: 'pat-c20a96', relationship: 'child' },
    robinNotes: { cli: 'icanotes', version: '0.2.0', person: 'robin', login: 'robin', org: COUNSELING, patient: 'pat-3d90be', relationship: 'self' },
    robinShared: { ...SHARED, person: 'robin', org: shared('Placeholder Skin Clinic'), patient: 'pat-c0f1a3' },
    caseyFirst: { ...SHARED, person: 'casey', org: shared('Example Walk-in Clinic'), patient: 'pat-c0f1a1' },
    caseySecond: { ...SHARED, person: 'casey', org: shared('Sample Eye Center'), patient: 'pat-c0f1a2' },
    caseyNoName: { ...SHARED, person: 'casey', org: shared('', 'example-records-2'), patient: 'pat-c0f1a4' },
  };

  // ---- Sam's stay, and Jamie's care in it (X1) ----

  const DELIVERY = ['Z39.0', 'Encounter for care and examination of mother immediately after delivery'];
  const carePlan = (who, what, more) => claim(`${who} plan ${what}`, { insurer: 'Example Care Plan', cli: 'kp-cli', ...more });
  const stay = [
    carePlan('sam', '2024-04-08 stay', {
      date: '2024-04-08',
      end: '2024-04-11',
      type: 'institutional',
      provider: 'Sample Valley Hospital',
      npi: '0000000121',
      diagnoses: [DELIVERY],
      lines: [line(null, 'Room and board', '6100.00', { coinsurance: '300.00', paid: '2700.00', revenue: ['0120', 'Room and board, semi-private'] })],
    }),
    carePlan('sam', '2024-04-10 doctor', {
      date: '2024-04-10',
      provider: 'Example Hospital Doctors',
      npi: '0000000139',
      diagnoses: [DELIVERY],
      lines: [line('99231', 'Hospital visit', '210.00', { coinsurance: '10.00', paid: '90.00' })],
    }),
  ];
  const newborn = [
    carePlan('jamie', '2024-04-10', {
      date: '2024-04-10',
      provider: 'Example Pediatrics',
      npi: '0000000030',
      diagnoses: [['Z00.110', 'Health examination for newborn under 8 days old']],
      lines: [line('99460', 'Newborn care', '240.00', { paid: '150.00' })],
    }),
  ];
  const PEDS_DOCTOR = { clinician: 'Dr. Morgan Placeholder', npi: '0000000022', place: 'Example Pediatrics' };
  const peds = [
    encounter('jamie visit 2024-10-15', { ...PEDS_DOCTOR, start: '2024-10-15T14:00:00Z', cpt: '99391', type: 'Well child visit, 6 months' }),
    result('jamie peds', '2024-10-15', ['29463-7', 'Weight', 7.6, 'kg'], { category: 'Vital signs' }),
    vaccine('jamie', { date: '2024-10-15', cvx: '146', text: 'DTaP-IPV-Hib-HepB', performer: 'Example Pediatrics', route: 'Intramuscular' }),
  ];

  // ---- Robin's claims: what is alone, and what fits two visits ----

  const planClaim = (what, more) => claim(`robin plan ${what}`, { insurer: 'Example Health Plan', prints: ['submitted', 'eligible', 'benefit', 'deductible', 'coinsurance', 'owed'], ...more });
  const robinClaims = [
    // An emergency room's own claim, and no doctor's yet.
    planClaim('2026-02-14 er', {
      date: '2026-02-14',
      type: 'institutional',
      provider: 'Sample Valley Hospital',
      npi: '0000000121',
      lines: [line('99283', 'Emergency room visit', '1240.00', { deductible: '150.00', coinsurance: '62.00', paid: '248.00', revenue: ['0450', 'Emergency room'] })],
    }),
    // Two office visits on one day, and a lab's claim that fits either.
    planClaim('2026-06-16 clinic', { date: '2026-06-16', provider: 'Example Health', npi: '0000000063', lines: [line('99213', 'Office visit', '180.00', { coinsurance: '25.00', paid: '87.50' })] }),
    planClaim('2026-06-16 skin', { date: '2026-06-16', provider: 'Placeholder Skin Clinic', npi: '0000000147', lines: [line('99203', 'New patient visit', '230.00', { coinsurance: '30.00', paid: '105.00' })] }),
    planClaim('2026-06-16 lab', { date: '2026-06-16', provider: 'Example Lab', npi: '0000000071', lines: [line('80048', 'Basic metabolic panel', '90.00', { coinsurance: '6.00', paid: '24.00' })] }),
  ];
  const eob = paper('robin eob 2026-05-07', {
    date: '2026-05-21',
    kind: 'eob',
    title: 'Explanation of Benefits',
    media: 'application/pdf',
    bytes: pdf(['Explanation of Benefits', 'This is not a bill.', 'Example Counseling, 05/07/2026.', 'Amount billed $160.00.', 'Plan paid $96.00.', 'You may owe the provider $24.00.']),
  });
  // Private by its diagnosis, with the paper that explains it.
  const counseling = planClaim('2026-05-07 counseling', {
    date: '2026-05-07',
    provider: 'Example Counseling',
    npi: '0000000154',
    diagnoses: [['F41.1', 'Generalized anxiety disorder']],
    lines: [line('90834', 'Counseling, 45 minutes', '160.00', { coinsurance: '24.00', paid: '96.00' })],
    papers: [eob[0]],
  });

  // ---- Robin's chart, and a record system whose records are all of one area ----

  const DOCTOR = { clinician: 'Dr. Jordan Sample', npi: '0000000055' };
  const robinChart = [
    condition('robin worry', { since: '2025-11-06', code: 'F41.1', text: 'Generalized anxiety' }),
    order('robin sertraline', { date: '2025-11-06', med: { rxnorm: '312941', text: 'Sertraline 50 mg tablet' }, dosage: 'Take 1 tablet by mouth once a day', prescriber: DOCTOR.clinician, npi: DOCTOR.npi }),
    result('robin chart', '2026-01-15', ['21613-5', 'Chlamydia trachomatis DNA', 0, 'copies/mL']),
  ];
  const robinNotes = [
    encounter('robin counseling 2026-05-07', { start: '2026-05-07T17:00:00Z', end: '2026-05-07T17:45:00Z', type: 'Counseling visit', place: 'Example Counseling', clinician: 'Taylor Placeholder, LCSW' }),
    encounter('robin counseling 2026-08-06', { start: '2026-08-06T17:00:00Z', end: '2026-08-06T17:45:00Z', type: 'Counseling visit', place: 'Example Counseling', clinician: 'Taylor Placeholder, LCSW' }),
    // An older result of a test whose newest is not private.
    result('robin notes', '2024-09-10', ['2823-3', 'Potassium', 4.2, 'mmol/L', '3.5-5.1 mmol/L', 'Normal']),
  ];
  const robinShared = [encounter('robin skin 2026-03-17', { start: '2026-03-17T15:00:00Z', end: '2026-03-17T15:20:00Z', type: 'Office visit', place: 'Placeholder Skin Clinic', clinician: 'Dr. Riley Placeholder', npi: '0000000162' })];

  // ---- Papers and images kept by hand ----

  const papers = [
    { file: 'Letter from Example Counseling.pdf', type: 'letter', date: '2026-08-10', org: 'Example Counseling', bytes: pdf(['Letter', 'Example Counseling, 08/10/2026.', 'Appointments continue every three months.']) },
    { file: 'Wrist report.pdf', type: 'imaging_report', date: '2025-07-08', org: 'Example Imaging', bytes: pdf(['X-ray of the left wrist', 'Example Imaging, 07/08/2025.', 'No fracture.']) },
    { file: 'Ultrasound report.pdf', type: 'imaging_report', date: '2025-12-03', org: 'Example Sexual Health Clinic', bytes: pdf(['Ultrasound', 'Example Sexual Health Clinic, 12/03/2025.', 'Both sides normal.']) },
  ];
  const study = (n, date, description, bodyPart) =>
    ['AP', 'Lateral'].map((view, i) => ({
      file: `IMG${i + 1}.dcm`,
      bytes: image({
        study: `2.25.40000000000000000000000000000000${n}`,
        series: `2.25.5000000000000000000000000000000${n}${i + 1}`,
        instance: `2.25.6000000000000000000000000000000${n}${i + 1}`,
        person: 'Example^Robin',
        born: '1980-01-01',
        date,
        description,
        accession: `EX00${n}`,
        facility: 'Example Imaging',
        bodyPart,
        number: i + 1,
        view,
      }),
    }));
  const images = { wrist: study(1, '2025-07-08', 'WRIST LEFT', 'WRIST'), ultrasound: study(2, '2025-12-03', 'PELVIS', 'PELVIS') };

  // ---- Casey's sources ----

  const visit = (n, date, place) => encounter(`casey visit ${n}`, { start: `${date}T15:00:00Z`, end: `${date}T15:30:00Z`, type: 'Office visit', place, clinician: 'Dr. Riley Placeholder', npi: '0000000162' });
  const caseyFirst = [visit(1, '2025-03-04', 'Example Walk-in Clinic'), condition('casey sneezes', { since: '2020-05-01', code: 'J30.2', text: 'Seasonal allergies' })];
  const caseySecond = [visit(2, '2025-04-08', 'Sample Eye Center')];
  const caseyFirstLater = [...caseyFirst, visit(3, '2025-05-13', 'Example Walk-in Clinic')];
  const caseySecondLater = [...caseySecond, visit(4, '2025-06-17', 'Sample Eye Center')];
  const caseyNoName = [visit(5, '2025-07-22', 'Example Clinic'), allergy('casey latex', { since: '2015-02-01', code: '300916003', text: 'Latex', criticality: 'low', reactions: ['Itching'] })];

  return { people, sources, stay, newborn, peds, robinClaims: [...robinClaims, counseling, ...eob], robinChart, robinNotes, robinShared, papers, images, caseyFirst, caseySecond, caseyFirstLater, caseySecondLater, caseyNoName, rid };
}
