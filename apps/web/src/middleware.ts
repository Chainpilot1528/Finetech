import { type NextRequest, NextResponse } from 'next/server';

/** Strict CSP with a per-request nonce: no inline scripts (§9.4). */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join('; ');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('referrer-policy', 'strict-origin');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

export const config = { matcher: [{ source: '/((?!api|_next/static|_next/image|favicon.ico).*)' }] };
