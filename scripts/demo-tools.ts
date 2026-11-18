/**
 * Which Cloudflare tunnel program to download for `pnpm demo:tunnel` (D-031, D-033).
 * Macs get a .tgz archive; Linux (for example a GitHub codespace) gets the program file itself.
 */
export function cloudflaredAsset(platform: string, cpu: string): { url: string; archive: boolean } {
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
  const arch = cpu === 'arm64' ? 'arm64' : 'amd64';
  if (platform === 'darwin') return { url: `${base}cloudflared-darwin-${arch}.tgz`, archive: true };
  if (platform === 'linux') return { url: `${base}cloudflared-linux-${arch}`, archive: false };
  throw new Error('pnpm demo:tunnel runs on macOS or Linux (for example a GitHub codespace).');
}
