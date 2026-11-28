// Kept equal to package.json's version by test/version.test.ts.
export const VERSION = '0.1.0';

/**
 * The medrec release whose data contract this connector follows: it reads
 * views whose `reader` (views.json) is this one or older, and GET /version
 * says it.
 */
export const MEDREC_CONTRACT = '0.9.12';

/**
 * The oldest medrec contract a reader must follow to read the views this
 * connector's own script writes (their `reader`): what medrec of the contract
 * above writes in its own. What is newer in its views is in files and fields
 * a reader of this one does not read.
 */
export const VIEWS_READER = '0.9.11';
