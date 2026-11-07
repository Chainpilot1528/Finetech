import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().url(),
  APP_DATABASE_URL: z.string().min(1),
  AUTH_DATABASE_URL: z.string().min(1),
  OPS_DATABASE_URL: z.string().min(1),
  /** Local encrypted file storage. Refused in production, which needs real object storage. */
  STORAGE_DIR: z.string().default('.dev/storage'),
  /** 32 random bytes, base64. Encrypts MFA secrets. */
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes in base64'),
  /** Keys tokens, CSRF values and email lookups. */
  HMAC_KEY: z.string().min(32),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Vittora <no-reply@vittora.local>'),
  DEV_MAILBOX: z.enum(['true', 'false']).default('false'),
  BREACHED_PASSWORD_CHECK: z.enum(['true', 'false']).default('true'),
});

export type Config = z.infer<typeof schema>;

/** Validates settings at boot, so a bad deploy stops here and not at 2 a.m. (§14.12). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${fields}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DEV_MAILBOX === 'true') {
    throw new Error('Invalid configuration: DEV_MAILBOX must be off in production');
  }
  if (parsed.data.NODE_ENV === 'production') {
    throw new Error('Invalid configuration: production needs real object storage, a virus scanner and an SMS provider');
  }
  return parsed.data;
}
