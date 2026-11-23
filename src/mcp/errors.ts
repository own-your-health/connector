// Tool errors worded as the next step for the model, as cli-common's
// pk-cli-mcp words them (crates/pk-cli-mcp/src/error.rs), so this connector
// and `medrec mcp` fail the same way.

export type ErrorKind = 'usage' | 'auth' | 'not_found' | 'upstream' | 'other';

/** How this server is reached, for the standard remedies. */
export interface ServerInfo {
  /** What the model asks of the user when the Google sign-in has ended. */
  signIn: string;
}

export class ToolError extends Error {
  private constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }

  static usage(message: string): ToolError {
    return new ToolError('usage', message);
  }
  static auth(message: string): ToolError {
    return new ToolError('auth', message);
  }
  static notFound(message: string): ToolError {
    return new ToolError('not_found', message);
  }
  static upstream(message: string): ToolError {
    return new ToolError('upstream', message);
  }
  static other(message: string): ToolError {
    return new ToolError('other', message);
  }

  withFix(fix: string): ToolError {
    return new ToolError(this.kind, this.message, fix);
  }

  render(server: ServerInfo): string {
    return `${this.kind}: ${sentence(this.message)} ${sentence(this.fix ?? standardFix(this.kind, server))}`;
  }
}

function standardFix(kind: ErrorKind, server: ServerInfo): string {
  switch (kind) {
    case 'usage':
      return 'Fix the arguments as described and call the tool again';
    case 'auth':
      return `${capitalized(server.signIn)}, then call the tool again. Tools never sign in or create credentials themselves`;
    case 'not_found':
      return 'Check the name or id against what the list tool returns, then call again';
    case 'upstream':
      return 'The provider failed or is limiting requests; the arguments are not the problem. Try again in a minute';
    case 'other':
      return 'If it persists, tell the user what failed';
  }
}

function capitalized(s: string): string {
  const t = s.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : '';
}

function sentence(s: string): string {
  const t = s.trim();
  return /[.?!]$/.test(t) ? t : `${t}.`;
}
