import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Job } from './entities/job.entity';
import { JobStatus } from './job-state';
import { JobsRepository } from './jobs.repository';

/**
 * 검색 매칭 규칙 검증 (TEST-PLAN §1 검색).
 * 부분일치/AND 결합 로직이 Repository에 있으므로 임시 파일 기반으로
 * Repository를 직접 검증한다 (모킹된 Service로는 위임 호출만 확인될 뿐).
 */
describe('JobsRepository — 검색', () => {
  let tempDir: string;
  let repository: JobsRepository;

  function makeJob(overrides: Partial<Job> = {}): Job {
    return {
      id: `id-${Math.random().toString(36).slice(2)}`,
      title: '작업',
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

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jobs-repo-spec-'));
    repository = new JobsRepository(join(tempDir, 'jobs.json'));
    await repository.create(
      makeJob({ title: 'Weekly Data Backup', status: JobStatus.PENDING }),
    );
    await repository.create(
      makeJob({ title: '데이터 백업 점검', status: JobStatus.COMPLETED }),
    );
    await repository.create(
      makeJob({ title: 'report export', status: JobStatus.PENDING }),
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('title 부분 일치 + 대소문자 무시', async () => {
    const result = await repository.search({ title: 'BACKUP' }, 1, 20);
    expect(result.total).toBe(1);
    expect(result.data[0].title).toBe('Weekly Data Backup');

    const korean = await repository.search({ title: '백업' }, 1, 20);
    expect(korean.total).toBe(1);
    expect(korean.data[0].title).toBe('데이터 백업 점검');
  });

  it('status 정확 일치', async () => {
    const result = await repository.search(
      { status: JobStatus.COMPLETED },
      1,
      20,
    );
    expect(result.total).toBe(1);
    expect(result.data[0].status).toBe(JobStatus.COMPLETED);
  });

  it('title+status AND 결합', async () => {
    const result = await repository.search(
      { title: '백업', status: JobStatus.PENDING },
      1,
      20,
    );
    expect(result.total).toBe(0);

    const match = await repository.search(
      { title: 'backup', status: JobStatus.PENDING },
      1,
      20,
    );
    expect(match.total).toBe(1);
    expect(match.data[0].title).toBe('Weekly Data Backup');
  });
});
