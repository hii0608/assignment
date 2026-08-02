import { ConflictException, NotFoundException } from '@nestjs/common';
import { Job } from './entities/job.entity';
import { assertTransition, JobStatus } from './job-state';
import { JobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';

/**
 * 실제 JobsRepository와 같은 계약의 인메모리 페이크.
 * 핵심: update의 mutator 콜백을 실제로 실행해, 서비스의 전이 검증 로직이
 * 진짜 경로로 검증되게 한다 (TEST-PLAN §1).
 */
class InMemoryJobsRepository {
  private readonly jobs = new Map<string, Job>();

  seed(job: Job): void {
    this.jobs.set(job.id, structuredClone(job));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  create(job: Job): Promise<Job> {
    this.jobs.set(job.id, structuredClone(job));
    return Promise.resolve(structuredClone(job));
  }

  findById(id: string): Promise<Job | null> {
    const job = this.jobs.get(id);
    return Promise.resolve(job ? structuredClone(job) : null);
  }

  update(id: string, mutator: (job: Job) => Job): Promise<Job | null> {
    const job = this.jobs.get(id);
    if (!job) {
      return Promise.resolve(null);
    }
    const mutated = mutator(structuredClone(job));
    this.jobs.set(id, structuredClone(mutated));
    return Promise.resolve(structuredClone(mutated));
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-id',
    title: '테스트 작업',
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

describe('JobsService', () => {
  let repository: InMemoryJobsRepository;
  let service: JobsService;

  beforeEach(() => {
    repository = new InMemoryJobsRepository();
    service = new JobsService(repository as unknown as JobsRepository);
  });

  describe('생성/조회', () => {
    it('생성 시 기본값: status=pending, attempts=0, id/createdAt 자동 부여', async () => {
      const job = await service.create({ title: '새 작업' });

      expect(job.status).toBe(JobStatus.PENDING);
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
      expect(job.failReason).toBeNull();
      expect(job.processedAt).toBeNull();
      expect(job.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(new Date(job.createdAt).toISOString()).toBe(job.createdAt);
      expect(job.updatedAt).toBe(job.createdAt);
    });

    it('존재하지 않는 id 조회 → NotFoundException', async () => {
      await expect(service.findOne('없는-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('상태 전이 — assertTransition 전이 표 전수 검증', () => {
    const allowed: Array<[JobStatus, JobStatus, 'user' | 'scheduler']> = [
      [JobStatus.PENDING, JobStatus.PROCESSING, 'scheduler'],
      [JobStatus.PROCESSING, JobStatus.COMPLETED, 'scheduler'],
      [JobStatus.PROCESSING, JobStatus.PENDING, 'scheduler'],
      [JobStatus.PROCESSING, JobStatus.FAILED, 'scheduler'],
      [JobStatus.PENDING, JobStatus.CANCELLED, 'user'],
      [JobStatus.FAILED, JobStatus.PENDING, 'user'],
    ];

    it.each(allowed)('허용 전이: %s → %s (%s)', (from, to, actor) => {
      expect(() => assertTransition(from, to, actor)).not.toThrow();
    });

    const rejected: Array<[JobStatus, JobStatus, 'user' | 'scheduler']> = [
      [JobStatus.COMPLETED, JobStatus.PENDING, 'user'],
      [JobStatus.CANCELLED, JobStatus.PENDING, 'user'],
      [JobStatus.PENDING, JobStatus.COMPLETED, 'user'],
      [JobStatus.PENDING, JobStatus.PROCESSING, 'user'],
      [JobStatus.PROCESSING, JobStatus.CANCELLED, 'user'],
    ];

    it.each(rejected)('거부 전이: %s → %s (%s) → 409', (from, to, actor) => {
      expect(() => assertTransition(from, to, actor)).toThrow(
        ConflictException,
      );
    });
  });

  describe('상태 전이 — 서비스 PATCH 경로', () => {
    it('pending → cancelled 성공', async () => {
      repository.seed(makeJob());
      const job = await service.update('test-id', {
        status: JobStatus.CANCELLED,
      });
      expect(job.status).toBe(JobStatus.CANCELLED);
    });

    it('failed → pending 수동 재시도 시 attempts=0 리셋 + failReason 초기화', async () => {
      repository.seed(
        makeJob({
          status: JobStatus.FAILED,
          attempts: 3,
          failReason: '처리 실패 모사 (stub)',
        }),
      );
      const job = await service.update('test-id', {
        status: JobStatus.PENDING,
      });
      expect(job.status).toBe(JobStatus.PENDING);
      expect(job.attempts).toBe(0);
      expect(job.failReason).toBeNull();
    });

    it.each([
      [JobStatus.COMPLETED, JobStatus.PENDING],
      [JobStatus.CANCELLED, JobStatus.PENDING],
      [JobStatus.PENDING, JobStatus.COMPLETED],
      [JobStatus.PENDING, JobStatus.PROCESSING],
      [JobStatus.PROCESSING, JobStatus.CANCELLED],
    ])('거부 전이 %s → %s 요청 → ConflictException', async (from, to) => {
      repository.seed(makeJob({ status: from }));
      await expect(service.update('test-id', { status: to })).rejects.toThrow(
        ConflictException,
      );
      expect(repository.get('test-id')?.status).toBe(from);
    });
  });

  describe('PATCH 정책', () => {
    it('pending에서 title/description 수정 성공', async () => {
      repository.seed(makeJob());
      const job = await service.update('test-id', {
        title: '수정된 제목',
        description: '수정된 설명',
      });
      expect(job.title).toBe('수정된 제목');
      expect(job.description).toBe('수정된 설명');
      expect(job.status).toBe(JobStatus.PENDING);
    });

    it('failed에서 title 수정 성공 (상태 유지)', async () => {
      repository.seed(makeJob({ status: JobStatus.FAILED, attempts: 3 }));
      const job = await service.update('test-id', { title: '고친 제목' });
      expect(job.title).toBe('고친 제목');
      expect(job.status).toBe(JobStatus.FAILED);
      expect(job.attempts).toBe(3);
    });

    it('failed에서 title+status=pending 동시 수정 성공 (고치고 재시도)', async () => {
      repository.seed(
        makeJob({ status: JobStatus.FAILED, attempts: 3, failReason: '오류' }),
      );
      const job = await service.update('test-id', {
        title: '고친 제목',
        status: JobStatus.PENDING,
      });
      expect(job.title).toBe('고친 제목');
      expect(job.status).toBe(JobStatus.PENDING);
      expect(job.attempts).toBe(0);
      expect(job.failReason).toBeNull();
    });

    it('processing 중 title 수정 → 409', async () => {
      repository.seed(makeJob({ status: JobStatus.PROCESSING }));
      await expect(
        service.update('test-id', { title: '수정 시도' }),
      ).rejects.toThrow(ConflictException);
    });

    it('completed에서 title 수정 → 409', async () => {
      repository.seed(makeJob({ status: JobStatus.COMPLETED }));
      await expect(
        service.update('test-id', { title: '수정 시도' }),
      ).rejects.toThrow(ConflictException);
    });

    it('존재하지 않는 id 수정 → NotFoundException', async () => {
      await expect(service.update('없는-id', { title: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
