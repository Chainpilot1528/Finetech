import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import { type Clock, DomainError } from '@vittora/shared-kernel';
import type { Response } from 'express';
import sharp from 'sharp';
import { v7 as uuid } from 'uuid';
import { CLOCK, Public } from '../modules/identity/index.js';
import type { Config } from './config.js';
import { decryptBytes, encryptBytes, hmac, safeEqual, sha256 } from './crypto.js';
import { CONFIG, DOCUMENT_STORE } from './tokens.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const LINK_TTL_MS = 5 * 60_000;

/** Files never sit anywhere public. Reads only happen through a short signed link. */
export interface DocumentStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export interface Scanner {
  isClean(data: Buffer): Promise<boolean>;
}

/** Development storage: encrypted files on disk. Config refuses this in production. */
export class LocalEncryptedStore implements DocumentStore {
  constructor(private readonly dir: string, private readonly key: string) {}

  private path(key: string) {
    const root = resolve(this.dir);
    const full = resolve(root, key);
    if (!full.startsWith(`${root}/`)) throw new Error('Bad object key');
    return full;
  }
  async put(key: string, data: Buffer) {
    const full = this.path(key);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, encryptBytes(this.key, data), { mode: 0o600 });
  }
  async get(key: string) {
    return decryptBytes(this.key, readFileSync(this.path(key)));
  }
  async remove(key: string) {
    try {
      unlinkSync(this.path(key));
    } catch {
      // Already gone.
    }
  }
}

/** Stand-in for ClamAV. It only catches the standard EICAR test file. */
export class DevScanner implements Scanner {
  async isClean(data: Buffer) {
    return !data.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');
  }
}

export function sniffMime(data: Buffer): 'application/pdf' | 'image/png' | 'image/jpeg' | null {
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  return null;
}

export interface CleanFile {
  data: Buffer;
  mime: string;
  sha256: string;
  fileName: string;
  objectKey: string;
}

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
}

/** The checks every upload passes before it is stored (§9.4). */
export async function prepareUpload(file: UploadedFile | undefined, scanner: Scanner, prefix: string): Promise<CleanFile> {
  if (!file?.buffer?.length) throw new DomainError('FILE_REQUIRED', 422, 'Choose a file to upload.');
  if (file.buffer.length > MAX_UPLOAD_BYTES) throw new DomainError('FILE_TOO_LARGE', 413, 'Files can be up to 10 MB.');
  // The file's real bytes decide its type. The name and the browser's claim are ignored.
  const mime = sniffMime(file.buffer);
  if (!mime) throw new DomainError('FILE_TYPE_NOT_ALLOWED', 422, 'Upload a PDF, JPG or PNG.');
  if (!(await scanner.isClean(file.buffer))) throw new DomainError('FILE_INFECTED', 422, 'This file failed a virus check.');

  let data = file.buffer;
  if (mime !== 'application/pdf') {
    // Re-encoding drops EXIF and location data, and anything hidden after the image.
    try {
      const image = sharp(file.buffer).rotate();
      data = await (mime === 'image/png' ? image.png() : image.jpeg({ quality: 90 })).toBuffer();
    } catch {
      throw new DomainError('FILE_TYPE_NOT_ALLOWED', 422, 'This image could not be read.');
    }
  }
  const fileName = file.originalname.replace(/[^\w.\- ]/g, '_').slice(-100) || 'document';
  const ext = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' }[mime];
  return { data, mime, sha256: sha256(data.toString('latin1')), fileName, objectKey: `${prefix}/${uuid()}.${ext}` };
}

interface LinkClaims {
  k: string;
  m: string;
  n: string;
  e: number;
}

export function signFileLink(config: Config, clock: Clock, file: { objectKey: string; mime: string; fileName: string }) {
  const claims: LinkClaims = { k: file.objectKey, m: file.mime, n: file.fileName, e: clock.now().getTime() + LINK_TTL_MS };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `/api/v1/files/${body}.${hmac(config.HMAC_KEY, `file:${body}`)}`;
}

@Controller('files')
export class FilesController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
  ) {}

  /** Public, because the link itself is the short-lived permission. Issued after an authorisation check. */
  @Public()
  @Get(':token')
  async read(@Param('token') token: string, @Res() res: Response) {
    const invalid = new DomainError('LINK_INVALID', 403, 'This link has expired.');
    const [body, signature] = token.split('.');
    if (!body || !signature || !safeEqual(signature, hmac(this.config.HMAC_KEY, `file:${body}`))) throw invalid;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as LinkClaims;
    if (this.clock.now().getTime() > claims.e) throw invalid;
    res
      .status(200)
      .type(claims.m)
      .set({
        'content-disposition': `attachment; filename="${claims.n.replace(/"/g, '')}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      .send(await this.store.get(claims.k));
  }
}

