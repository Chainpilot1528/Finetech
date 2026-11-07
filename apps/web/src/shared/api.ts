import type { paths } from '@vittora/api-contract';
import createClient, { type Middleware } from 'openapi-fetch';
import { t } from './messages';

let csrf: Promise<string> | undefined;

async function csrfToken(): Promise<string> {
  csrf ??= fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((b: { csrfToken: string }) => b.csrfToken);
  return csrf;
}

const addCsrf: Middleware = {
  async onRequest({ request }) {
    if (request.method !== 'GET') request.headers.set('x-csrf-token', await csrfToken());
    return request;
  },
};

/** Typed client generated from the OpenAPI contract, so screens can't drift from the API. */
export const api = createClient<paths>({ baseUrl: '/api/v1', credentials: 'same-origin' });
api.use(addCsrf);

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(t.errors[code] ?? t.common.genericError);
  }
}

/** Unwraps a response, turning a problem+json body into an ApiError with friendly text. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) {
    const code = (error as { code?: string } | undefined)?.code ?? 'UNKNOWN';
    throw new ApiError(response.status, code);
  }
  return data as T;
}
