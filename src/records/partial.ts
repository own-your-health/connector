// Answers to a question about everyone that leave out a person whose records
// cannot be read right now (the Store's personUnavailable errors), and the
// `warnings` that say so: pk-cli-mcp's page field, which medrec 0.7.0's
// search and records carry.

import { ToolError } from '../mcp/errors';
import type { Person } from './model';

/** A list's note on rows it may lack, as pk-cli-mcp's `warnings` carry it. */
export interface Warning {
  code: string;
  message: string;
}

/** The warning code for a person whose records cannot be read right now. */
export const PERSON_UNAVAILABLE = 'person-unavailable';

/**
 * Who a question about everyone answers without. A person whose records
 * cannot be read right now (ToolError.unavailable) is left out with a
 * warning, unless no one can be read; then the first such error is the
 * answer. A question about one named person (`tolerant` false) gets the
 * error itself.
 */
export class LeftOut {
  /** Each person left out: why, and whether some of their rows made the list. */
  private readonly left = new Map<string, { e: ToolError; some: boolean }>();

  constructor(private readonly tolerant: boolean) {}

  /** `f`'s answer for the person, or `none` when they are left out. */
  readonly of = async <T>(p: Person, f: () => Promise<T>, none: T): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      this.leave(p, e, false);
      return none;
    }
  };

  /** The person's rows, ending where they cannot be read. */
  async *rows<T>(p: Person, xs: AsyncIterable<T>): AsyncIterable<T> {
    let some = false;
    try {
      for await (const x of xs) {
        some = true;
        yield x;
      }
    } catch (e) {
      this.leave(p, e, some);
    }
  }

  /** Leaves out the person `e` says cannot be read, when one of `people` and the question allows; false otherwise. */
  take(e: unknown, people: Person[]): boolean {
    const p = e instanceof ToolError && e.unavailable !== undefined ? people.find((x) => x.id === e.unavailable) : undefined;
    if (!p || !this.tolerant) return false;
    this.left.set(p.id, { e: e as ToolError, some: this.left.get(p.id)?.some ?? false });
    return true;
  }

  /** The people left out so far, by id, in the order they were. */
  ids(): string[] {
    return [...this.left.keys()];
  }

  private leave(p: Person, e: unknown, some: boolean): void {
    if (!this.tolerant || !(e instanceof ToolError && e.unavailable === p.id)) throw e;
    this.left.set(p.id, { e, some });
  }

  /**
   * The warnings, in household order, once every person has been asked. When
   * everyone was left out, the first person's error instead.
   */
  done(people: Person[]): Warning[] {
    const left = people.filter((p) => this.left.has(p.id)).map((p) => this.left.get(p.id)!);
    if (left.length > 0 && left.length === people.length) throw left[0]!.e;
    return left.map(({ e, some }) => ({
      code: PERSON_UNAVAILABLE,
      message: `${e.message.replace(/[.]$/, '')}; ${some ? 'some of them are' : 'they are'} missing from this list.${e.fix ? ` ${e.fix}.` : ''}`,
    }));
  }
}

