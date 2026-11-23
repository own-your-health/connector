// `cloudflare:workers` for tests in Node: the OAuth provider imports
// WorkerEntrypoint only to recognise class-based handlers, which this Worker
// does not use.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: ExecutionContext,
    protected env: Env,
  ) {}
}
