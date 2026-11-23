// List paging as cli-common's pk-cli-mcp does it (crates/pk-cli-mcp/src/
// shape.rs): `limit` 1 to 200 (default 25), opaque cursors counted in rows
// and bound to the call's filters, and a page cut to stay under a size
// budget, with a hint on how to narrow. Cursors are byte-for-byte the ones
// `medrec mcp` issues.

import { ToolError } from './errors';

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;
/** Characters of compact JSON a list page stays under. */
export const SIZE_BUDGET = 32_000;
/** Characters of compact JSON no result may exceed. */
export const HARD_LIMIT = 64_000;
/** Of a page's budget, what is kept for everything beside `items`. */
export const ENVELOPE_RESERVE = 1_500;

const CURSOR_VERSION = 'c1';
const MAX_OFFSET = 10_000_000;
const MAX_CURSOR_CHARS = (1_024 + 64) * 2;

export interface ListArgs {
  limit?: number;
  cursor?: string;
  response_format?: 'concise' | 'detailed';
}

export interface Page<T> {
  items: T[];
  returned: number;
  next_cursor?: string;
  truncated?: boolean;
  hint?: string;
}

const encoder = new TextEncoder();

/** Characters, as the hosts count them: code points. */
export function chars(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}

function fnv1a(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h;
}

const hex16 = (n: bigint) => n.toString(16).padStart(16, '0');

function toHex(s: string): string {
  return [...encoder.encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(s: string): string | null {
  if (s.length % 2 !== 0 || s.length > MAX_CURSOR_CHARS || !/^[0-9a-fA-F]*$/.test(s)) return null;
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

const foreignCursor = () =>
  ToolError.usage(
    "cursor is not one this tool returned; pass a result's next_cursor exactly as received, or omit cursor to start from the first page",
  );

export class PageRequest {
  private constructor(
    readonly limit: number,
    readonly offset: number,
    private readonly fingerprint: bigint,
    private readonly budget: number,
  ) {}

  /**
   * `filters` is every argument that selects records, in the order the tool
   * declares them, absent ones as null: its compact JSON binds the cursor.
   */
  static create(args: ListArgs, filters: Record<string, unknown>, budget = SIZE_BUDGET): PageRequest {
    const limit = args.limit ?? DEFAULT_LIMIT;
    if (!(limit >= 1 && limit <= MAX_LIMIT)) throw ToolError.usage(`limit must be between 1 and ${MAX_LIMIT}; got ${limit}`);
    const fingerprint = fnv1a(encoder.encode(JSON.stringify(filters)));
    let offset = 0;
    const c = args.cursor?.trim();
    if (c) {
      const plain = fromHex(c);
      const parts = plain?.split(':');
      if (!plain || !parts || parts[0] !== CURSOR_VERSION) {
        // `c2` and `c3` cursors are other tools' kinds; neither is issued here.
        throw foreignCursor();
      }
      const rest = plain.slice(CURSOR_VERSION.length + 1);
      const sep = rest.indexOf(':');
      if (sep === -1) throw foreignCursor();
      const off = rest.slice(0, sep);
      const fp = rest.slice(sep + 1);
      if (!/^\+?\d+$/.test(off) || !/^[0-9a-fA-F]{1,16}$/.test(fp)) throw foreignCursor();
      offset = Number(off);
      if (offset > MAX_OFFSET) throw foreignCursor();
      if (BigInt(`0x${fp}`) !== fingerprint) {
        throw ToolError.usage(
          'cursor belongs to a query with different filters; repeat the filters of the call that returned it, or omit cursor to start over',
        );
      }
    }
    return new PageRequest(limit, offset, fingerprint, budget);
  }

  /** Matching rows a tool must find, counted from the first, to know whether more exist. */
  wanted(): number {
    return this.offset + this.limit + 1;
  }

  page<T>(matched: T[], narrow: string): Page<T> {
    const available = Math.max(0, matched.length - this.offset);
    const rows = matched.slice(this.offset, this.offset + this.limit);
    const itemBudget = Math.max(0, this.budget - ENVELOPE_RESERVE);
    const items: T[] = [];
    let used = 2;
    for (const item of rows) {
      const size = chars(JSON.stringify(item)) + 1;
      if (used + size > itemBudget) break;
      used += size;
      items.push(item);
    }
    const kept = items.length;
    if (kept === 0 && available > 0) {
      throw ToolError.usage(
        `a single record is larger than the ${this.budget}-character result budget; call again with response_format=concise, or narrow with ${narrow}`,
      );
    }
    const truncated = kept < Math.min(this.limit, available);
    const more = kept < available;
    const page: Page<T> = { items, returned: kept };
    if (more) page.next_cursor = toHex(`${CURSOR_VERSION}:${this.offset + kept}:${hex16(this.fingerprint)}`);
    if (truncated) page.truncated = true;
    if (truncated) {
      page.hint = `Stopped at ${kept} records to stay under the ${this.budget}-character result budget. Pass next_cursor as cursor for the rest, or narrow with ${narrow} or response_format=concise.`;
    } else if (more) {
      page.hint = `More records match: pass next_cursor as cursor for the next page, or narrow with ${narrow}.`;
    }
    return page;
  }
}
