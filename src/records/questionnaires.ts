// Which names and codes are of a questionnaire that a grown person answers of
// themselves, as medrec's src/questionnaires.rs tells them (medrec-cli
// docs/data-contract.md, "Questionnaires"). medrec judges what is private, and
// its views leave out what is about another person; this is for a person whose
// files are read whole, without views.

import type { Coding } from './model';

const LOINC = 'http://loinc.org';

/** The first that a name has the words of says whether a grown person answers it, rather than whoever's chart it is in. */
const NAMES: readonly (readonly [words: string, grown: boolean])[] = [
  [
    "edinburgh (?:post\\S*|depression|scale|score|total|screen\\w*)|epds|(?:post-?natal|post-?partum|perinatal|peripartum|antenatal|maternal|paternal|parental|caregiver|mother(?:'?s)?|father(?:'?s)?|parent(?:'?s)?) (?:depress\\w*|anxiety|mood|mental health)",
    true,
  ],
  // Those made for children, before the words they share with others.
  ["ces-?dc|children'?s depression|child depression|depression self-rating scale for children", false],
  ["(?:child(?:ren)?|childhood|pediatric|adolescent)(?:'?s)? anxiety|preschool anxiety|rcads|spence", false],
  ['suicid\\w*|c-?ssrs|columbia[\\- ]suicide|self[\\- ](?:harm\\w*|injur\\w*)', false],
  [
    'gad[\\- ]?[27]|generali[sz]ed anxiety|beck anxiety|hamilton anxiety|ham-a|hospital anxiety|control(?:ling)? worrying|worrying too much|nervous,? anxious|trouble relaxing|afraid as if something awful|so restless|easily annoyed or irritable',
    true,
  ],
  [
    'phq(?:[\\- ]?\\d{1,2}[am]?|[\\- ]a)?|patient health questionnaire|(?:beck|hamilton|geriatric|zung|montgomery)\\W+(?:\\S+ )?depression|ham-d|hdrs|madrs|qids(?:-sr)?|ces-?d(?:-?r)?|epidemiologic(?:al)? studies depression|little interest or pleasure|feeling down|feeling bad about (?:yourself|myself)|trouble falling or staying asleep|poor appetite or overeating|feeling tired or having little energy|better off dead|hurting (?:yourself|myself|themsel\\w+)|trouble concentrating on things|moving or speaking so slowly|how difficult have these problems',
    true,
  ],
  [
    '^depression$|depression[,:]? (?:and \\w+ )?(?:screen\\w*|scale|score|severity|inventory|questionnaire|assessment|risk|index|survey|interpretation|total|status|panel|symptoms?)|(?:screen\\w*|scale|score|questionnaire|assessment|survey)[,:]? (?:for |of )?(?:\\w+ )?depression|depressive (?:symptoms?|disorder|episode)|(?:major|clinical) depression|depressed mood',
    true,
  ],
  [
    'audit[\\- ]?c|audit[\\- ](?:total|score|questionnaire|10)|alcohol use disorders? identification|cage(?:-aid|[\\- ]questionnaire|[\\- ]score)|alcohol(?:ic)? (?:screening|use|misuse|abuse|intake|consumption|dependence|risk)|drinks? containing alcohol|alcoholic (?:drinks?|beverages?)|drinks (?:on a typical|per (?:day|week|occasion))|(?:six|five|four) or more drinks|binge drink\\w*',
    true,
  ],
  [
    'dast(?:[\\- ]?(?:10|20|a))?|crafft|cudit(?:-r)?|(?:drug|substance) (?:use|misuse)|substance abuse|drug abuse (?:screening test|questionnaire)|(?:illicit|recreational|street) drugs?|(?:cannabis|marijuana|opioid) (?:use|misuse)|opioid risk tool',
    true,
  ],
  [
    'tobacco|smok(?:e|er|ers|ing|ed|es|eless)|cigarettes?|e-?cig(?:arettes?|s)?|cigars?|vap(?:e|es|ed|ing)|nicotine|cotinine|pack[\\- ]years?|packs? (?:per|a|/) ?day|fagerstr[oö]m',
    false,
  ],
  ['anxiety|panic (?:disorder|attacks?)', false],
  [
    'pcl-?5|(?:pc-)?ptsd|post-?traumatic stress|mood disorder|mdq|bipolar|young mania|y-?bocs|obsessive[\\- ]compulsive|eating disorders?|scoff|psychosis|prodromal questionnaire|adhd|attention[\\- ]deficit|vanderbilt|asrs|conners|pediatric symptom checklist|psc-?(?:17|35)|strengths and difficulties|mental health|behaviou?ral health|psychiatric|psychological',
    false,
  ],
];

