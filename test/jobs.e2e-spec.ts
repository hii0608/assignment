import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createTestApp, TestApp } from './test-app';

const NONEXISTENT_UUID = '00000000-0000-4000-8000-000000000000';
const ERROR_KEYS = ['statusCode', 'error', 'message', 'timestamp', 'path'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Jobs API — HTTP 계약 (TEST-PLAN §2)', () => {
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

  describe('정상 경로', () => {
    it('POST /jobs → 201 + 생성된 job 반환', async () => {
      const res = await http()
        .post('/jobs')
        .send({ title: '데이터 백업', description: '주간 백업' })
        .expect(201);

      expect(res.body).toMatchObject({
        title: '데이터 백업',
        description: '주간 백업',
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        failReason: null,
        processedAt: null,
      });
      expect(res.body.id).toBeDefined();
      expect(res.body.createdAt).toBeDefined();
    });

    it('GET /jobs → 200 + { data, meta } envelope + createdAt 내림차순', async () => {
      await http().post('/jobs').send({ title: '순서 확인 A' }).expect(201);
      await sleep(5);
      await http().post('/jobs').send({ title: '순서 확인 B' }).expect(201);
      await sleep(5);
      await http().post('/jobs').send({ title: '순서 확인 C' }).expect(201);

      const res = await http().get('/jobs').expect(200);

      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.meta).toMatchObject({ page: 1, limit: 20 });

      const titles = (res.body.data as Array<{ title: string }>).map(
        (j) => j.title,
      );
      const idxA = titles.indexOf('순서 확인 A');
      const idxC = titles.indexOf('순서 확인 C');
      expect(idxC).toBeGreaterThanOrEqual(0);
      expect(idxC).toBeLessThan(idxA);

      const createdAts = (res.body.data as Array<{ createdAt: string }>).map(
        (j) => j.createdAt,
      );
      const sorted = [...createdAts].sort((a, b) => b.localeCompare(a));
      expect(createdAts).toEqual(sorted);
    });

    it('GET /jobs?page=&limit= 페이지네이션 동작 (total 정확성 포함)', async () => {
      const listBefore = await http().get('/jobs?limit=100').expect(200);
      const existing = listBefore.body.meta.total as number;

      for (let i = 0; i < 7; i += 1) {
        await http().post('/jobs').send({ title: `페이지 작업 ${i}` });
      }
      const total = existing + 7;

      const page1 = await http().get('/jobs?page=1&limit=5').expect(200);
      expect(page1.body.data).toHaveLength(5);
      expect(page1.body.meta).toEqual({ total, page: 1, limit: 5 });

      const lastPage = Math.ceil(total / 5);
      const rest = await http()
        .get(`/jobs?page=${lastPage}&limit=5`)
        .expect(200);
      expect(rest.body.data.length).toBe(total - 5 * (lastPage - 1));
    });

    it('GET /jobs/search?title= → 200 + 필터링 결과', async () => {
      await http().post('/jobs').send({ title: '유니크한검색어 작업' });
      const res = await http()
        .get('/jobs/search?title=유니크한검색어')
        .expect(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].title).toBe('유니크한검색어 작업');
    });

    it('GET /jobs/:id → 200', async () => {
      const created = await http()
        .post('/jobs')
        .send({ title: '단건 조회' })
        .expect(201);
      const res = await http().get(`/jobs/${created.body.id}`).expect(200);
      expect(res.body.id).toBe(created.body.id);
      expect(res.body.title).toBe('단건 조회');
    });

    it('PATCH /jobs/:id → 200 + 수정 반영 + updatedAt 갱신', async () => {
      const created = await http()
        .post('/jobs')
        .send({ title: '수정 전' })
        .expect(201);
      await sleep(5);

      const res = await http()
        .patch(`/jobs/${created.body.id}`)
        .send({ title: '수정 후' })
        .expect(200);

      expect(res.body.title).toBe('수정 후');
      expect(
        res.body.updatedAt.localeCompare(created.body.updatedAt),
      ).toBeGreaterThan(0);
    });
  });

  describe('라우트 순서 회귀 방지 (ARCHITECTURE.md §5)', () => {
    it('GET /jobs/search가 :id가 아닌 search 핸들러에 도달 (400, 404 아님)', async () => {
      const res = await http().get('/jobs/search').expect(400);
      expect(res.body.statusCode).toBe(400);
      // :id에 매칭됐다면 "id=search인 job 404"가 왔을 것
      expect(res.body.statusCode).not.toBe(404);
    });
  });

  describe('에러 계약', () => {
    it('POST title 누락 → 400', async () => {
      await http().post('/jobs').send({}).expect(400);
    });

    it('POST title 빈 문자열 → 400', async () => {
      await http().post('/jobs').send({ title: '' }).expect(400);
    });

    it('POST에 status 필드 포함 → 400 (whitelist 위반)', async () => {
      await http()
        .post('/jobs')
        .send({ title: 'x', status: 'completed' })
        .expect(400);
    });

    it('PATCH에 attempts 등 시스템 필드 포함 → 400', async () => {
      const created = await http()
        .post('/jobs')
        .send({ title: '시스템 필드' })
        .expect(201);
      await http()
        .patch(`/jobs/${created.body.id}`)
        .send({ attempts: 99 })
        .expect(400);
      await http()
        .patch(`/jobs/${created.body.id}`)
        .send({ createdAt: '2020-01-01T00:00:00.000Z' })
        .expect(400);
    });

    it('GET /jobs/search 파라미터 0개 → 400', async () => {
      await http().get('/jobs/search').expect(400);
    });

    it('GET /jobs/search?status=잘못된값 → 400', async () => {
      await http().get('/jobs/search?status=unknown').expect(400);
    });

    it('GET/PATCH 존재하지 않는 uuid → 404', async () => {
      await http().get(`/jobs/${NONEXISTENT_UUID}`).expect(404);
      await http()
        .patch(`/jobs/${NONEXISTENT_UUID}`)
        .send({ title: 'x' })
        .expect(404);
    });

    it('PATCH 전이 규칙 위반 → 409', async () => {
      const created = await http()
        .post('/jobs')
        .send({ title: '전이 위반' })
        .expect(201);
      const res = await http()
        .patch(`/jobs/${created.body.id}`)
        .send({ status: 'completed' })
        .expect(409);
      expect(res.body.message).toContain('pending → completed');
    });

    it('모든 에러 응답이 통일 구조 { statusCode, error, message, timestamp, path }', async () => {
      const badRequest = await http().post('/jobs').send({}).expect(400);
      const notFound = await http()
        .get(`/jobs/${NONEXISTENT_UUID}`)
        .expect(404);
      const created = await http()
        .post('/jobs')
        .send({ title: '에러 구조' })
        .expect(201);
      const conflict = await http()
        .patch(`/jobs/${created.body.id}`)
        .send({ status: 'processing' })
        .expect(409);

      for (const res of [badRequest, notFound, conflict]) {
        expect(Object.keys(res.body).sort()).toEqual([...ERROR_KEYS].sort());
      }
    });
  });
});

