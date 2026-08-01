import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';
import { DB_FILE_TOKEN } from '../src/jobs/jobs.repository';
import { LOG_FILE_TOKEN } from '../src/logging/file-logger.service';

export interface TestApp {
  app: INestApplication;
  dbFile: string;
  logFile: string;
  close(): Promise<void>;
}

/**
 * 실제 앱과 동일한 구성(AppModule + configureApp)으로 부팅하되,
 * DB/로그 파일만 임시 디렉터리로 교체한다 (TEST-PLAN §2).
 * 스케줄러 인터벌은 정지시켜 e2e 도중 타이머 개입을 차단한다 —
 * 스케줄러 자체 검증은 tick 직접 호출로 수행한다 (TEST-PLAN §3).
 */
export async function createTestApp(options?: {
  stopScheduler?: boolean;
}): Promise<TestApp> {
  const tempDir = mkdtempSync(join(tmpdir(), 'jobs-e2e-'));
  const dbFile = join(tempDir, 'jobs.json');
  const logFile = join(tempDir, 'logs.txt');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(DB_FILE_TOKEN)
    .useValue(dbFile)
    .overrideProvider(LOG_FILE_TOKEN)
    .useValue(logFile)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  if (options?.stopScheduler !== false) {
    const registry = app.get(SchedulerRegistry);
    for (const name of registry.getIntervals()) {
      registry.deleteInterval(name);
    }
  }

  return {
    app,
    dbFile,
    logFile,
    async close() {
      await app.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
