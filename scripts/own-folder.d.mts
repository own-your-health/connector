export type Own = 'words' | 'errors' | 'given';
export const OWN: readonly Own[];
/** Writes the folder of test/fixtures/<name> to `out` and returns `out`. */
export function ownFolder(name: Own, out: string, options?: { views?: boolean }): string;