describe('로깅 (TEST-PLAN §2) — 앱 종료 후 로그 파일 검증', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
    const http = () => request(ctx.app.getHttpServer());

    await http().post('/jobs').send({ title: '로그 확인용' }).expect(201);
    const injected = await http()
      .post('/jobs')
      .send({ title: 'line1\nline2 인젝션 시도', description: 'x\ny' })
      .expect(201);
    await http()
      .patch(`/jobs/${injected.body.id}`)
      .send({ title: '감사 추적', description: '변경 내역' })
      .expect(200);

    await ctx.app.close(); // 로그 스트림 flush
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('요청 후 logs.txt에 JSON Lines 형식 기록 존재', () => {
    const lines = readFileSync(ctx.logFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry.event).toBe('http.request');
      expect(entry.timestamp).toBeDefined();
      expect(entry.method).toBeDefined();
      expect(entry.path).toBeDefined();
      expect(entry.statusCode).toBeDefined();
      expect(entry.durationMs).toBeDefined();
    }
  });

  it('title에 개행 포함 job 생성 → 로그 줄 수가 깨지지 않음 (인젝션 방어)', () => {
    const lines = readFileSync(ctx.logFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    // 요청 3건 = 정확히 3줄. 개행이 새 줄을 만들었다면 파싱 불가능한 줄이 생긴다
    expect(lines.length).toBe(3);
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
  });

  it('PATCH 로그에 변경 필드 내역 포함 (감사 추적)', () => {
    const lines = readFileSync(ctx.logFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    const patchEntry = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.method === 'PATCH');
    expect(patchEntry).toBeDefined();
    expect(patchEntry?.changes).toEqual({
      title: '감사 추적',
      description: '변경 내역',
    });
  });
});
