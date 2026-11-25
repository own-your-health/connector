// Who a printed provider is (medrec 0.9.7 and later): the labels of what a
// person's items print, from their providers.json, ported from medrec's
// src/provider_labels.rs. A label stands beside the source's own words, in a
// list of its own, and nothing is found, sorted or filtered by one. What an
// answer about the whole household may not say is not in it. medrec-cli
// docs/data-contract.md, "Provider labels".

import type { Json, JsonObject } from './model';
import { isObject } from './numbers';

export const PROVIDERS_SCHEMA = 'medrec-providers/v1';

/** The fields of a record that print a provider, in the order they are shown. */
const FIELDS = ['provider', 'practitioner', 'performer', 'prescriber', 'service_provider', 'facility', 'location', 'pharmacy'] as const;

/** What is printed in an item, to look its label up by. */
export interface Printed {
  field: (typeof FIELDS)[number] | 'organization' | 'place' | 'clinicians' | 'members';
  /** Its words. Only a claim's provider may have none, where a reader shows the claim without its fields. */
  text?: string;
  /** The event member that prints it, when the item itself does not. */
  member?: string;
  /** Whether the item says it by itself, so that the label does not have to. */
  shown: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);

/** Each provider a record's fields print. */
export function printedOfRecord(fields: JsonObject | null | undefined): Printed[] {
  return FIELDS.flatMap((field) => {
    const text = str(fields?.[field]);
    return text === undefined ? [] : [{ field, text, shown: true }];
  });
}

/** A claim's provider, in a row that has no fields: its title says it with the rest. */
export function printedOfClaim(fields: JsonObject | null | undefined): Printed[] {
  const text = str(fields?.provider);
  return text === undefined ? [] : [{ field: 'provider', text, shown: false }];
}

/** The same of a claim whose fields are not at hand. */
export const CLAIM_PROVIDER: readonly Printed[] = [{ field: 'provider', shown: false }];

export function printedOfDocument(organization: string | null | undefined): Printed[] {
  return typeof organization === 'string' ? [{ field: 'organization', text: organization, shown: true }] : [];
}

/** An event's place and clinicians, and in full what its own members print. */
export function printedOfEvent(e: JsonObject, full: boolean): Printed[] {
  const out: Printed[] = [];
  const place = str(e.place);
  if (place !== undefined) out.push({ field: 'place', text: place, shown: true });
  for (const c of list(e.clinicians)) if (typeof c === 'string') out.push({ field: 'clinicians', text: c, shown: true });
  if (full) {
    for (const m of list(e.members)) {
      if (!isObject(m) || m.person !== undefined) continue;
      const [member, text] = [str(m.record), str(m.provider)];
      if (member !== undefined && text !== undefined) out.push({ field: 'members', text, member, shown: true });
    }
  }
  return out;
}

/** What an answer may say. */
export interface Asked {
  /** About the whole household, rather than one person. */
  whole: boolean;
  /** Whether an item is private. */
  isPrivate(id: string): boolean;
  /** Whether an item stays out of an answer about the whole household that does not name it. */
  heldBack(id: string): boolean;
}

/** providers.json as a reader needs it (medrec-providers/v1); `private` holds what only private items say. */
export type ProvidersView = { person?: unknown; private?: unknown } & PartView;
type PartView = Partial<Record<'labels' | 'by_name' | 'by_item' | 'claims' | 'overrides', unknown>>;

const object = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A value by a key a source printed, which may be the name of something every object has. */
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

class Part {
  private readonly labels: Record<string, unknown>;
  private readonly byName: Record<string, unknown>;
  private readonly byItem: Record<string, unknown>;
  private readonly claims: Record<string, unknown>;
  /** The ids of what the household said. */
  readonly said: ReadonlySet<unknown>;

  constructor(v: PartView) {
    this.labels = object(v.labels);
    this.byName = object(v.by_name);
    this.byItem = object(v.by_item);
    this.claims = object(v.claims);
    this.said = new Set(Array.isArray(v.overrides) ? v.overrides.map((o) => object(o).id) : []);
  }

