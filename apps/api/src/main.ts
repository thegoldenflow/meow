import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { loggingMiddleware } from './middleware/logging.middleware';
import { errorFilter } from './middleware/error.filter';
import { PersistenceFailureFilter } from './middleware/persistence-failure.filter';
import { assertProductionAuthEnforce } from './auth/auth.guard';
import { assertAudioAccessModeReady } from './services/audio-access-url.service';

async function bootstrap() {
  // 需求 23 D13: 生产环境必须开启 AUTH_ENFORCE
  assertProductionAuthEnforce();

  // 需求 24 II: stream 模式必须有 COS 凭证（fail-fast）
  assertAudioAccessModeReady();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 需求 23 Phase D PR-D-α (plan-023-D-v2 §4.1 / Review 1: HTTP body
  // limit): default express.json limit is 100KB; a typical mobile
  // snapshot already comfortably exceeds that (full word_records +
  // card_states for an active learner). Raise to 10MB so /me/backup
  // POSTs don't 413. urlencoded follows for any future form posts.
  // See `BACKUP_BODY_LIMIT_MB` env knob if a higher cap is ever
  // needed in dev / staging.
  const bodyLimit = process.env.BACKUP_BODY_LIMIT_MB
    ? `${process.env.BACKUP_BODY_LIMIT_MB}mb`
    : '10mb';
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  // Global prefix for API versioning (does NOT affect static assets)
  app.setGlobalPrefix('api/v1');

  // PR-D Option A: /cdn static route removed. audio_assets.url now points
  // at Tencent COS public-read URLs (rewritten by repipe-audio-urls.ts);
  // pronunciation.controller.ts returns 302 redirect to COS. apps/api/cdn-mock/
  // is kept in repo as a .gitkeep placeholder so the dev pipeline
  // (partial_publish.py) still has a write target — sync-audio-mp3-to-cos.ts
  // pushes those files to COS after each publish.

  // Request logging
  app.use(loggingMiddleware);

  // Global error filters (persistence failure filter first, then general)
  app.useGlobalFilters(new PersistenceFailureFilter(), errorFilter);

  // CORS for mobile development
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`API server running on port ${port}`);
}
bootstrap();
