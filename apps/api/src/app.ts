import 'reflect-metadata';
import { type DynamicModule, type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type Clock, systemClock } from '@vittora/shared-kernel';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import {
  AppGuard, AuthController, AuthService, BREACHED_PASSWORDS, type BreachedPasswordChecker, CLOCK, CONFIG, DB, DELAY,
  type Delay, DevMailbox, MAILER, type Mailer, NoBreachCheck, PARTNER_READER, PwnedPasswordsChecker, SmtpMailer,
  UsersController, UsersService,
} from './modules/identity/index.js';
import {
  CasesController, CasesService, ConsentService, OpsCasesController, OpsCasesService, TrackingController, TrackingService,
} from './modules/cases/index.js';
import { CommissionsService, InvoicesController, OpsFinanceController, OpsFinanceService } from './modules/commissions/index.js';
import { NotificationsController, NotificationsService } from './modules/notifications/index.js';
import {
  KycService, OpsKycService, OpsPartnersController, PartnersController, PartnersService, RegistrationService, SettingsService,
} from './modules/partners/index.js';
import { DevScanner, FilesController, LocalEncryptedStore, type Scanner } from './platform/storage.js';
import { DOCUMENT_STORE, SCANNER } from './platform/tokens.js';
import type { Config } from './platform/config.js';
import { Db } from './platform/db.js';
import { IdempotencyInterceptor } from './platform/idempotency.js';
import { Outbox } from './platform/outbox.js';
import { DevMailController, HealthController, ProblemFilter, requestLog } from './platform/http.js';

export interface Overrides {
  clock?: Clock;
  mailer?: Mailer;
  breached?: BreachedPasswordChecker;
  delay?: Delay;
  scanner?: Scanner;
}

@Module({})
class AppModule {
  static register(config: Config, o: Overrides): DynamicModule {
    const devMailbox = config.DEV_MAILBOX === 'true';
    const mailer =
      o.mailer ??
      (devMailbox || !config.SMTP_URL ? new DevMailbox() : new SmtpMailer(config.SMTP_URL, config.MAIL_FROM));
    const breached =
      o.breached ?? (config.BREACHED_PASSWORD_CHECK === 'true' ? new PwnedPasswordsChecker() : new NoBreachCheck());
    return {
      module: AppModule,
      controllers: [
        AuthController, UsersController, HealthController, PartnersController, OpsPartnersController, CasesController,
        TrackingController, OpsCasesController, InvoicesController, OpsFinanceController, NotificationsController, FilesController, ...(devMailbox ? [DevMailController] : []),
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB, useValue: new Db(config) },
        { provide: CLOCK, useValue: o.clock ?? systemClock },
        { provide: MAILER, useValue: mailer },
        { provide: BREACHED_PASSWORDS, useValue: breached },
        { provide: DELAY, useValue: o.delay ?? { wait: (ms: number) => new Promise((r) => setTimeout(r, ms)) } },
        { provide: DOCUMENT_STORE, useValue: new LocalEncryptedStore(config.STORAGE_DIR, config.ENCRYPTION_KEY) },
        { provide: SCANNER, useValue: o.scanner ?? new DevScanner() },
        AuthService,
        UsersService,
        PartnersService,
        { provide: PARTNER_READER, useExisting: PartnersService },
        RegistrationService,
        KycService,
        OpsKycService,
        NotificationsService,
        CommissionsService,
        OpsFinanceService,
        Outbox,
        CasesService,
        ConsentService,
        TrackingService,
        OpsCasesService,
        SettingsService,
        { provide: APP_GUARD, useClass: AppGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    };
  }
}

export async function createApp(config: Config, overrides: Overrides = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, overrides), {
    logger: config.NODE_ENV === 'test' ? false : ['error', 'warn'],
  });
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  // API responses can hold personal data, so neither browsers nor proxies may keep them.
  app.set('etag', false);
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('cache-control', 'no-store');
    next();
  });
  if (config.NODE_ENV !== 'test') app.use(requestLog);
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  app.get(Outbox).start();
  return app;
}