  id(item: string, p: Printed): string | undefined {
    if (p.text === undefined) return str(own(this.claims, item));
    return str(own(object(own(this.byItem, item)), p.text)) ?? str(own(this.byName, p.text));
  }

  label(id: string): Record<string, unknown> | undefined {
    const l = own(this.labels, id);
    return typeof l === 'object' && l !== null && !Array.isArray(l) ? (l as Record<string, unknown>) : undefined;
  }
}

/** One person's labels. */
export class ProviderLabels {
  private readonly open: Part;
  private readonly priv: Part;

  constructor(v: ProvidersView) {
    this.open = new Part(v);
    this.priv = new Part(object(v.private));
  }

  /** The labels of what an item prints, as an answer shows them. Two that print the same and have one label are one. */
  shown(item: string, printed: readonly Printed[], asked: Asked): JsonObject[] {
    const hides = (id: string) => asked.whole && asked.heldBack(id);
    if (hides(item)) return [];
    const had = new Set<string>();
    const out: JsonObject[] = [];
    for (const p of printed) {
      const at = p.member ?? item;
      if (hides(at)) continue;
      const part = asked.isPrivate(at) ? this.priv : this.open;
      const id = part.id(at, p);
      const label = id === undefined ? undefined : (part.label(id) ?? this.open.label(id));
      if (label === undefined) continue;
      const key = `${id}\0${p.text ?? ''}`;
      if (had.has(key)) continue;
      had.add(key);
      const entry = this.entry(p, label, asked.whole, hides);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** None for a likely one whose every reason is one the answer may not give. */
  private entry(p: Printed, label: Record<string, unknown>, whole: boolean, hides: (id: string) => boolean): JsonObject | undefined {
    // What gave it: with the ids the answer may not give, none.
    const from = (v: Record<string, unknown>, keys: readonly string[]): JsonObject | undefined => {
      const kind = str(v.from);
      if (kind === undefined) return undefined;
      if (kind === 'paper') {
        const d = str(v.document);
        if (d === undefined || hides(d)) return undefined;
      } else if (kind === 'household') {
        const id = str(v.id);
        if (id === undefined || !(this.open.said.has(id) || (!whole && this.priv.said.has(id)))) return undefined;
      }
      const out: JsonObject = { from: kind };
      for (const k of keys) if (typeof v[k] === 'string') out[k] = v[k];
      return out;
    };
    // One a later medrec knows has no words here.
    const evidence = (Array.isArray(label.evidence) ? label.evidence : []).flatMap((e) => {
      const v = object(e);
      return from(v, EVIDENCE.get(v.from) ?? []) ?? [];
    });
    // One medrec does not know is likely.
    const confidence = label.confidence === 'household' || label.confidence === 'sure' ? label.confidence : 'likely';
    if (confidence === 'likely' && evidence.length === 0) return undefined;
    const out: JsonObject = { field: p.field };
    if (p.member !== undefined) out.record = p.member;
    if (p.shown && p.text !== undefined) out.printed = p.text;
    for (const k of ['name', 'practice', 'role']) if (typeof label[k] === 'string') out[k] = label[k];
    // A phone is shown with where it is from, or not at all.
    const phone = str(label.phone);
    const v = object(label.phone_from);
    const keys = PHONE_FROM.get(v.from);
    const whence = keys && from(v, keys);
    if (phone !== undefined && whence) {
      out.phone = phone;
      out.phone_from = whence;
    }
    out.confidence = confidence;
    out.evidence = evidence;
    return out;
  }
}

/** What each kind of evidence, and of where a phone is from, says beside its `from`. */
const EVIDENCE: ReadonlyMap<unknown, readonly string[]> = new Map([
  ['only_match', ['state']],
  ['paper', ['document']],
  ['household', ['id', 'by', 'at']],
]);
const PHONE_FROM: ReadonlyMap<unknown, readonly string[]> = new Map([
  ['directory', ['date']],
  ['paper', ['document']],
  ['household', ['id']],
]);

export const NO_LABELS = new ProviderLabels({});

export function providerLabelsOf(view: ProvidersView, person: string): ProviderLabels {
  return view.person === person ? new ProviderLabels(view) : NO_LABELS;
}
