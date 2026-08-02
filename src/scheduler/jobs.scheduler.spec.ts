import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../app.module';
import { Job } from '../jobs/entities/job.entity';
import { JobStatus } from '../jobs/job-state';
import { DB_FILE_TOKEN, JobsRepository } from '../jobs/jobs.repository';
import {
  FileLoggerService,
  LOG_FILE_TOKEN,
} from '../logging/file-logger.service';
import { JOB_HANDLER, JobHandler } from './job-handler';
import { JobsScheduler } from './jobs.scheduler';

/** 실패 여부를 테스트가 결정적으로 제어하는 핸들러 (TEST-PLAN §5). 지연 없음. */
class ControlledHandler implements JobHandler {
  shouldFail: (job: Job) => boolean = () => false;

  handle(job: Job): Promise<void> {
    if (this.shouldFail(job)) {
      return Promise.reject(new Error(`주입된 실패: ${job.title}`));
    }
    return Promise.resolve();
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    title: '스케줄러 작업',
    description: '',
    status: JobStatus.PENDING,
    attempts: 0,
    maxAttempts: 3,
    failReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    processedAt: null,
    ...overrides,
  };
}

interface SchedulerContext {
  app: INestApplication;
  scheduler: JobsScheduler;
  repository: JobsRepository;
  handler: ControlledHandler;
  fileLogger: FileLoggerService;
  logFile: string;
  close(): Promise<void>;
}

