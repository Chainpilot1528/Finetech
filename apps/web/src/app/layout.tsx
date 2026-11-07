import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = { title: 'Vittora Partner Portal' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers(); // render per request, so Next applies the CSP nonce to its scripts
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
