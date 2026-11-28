// Kept equal to package.json's version by test/version.test.ts.
export const VERSION = '0.1.0';

/**
 * The medrec release whose data contract this connector follows: it reads
 * views whose `reader` (views.json) is this one or older, and GET /version
 * says it.
 */
export const MEDREC_CONTRACT = '0.9.11';