/** seedJobs를 주면 앱 부팅 전에 DB 파일을 미리 채운다 (부팅 시 복구 검증용). */
async function createContext(seedJobs: Job[] = []): Promise<SchedulerContext> {
  const tempDir = mkdtempSync(join(tmpdir(), 'scheduler-spec-'));
  const handler = new ControlledHandler();
  const dbFile = join(tempDir, 'jobs.json');
  if (seedJobs.length > 0) {
    writeFileSync(dbFile, JSON.stringify({ jobs: seedJobs }));
  }

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(DB_FILE_TOKEN)
    .useValue(dbFile)
    .overrideProvider(LOG_FILE_TOKEN)
    .useValue(join(tempDir, 'logs.txt'))
    .overrideProvider(JOB_HANDLER)
    .useValue(handler)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  const registry = app.get(SchedulerRegistry);
  for (const name of registry.getIntervals()) {
    registry.deleteInterval(name);
  }

  return {
    app,
    scheduler: app.get(JobsScheduler),
    repository: app.get(JobsRepository),
    handler,
    fileLogger: app.get(FileLoggerService),
    logFile: join(tempDir, 'logs.txt'),
    async close() {
      await app.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe('JobsScheduler (TEST-PLAN §3)', () => {
  let ctx: SchedulerContext;

  beforeEach(async () => {
    ctx = await createContext();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('pending job이 claiming된 후 completed로 종료', async () => {
    const job = await ctx.repository.create(makeJob());
    ctx.handler.shouldFail = () => false;

    await ctx.scheduler.tick();

    const after = await ctx.repository.findById(job.id);
    expect(after?.status).toBe(JobStatus.COMPLETED);
    expect(after?.processedAt).not.toBeNull();
    expect(after?.attempts).toBe(0);
  });

  it('실패 시 attempts+1 후 pending 복귀 (attempts < max)', async () => {
    const job = await ctx.repository.create(makeJob({ attempts: 0 }));
    ctx.handler.shouldFail = () => true;

    await ctx.scheduler.tick();

    const after = await ctx.repository.findById(job.id);
    expect(after?.status).toBe(JobStatus.PENDING);
    expect(after?.attempts).toBe(1);
    expect(after?.processedAt).toBeNull();
  });

  it('3회째 실패 시 failed + failReason 기록', async () => {
    const job = await ctx.repository.create(makeJob({ attempts: 2 }));
    ctx.handler.shouldFail = () => true;

    await ctx.scheduler.tick();

    const after = await ctx.repository.findById(job.id);
    expect(after?.status).toBe(JobStatus.FAILED);
    expect(after?.attempts).toBe(3);
    expect(after?.failReason).toContain('주입된 실패');
    expect(after?.processedAt).not.toBeNull();
  });

  it('배치 크기 준수: pending 10건일 때 한 주기에 5건만 처리', async () => {
    for (let i = 0; i < 10; i += 1) {
      await ctx.repository.create(
        makeJob({ createdAt: `2026-01-01T00:00:0${i}.000Z` }),
      );
    }
    ctx.handler.shouldFail = () => false;

    await ctx.scheduler.tick();

    const all = await ctx.repository.findAll(1, 100);
    const completed = all.data.filter((j) => j.status === JobStatus.COMPLETED);
    const pending = all.data.filter((j) => j.status === JobStatus.PENDING);
    expect(completed).toHaveLength(5);
    expect(pending).toHaveLength(5);
  });

  it('오래된 순으로 가져감 (FIFO)', async () => {
    const jobs: Job[] = [];
    for (let i = 0; i < 8; i += 1) {
      jobs.push(
        await ctx.repository.create(
          makeJob({
            title: `순번 ${i}`,
            createdAt: `2026-01-01T00:00:0${i}.000Z`,
          }),
        ),
      );
    }
    ctx.handler.shouldFail = () => false;

    await ctx.scheduler.tick();

    const all = await ctx.repository.findAll(1, 100);
    const byTitle = new Map(all.data.map((j) => [j.title, j.status]));
    for (let i = 0; i < 5; i += 1) {
      expect(byTitle.get(`순번 ${i}`)).toBe(JobStatus.COMPLETED);
    }
    for (let i = 5; i < 8; i += 1) {
      expect(byTitle.get(`순번 ${i}`)).toBe(JobStatus.PENDING);
    }
  });

  it('overlap 가드: isRunning=true 상태에서 주기 진입 시 스킵 + 스킵 로그', async () => {
    const job = await ctx.repository.create(makeJob());
    const writeSpy = jest.spyOn(ctx.fileLogger, 'write');
    (ctx.scheduler as unknown as { isRunning: boolean }).isRunning = true;

    await ctx.scheduler.tick();

    const after = await ctx.repository.findById(job.id);
    expect(after?.status).toBe(JobStatus.PENDING); // claiming 안 됨
    expect(writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scheduler.skip' }),
    );
  });
});

describe('JobsScheduler — 처리 결과 logs.txt 기록 (TEST-PLAN §3)', () => {
  it('jobId, title, 결과가 기록됨', async () => {
    const ctx = await createContext();
    const job = await ctx.repository.create(makeJob({ title: '로그 대상' }));
    ctx.handler.shouldFail = () => false;

    await ctx.scheduler.tick();
    await ctx.app.close(); // 스트림 flush

    const entries = readFileSync(ctx.logFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const result = entries.find((e) => e.event === 'scheduler.job.result');
    expect(result).toMatchObject({
      jobId: job.id,
      title: '로그 대상',
      result: 'completed',
    });
    expect(entries.some((e) => e.event === 'scheduler.cycle.summary')).toBe(
      true,
    );

    rmSync(join(ctx.logFile, '..'), { recursive: true, force: true });
  });
});

describe('JobsScheduler — 부팅 시 크래시 복구 (TEST-PLAN §3)', () => {
  it('processing 고아 job이 부팅 시 pending으로 복구됨 + 복구 로그 기록', async () => {
    const orphan = makeJob({
      id: 'orphan-1',
      status: JobStatus.PROCESSING,
      attempts: 1,
    });
    const untouched = makeJob({ id: 'done-1', status: JobStatus.COMPLETED });
    const ctx = await createContext([orphan, untouched]);

    const after = await ctx.repository.findById('orphan-1');
    expect(after?.status).toBe(JobStatus.PENDING);
    expect(after?.attempts).toBe(1); // 핸들러 실패가 아니므로 불변

    const done = await ctx.repository.findById('done-1');
    expect(done?.status).toBe(JobStatus.COMPLETED); // processing 외에는 불변

    await ctx.app.close(); // 스트림 flush

    const entries = readFileSync(ctx.logFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const recovery = entries.find((e) => e.event === 'scheduler.recovery');
    expect(recovery).toMatchObject({ recovered: 1, jobIds: ['orphan-1'] });

    rmSync(join(ctx.logFile, '..'), { recursive: true, force: true });
  });
});
