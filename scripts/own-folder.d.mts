export type Own = 'words' | 'errors' | 'given' | 'questionnaires' | 'child' | 'parts' | 'vaccines' | 'fills' | 'papers' | 'schedule';
export const OWN: readonly Own[];
/** The fixtures whose files a folder holds: test/fixtures/<this>. */
export function filesOf(name: Own): string;
/** Those read by a medrec that keeps the invented vaccine schedule of medrec's tests. */
export const TABLED: readonly Own[];
/** Writes the folder of test/fixtures/<name> to `out` and returns `out`. */
export function ownFolder(name: Own, out: string, options?: { views?: boolean }): string;
