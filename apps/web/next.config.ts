import type { NextConfig } from 'next';

const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';

const config: NextConfig = {
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  transpilePackages: ['@vittora/product-schemas'],
  // The browser only ever talks to this origin, so the session cookie stays first-party.
  rewrites: async () => [{ source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` }],
};

export default config;
