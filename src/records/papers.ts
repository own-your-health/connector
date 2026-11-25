// A person's papers without some of them.

/** A statement whose first paper is gone is its next copy's. */
export function withoutPapers<T extends { id: string; same_statement_as?: string | null }>(papers: readonly T[], gone: ReadonlySet<string>): T[] {
  const first = new Map<string, string>();
  return papers
    .filter((d) => !gone.has(d.id))
    .map((d) => {
      const of = d.same_statement_as;
      if (of == null || !gone.has(of)) return d;
      const copy = first.get(of);
      if (copy === undefined) first.set(of, d.id);
      return { ...d, same_statement_as: copy };
    });
}
