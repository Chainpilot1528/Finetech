import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Clock } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import { MAILER, type MailMessage, type Mailer } from '../modules/identity/ports/index.js';
import type { Config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import type { Db, Tx } from './db.js';
import type { DocumentStore } from './storage.js';
import { CLOCK, CONFIG, DB, DOCUMENT_STORE } from './tokens.js';

export const MAX_ATTEMPTS = 6;
const LEASE_SECONDS = 120;
const SEND_TIMEOUT_MS = 15_000;
/** A file younger than this may belong to an upload whose transaction is still running. */
const ORPHAN_GRACE_MS = 24 * 3_600_000;

export type OutboxItem =
  | { kind: 'mail'; topic: string; message: MailMessage }
  | { kind: 'delete_object'; topic: string; key: string };

/** Ids of items written in a transaction, to try delivering once it has committed. */
export type Pending = string[];

/**
 * Durable delivery for everything that must happen only after a change commits: emails, SMS and
 * file deletions (ARCH-02). Callers enqueue inside their transaction and call `deliver` after it.
 * Nothing is ever dropped silently: a failure is logged, retried with back-off, and after the last
 * attempt shows in `failures` (BUG-03).
 */
@Injectable()
export class Outbox implements OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
  ) {}

  async enqueue(tx: Tx, item: OutboxItem): Promise<string> {
    const id = uuid();
    const payload = item.kind === 'mail' ? item.message : { key: item.key };
    await tx.query(
      `INSERT INTO outbox (id, kind, topic, payload_enc, next_attempt_at, created_at) VALUES ($1,$2,$3,$4,$5,$5)`,
      [id, item.kind, item.topic, encrypt(this.config.ENCRYPTION_KEY, JSON.stringify(payload)), this.clock.now()],
    );
    return id;
  }

  mail(tx: Tx, topic: string, message: MailMessage) {
    return this.enqueue(tx, { kind: 'mail', topic, message });
  }

  deleteObject(tx: Tx, topic: string, key: string) {
    return this.enqueue(tx, { kind: 'delete_object', topic, key });
  }

  /** First attempt for items a request just committed. Never throws: failures wait for a retry. */
  async deliver(ids: Pending): Promise<void> {
    if (!ids.length) return;
    await this.run(ids, ids.length);
  }

  /** Delivers everything that is due. Called on a timer, and by tests. */
  async drain(limit = 50): Promise<number> {
    return this.run(null, limit);
  }

  private async run(ids: string[] | null, limit: number): Promise<number> {
    let claimed: { id: string; kind: string; topic: string; payload_enc: string; attempts: number }[];
    try {
      claimed = (await this.db.withOps((tx) =>
        tx.query('SELECT * FROM outbox_claim($1,$2,$3,$4)', [ids, limit, this.clock.now(), LEASE_SECONDS]),
      )).rows;
    } catch (err) {
      log('outbox_claim_failed', { error: code(err) });
      return 0;
    }
    for (const item of claimed) {
      let error: string | null = null;
      try {
        const payload = JSON.parse(decrypt(this.config.ENCRYPTION_KEY, item.payload_enc));
        if (item.kind === 'mail') await withTimeout(this.mailer.send(payload as MailMessage), SEND_TIMEOUT_MS);
        else await this.store.remove(payload.key);
      } catch (err) {
        error = code(err);
      }
      try {
        const { rows } = await this.db.withOps((tx) =>
          tx.query('SELECT outbox_finish($1,$2,$3,$4,$5) AS status', [item.id, !error, error, this.clock.now(), MAX_ATTEMPTS]),
        );
        if (error) log(rows[0].status === 'failed' ? 'outbox_gave_up' : 'outbox_retry', { id: item.id, topic: item.topic, attempt: item.attempts + 1, error });
      } catch (err) {
        log('outbox_finish_failed', { id: item.id, error: code(err) });
      }
    }
    return claimed.length;
  }

  /** Ids and error codes of items that ran out of attempts. */
  async failures(since: Date) {
    const { rows } = await this.db.withOps((tx) => tx.query('SELECT * FROM outbox_failures($1)', [since]));
    return rows;
  }

  /**
   * Removes stored files no row points to: left behind when an upload's transaction rolled back or
   * the process stopped between writing the file and committing (BUG-02). Local storage only.
   */
  async sweepOrphans(): Promise<string[]> {
    const root = resolve(this.config.STORAGE_DIR);
    const cutoff = this.clock.now().getTime() - ORPHAN_GRACE_MS;
    const candidates = listFiles(root).filter((f) => statSync(f).mtimeMs < cutoff).map((f) => relative(root, f));
    if (!candidates.length) return [];
    const { rows } = await this.db.withOps((tx) => tx.query('SELECT * FROM object_keys_in_use($1) AS key', [candidates]));
    const inUse = new Set(rows.map((r) => r.key as string));
    const orphans = candidates.filter((k) => !inUse.has(k));
    for (const key of orphans) await this.store.remove(key);
    if (orphans.length) log('orphan_files_removed', { count: orphans.length });
    return orphans;
  }

  start() {
    const every = this.config.OUTBOX_POLL_MS;
    if (!every) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.drain().then(() => undefined, () => undefined).finally(() => { this.running = undefined; });
    }, every);
    this.timer.unref();
    this.sweepTimer = setInterval(() => { this.sweepOrphans().catch((err) => log('orphan_sweep_failed', { error: code(err) })); }, 3_600_000);
    this.sweepTimer.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    clearInterval(this.sweepTimer);
    await this.running;
  }
}

function listFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Error codes only: a message could contain an address or a link. */
function code(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown } | undefined;
  return String(e?.code ?? e?.name ?? 'unknown').slice(0, 80);
}

function log(event: string, fields: Record<string, unknown>) {
  console.error(JSON.stringify({ level: event === 'outbox_retry' ? 'warn' : 'error', event, ...fields }));
}
