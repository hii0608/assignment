import request from 'supertest';
import { readFileSync } from 'node:fs';
import { Job } from '../src/jobs/entities/job.entity';
import { JobHandler } from '../src/scheduler/job-handler';
import { JobsScheduler } from '../src/scheduler/jobs.scheduler';
import { createTestApp, TestApp } from './test-app';

/** 지연 없이 항상 성공하는 핸들러 — 경합 시나리오의 결정성 확보용. */
class InstantSuccessHandler implements JobHandler {
  async handle(): Promise<void> {
    /* 즉시 성공 */
  }
}

const VALID_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
];

/** 파일 무결성 검증 (TEST-PLAN §4): 파싱 가능 + 스키마 유효 */
function assertDbFileValid(dbFile: string): Job[] {
  const parsed = JSON.parse(readFileSync(dbFile, 'utf8')) as { jobs: Job[] };
  expect(Array.isArray(parsed.jobs)).toBe(true);
  for (const job of parsed.jobs) {
    expect(typeof job.id).toBe('string');
    expect(typeof job.title).toBe('string');
    expect(VALID_STATUSES).toContain(job.status);
    expect(typeof job.attempts).toBe('number');
    expect(typeof job.maxAttempts).toBe('number');
    expect(typeof job.createdAt).toBe('string');
    expect(typeof job.updatedAt).toBe('string');
  }
  return parsed.jobs;
}

describe('동시성 — 병렬 API 요청 (TEST-PLAN §4)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  function http() {
    return request(ctx.app.getHttpServer());
  }

  it('병렬 생성: POST 20건 동시 발사 → 정확히 20건 존재 (lost update 없음)', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        http().post('/jobs').send({ title: `동시 생성 ${i}` }).expect(201),
      ),
    );

    const res = await http().get('/jobs?limit=100').expect(200);
    expect(res.body.meta.total).toBe(20);

    const jobs = assertDbFileValid(ctx.dbFile);
    expect(jobs).toHaveLength(20);
  });

  it('병렬 수정: 서로 다른 job 10건 동시 PATCH → 모든 수정 반영', async () => {
    const created: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await http()
        .post('/jobs')
        .send({ title: `수정 대상 ${i}` })
        .expect(201);
      created.push(res.body.id as string);
    }

    await Promise.all(
      created.map((id, i) =>
        http()
          .patch(`/jobs/${id}`)
          .send({ title: `동시 수정 완료 ${i}` })
          .expect(200),
      ),
    );

    const res = await http().get('/jobs?limit=100').expect(200);
    const titles = new Set(
      (res.body.data as Job[]).map((job) => job.title),
    );
    for (let i = 0; i < 10; i += 1) {
      expect(titles.has(`동시 수정 완료 ${i}`)).toBe(true);
    }
  });

  it('파일 무결성: 병렬 요청 후 jobs.json이 파싱 가능하고 스키마 유효', () => {
    const jobs = assertDbFileValid(ctx.dbFile);
    expect(jobs).toHaveLength(30);
  });
});

describe('동시성 — API vs 스케줄러 경합 (TEST-PLAN §4)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    // 깨끗한 저장소에서 시작 — 다른 pending이 있으면 FIFO 배치가
    // 경합 대상 job을 집지 않아 경합이 성립하지 않는다
    ctx = await createTestApp({ handler: new InstantSuccessHandler() });
  });

  afterAll(async () => {
    await ctx.close();
  });

  function http() {
    return request(ctx.app.getHttpServer());
  }

  it('claiming 중 같은 job에 PATCH → 한쪽 성공, 한쪽 409, 두 시나리오로 수렴', async () => {
    const created = await http()
      .post('/jobs')
      .send({ title: '경합 대상' })
      .expect(201);
    const id = created.body.id as string;

    const scheduler = ctx.app.get(JobsScheduler);
    const [, patchRes] = await Promise.all([
      scheduler.tick(),
      http().patch(`/jobs/${id}`).send({ status: 'cancelled' }),
    ]);

    // 뮤텍스 직렬화로 인해 결과는 정확히 두 시나리오 중 하나:
    // (a) PATCH 선행 → 200, job은 cancelled로 종결 (스케줄러는 집을 게 없음)
    // (b) claiming 선행 → PATCH는 409, job은 처리되어 completed
    expect([200, 409]).toContain(patchRes.status);

    const final = await http().get(`/jobs/${id}`).expect(200);
    if (patchRes.status === 200) {
      expect(final.body.status).toBe('cancelled');
    } else {
      expect(final.body.status).toBe('completed');
    }
  });

  it('파일 무결성: 경합 후에도 jobs.json이 파싱 가능하고 스키마 유효', () => {
    const jobs = assertDbFileValid(ctx.dbFile);
    expect(jobs).toHaveLength(1);
  });
});