/** LOINC codes of the questionnaires and of what they ask, by whether a grown person answers them. */
const CODES: ReadonlyMap<string, boolean> = new Map([
  ...[
    // Postnatal depression.
    '71354-5', '71348-7', '71349-5', '71350-3', '71351-1', '71352-9', '71353-7',
    // Depression.
    '44249-1', '44250-9', '44251-7', '44252-5', '44253-3', '44254-1', '44255-8', '44258-2', '44259-0', '44260-8', '44261-6', '55757-9', '55758-7', '69724-3', '89204-2',
    // Anxiety.
    '69737-5', '70274-6', '69725-0', '68509-9', '69733-4', '69734-2', '69735-9', '69689-8', '69736-7',
    // Alcohol use.
    '72109-2', '75626-2', '72110-0', '75624-7', '68518-0', '68519-8', '68520-6',
  ].map((c) => [c, true] as const),
  // Suicide risk; tobacco use.
  ...['93373-9', '72166-2', '11367-0'].map((c) => [c, false] as const),
]);

// The patterns are of ASCII and `ö`, so that they compile in little of a
// request's CPU: a name is read with every other character as one of four that
// match as it does in medrec, whose patterns are of Unicode.
const DIGIT = '\x01';
const MARK = '\x02';
const W = `0-9A-Za-z_\\xf6${DIGIT}`;
const EDGE = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;

const lazy = <T>(make: () => T) => {
  let made: T | undefined;
  return () => (made ??= make());
};
const PATTERNS = NAMES.map(([words, grown]) => {
  const own = words.replaceAll('\\w', `[${W}]`).replaceAll('\\W', `[^${W}]`).replaceAll('\\d', `[0-9${DIGIT}]`);
  return [lazy(() => new RegExp(`${EDGE}(?:${own})${EDGE}`, 'i')), grown] as const;
});

/** What a name with the words of any has one of, in small letters. Most names have none, and no pattern is made for them. */
const STEMS = [
  'edinburgh', 'epds', 'natal', 'partum', 'matern', 'patern', 'caregiver', 'mother', 'father', 'parent', 'ces', 'child', 'depress', 'anxiety', 'rcads', 'spence', 'suicid', 'ssrs', 'columbia', 'self',
  'gad', 'ham-', 'worrying', 'nervous', 'relaxing', 'afraid', 'restless', 'annoyed', 'phq', 'patient health', 'hdrs', 'madrs', 'qids', 'little interest', 'feeling', 'falling', 'appetite', 'better off dead',
  'hurting', 'concentrating', 'moving or', 'how difficult', 'audit', 'alcohol', 'cage', 'drink', 'dast', 'crafft', 'cudit', 'drug', 'substance', 'cannabis', 'marijuana', 'opioid', 'tobacco', 'smok', 'cig',
  'vap', 'nicotine', 'cotinine', 'pack', 'fagerstr', 'panic', 'pcl', 'ptsd', 'traumatic', 'mood', 'mdq', 'bipolar', 'mania', 'bocs', 'obsessive', 'eating dis', 'scoff', 'psycho', 'psychiatric', 'prodromal',
  'adhd', 'attention', 'vanderbilt', 'asrs', 'conners', 'pediatric', 'psc', 'strengths', 'mental health', 'behavio',
];

/** A character that is not ASCII, as the patterns read it. */
function read(c: string): string {
  if (c === 'ö' || c === 'Ö') return 'ö';
  // These two are a letter's other case.
  if (c === '\u017f') return 's';
  if (c === '\u212a') return 'k';
  if (/\p{Nd}/u.test(c)) return DIGIT;
  if (/[\p{Alphabetic}\p{M}\p{Pc}\p{Join_Control}]/u.test(c)) return '_';
  return /\p{White_Space}/u.test(c) ? '\t' : MARK;
}

/** Whether the first of the patterns that a name has the words of is of a questionnaire a grown person answers; undefined when it has none's. */
function byName(name: string): boolean | undefined {
  const plain = name.replace(/[^\x00-\x7f]/gu, read).toLowerCase();
  return STEMS.some((x) => plain.includes(x)) ? PATTERNS.find(([re]) => re().test(plain))?.[1] : undefined;
}

/**
 * Whether it is of a questionnaire a grown person answers of themselves, by its
 * code, else by its name or the code's. `seen` keeps what the names of one
 * person's items were found to be, as many share one.
 */
export function grownAnswers(name: string, code?: Coding | null, seen = new Map<string, boolean | undefined>()): boolean {
  const coded = code?.system === LOINC && typeof code.code === 'string' ? CODES.get(code.code) : undefined;
  if (coded !== undefined) return coded;
  for (const n of [name, code?.display]) {
    if (typeof n !== 'string') continue;
    if (!seen.has(n)) seen.set(n, byName(n));
    const found = seen.get(n);
    if (found !== undefined) return found;
  }
  return false;
}
