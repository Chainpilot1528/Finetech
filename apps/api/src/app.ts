import 'reflect-metadata';
import { type DynamicModule, type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type Clock, systemClock } from '@vittora/shared-kernel';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import {
  AppGuard, AuthController, AuthService, BREACHED_PASSWORDS, type BreachedPasswordChecker, CLOCK, CONFIG, DB, DELAY,
  type Delay, DevMailbox, MAILER, type Mailer, NoBreachCheck, PwnedPasswordsChecker, SmtpMailer, UsersController,
  UsersService,
} from './modules/identity/index.js';
import { PartnersService } from './modules/partners/index.js';
import type { Config } from './platform/config.js';
import { Db } from './platform/db.js';
import { DevMailController, HealthController, ProblemFilter, requestLog } from './platform/http.js';

export interface Overrides {
  clock?: Clock;
  mailer?: Mailer;
  breached?: BreachedPasswordChecker;
  delay?: Delay;
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
      controllers: [AuthController, UsersController, HealthController, ...(devMailbox ? [DevMailController] : [])],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB, useValue: new Db(config) },
        { provide: CLOCK, useValue: o.clock ?? systemClock },
        { provide: MAILER, useValue: mailer },
        { provide: BREACHED_PASSWORDS, useValue: breached },
        { provide: DELAY, useValue: o.delay ?? { wait: (ms: number) => new Promise((r) => setTimeout(r, ms)) } },
        AuthService,
        UsersService,
        PartnersService,
        { provide: APP_GUARD, useClass: AppGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
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
  if (config.NODE_ENV !== 'test') app.use(requestLog);
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  return app;
}
