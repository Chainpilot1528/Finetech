/** A failure the API can explain to the caller, with a stable machine code (§14.6). */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    /** Field-level problems, safe to show to the caller. */
    readonly errors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
