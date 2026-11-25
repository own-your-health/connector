// A value as a list says it, ported from medrec (src/views.rs, `value_text`).

import type { Json, JsonObject } from './model';
import { isExact } from './numbers';
import { trim } from './text';

/** Of a quantity, `<` and the like, as its source gives it (medrec 0.9.10 and later). */
export const than = (v: JsonObject) => (typeof v.comparator === 'string' ? v.comparator : '');

export function valueText(v: Json | undefined): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isExact(v)) return v.rawJSON;
  if (Array.isArray(v)) return v.map(valueText).join('; ');
  // As serde_json's `get(..).or_else(..)`: a key present with null does not fall through.
  const num = than(v) + valueText('value' in v ? v.value : v.amount);
  const u = 'unit' in v ? v.unit : v.currency;
  const unit = typeof u === 'string' ? u : '';
  return trim(`${num} ${unit}`);
}
