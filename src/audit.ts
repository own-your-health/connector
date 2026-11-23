// Who used the connector, and how: the time, the Google account, the grant
// (one connection of one assistant), the assistant's name, and the tool or
// event. Never a tool's arguments or its result: a search's words or a
// document's id would say what was asked about.

export interface AuditRow {
  account: string;
  grant: string;
  client: string;
  /** A tool's name, or an event: `connect` (a new connection), `refused` (an account not admitted), `google-ended` (Google's sign-in revoked). */
  event: string;
  ok: boolean;
}

/** Rows older than this are deleted by the daily cron. */
export const KEEP_DAYS = 400;

// D1's exec() takes one statement per line.
const SCHEMA = 'CREATE TABLE IF NOT EXISTS audit (at TEXT NOT NULL, account TEXT NOT NULL, grant_id TEXT NOT NULL, client TEXT NOT NULL, event TEXT NOT NULL, ok INTEGER NOT NULL);\nCREATE INDEX IF NOT EXISTS audit_at ON audit (at)';

/** The table, made by the Worker itself the first time an isolate writes: a deploy needs no migration step. */
const ready = new WeakMap<D1Database, Promise<unknown>>();
function schema(db: D1Database): Promise<unknown> {
  let p = ready.get(db);
  if (!p) {
    p = db.exec(SCHEMA);
    p.catch(() => ready.delete(db));
    ready.set(db, p);
  }
  return p;
}

export async function audit(db: D1Database | undefined, row: AuditRow, at = new Date()): Promise<void> {
  if (!db) return;
  try {
    await schema(db);
    await db
      .prepare('INSERT INTO audit (at, account, grant_id, client, event, ok) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(at.toISOString(), row.account, row.grant, row.client.slice(0, 120), row.event, row.ok ? 1 : 0)
      .run();
  } catch {
    // An audit write that fails never fails the call; the error could only say which row.
    console.error('audit: write failed');
  }
}

export async function pruneAudit(db: D1Database | undefined, now = new Date()): Promise<void> {
  if (!db) return;
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString();
  await schema(db);
  await db.prepare('DELETE FROM audit WHERE at < ?').bind(cutoff).run();
}
