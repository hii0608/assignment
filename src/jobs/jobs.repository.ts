import { Inject, Injectable } from '@nestjs/common';
import { Mutex } from 'async-mutex';
import { Config, JsonDB } from 'node-json-db';
import { Job } from './entities/job.entity';
import { JobStatus } from './job-state';

export const DB_FILE_TOKEN = Symbol('DB_FILE_PATH');

const JOBS_PATH = '/jobs';

export interface Paginated<T> {
  data: T[];
  total: number;
}

export interface SearchFilter {
  title?: string;
  status?: JobStatus;
}

/**
 * node-json-db 접근 유일 창구 (ARCHITECTURE.md §6).
 *
 * 모든 연산을 단일 뮤텍스로 직렬화한다. node-json-db는 쓰기 시 파일 전체를
 * 다시 쓰므로, read-modify-write가 교차하면 lost update가 발생하기 때문.
 * update()의 mutator 콜백은 뮤텍스 안에서 실행된다 — 호출자(Service)의
 * 상태 전이 검증(check)과 쓰기(act)가 한 임계 구역에 묶여 레이스가 없다.
 *
 * 반환 객체는 전부 깊은 복사본이다. 뮤텍스 밖에서 호출자가 수정해도
 * 저장소 상태에 영향을 주지 않는다.
 */
@Injectable()
export class JobsRepository {
  private readonly mutex = new Mutex();
  private readonly db: JsonDB;

  constructor(@Inject(DB_FILE_TOKEN) dbFilePath: string) {
    this.db = new JsonDB(new Config(dbFilePath, true, true, '/'));
  }

  async findAll(page: number, limit: number): Promise<Paginated<Job>> {
    return this.mutex.runExclusive(async () => {
      const jobs = await this.getAllUnsafe();
      const sorted = jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return this.paginate(sorted, page, limit);
    });
  }

  async findById(id: string): Promise<Job | null> {
    return this.mutex.runExclusive(async () => {
      const jobs = await this.getAllUnsafe();
      return jobs.find((job) => job.id === id) ?? null;
    });
  }

  async search(
    filter: SearchFilter,
    page: number,
    limit: number,
  ): Promise<Paginated<Job>> {
    return this.mutex.runExclusive(async () => {
      const jobs = await this.getAllUnsafe();
      const titleLower = filter.title?.toLowerCase();
      const matched = jobs.filter(
        (job) =>
          (titleLower === undefined ||
            job.title.toLowerCase().includes(titleLower)) &&
          (filter.status === undefined || job.status === filter.status),
      );
      const sorted = matched.sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      return this.paginate(sorted, page, limit);
    });
  }

  async create(job: Job): Promise<Job> {
    return this.mutex.runExclusive(async () => {
      const jobs = await this.getAllUnsafe();
      jobs.push(job);
      await this.saveAllUnsafe(jobs);
      return structuredClone(job);
    });
  }

  /**
   * read-modify-write 원자적 수정. mutator는 뮤텍스 안에서 실행되며,
   * mutator가 던진 예외(예: 전이 위반 409)는 쓰기 없이 그대로 전파된다.
   * 존재하지 않는 id면 null.
   */
  async update(
    id: string,
    mutator: (job: Job) => Job,
  ): Promise<Job | null> {
    return this.mutex.runExclusive(async () => {
      const jobs = await this.getAllUnsafe();
      const index = jobs.findIndex((job) => job.id === id);
      if (index === -1) {
        return null;
      }
      const mutated = mutator(structuredClone(jobs[index]));
      jobs[index] = mutated;
      await this.saveAllUnsafe(jobs);
      return structuredClone(mutated);
    });
  }

  /**
   * 스케줄러 claiming (ARCHITECTURE.md §7): pending 중 오래된 순(FIFO)으로
   * 최대 batchSize건을 processing으로 마킹. 선별과 마킹이 한 임계 구역에서
   * 일어나므로, 주기가 겹쳐도 두 번째 실행은 pending을 찾지 못해 무해하다.
   */
  async claimPendingBatch(batchSize: number): Promise<Job[]> {
    return this.mutex.runExclusive(async () => {
      const jobs = await this.getAllUnsafe();
      const claimed = jobs
        .filter((job) => job.status === JobStatus.PENDING)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, batchSize);
      const now = new Date().toISOString();
      for (const job of claimed) {
        job.status = JobStatus.PROCESSING;
        job.updatedAt = now;
      }
      if (claimed.length > 0) {
        await this.saveAllUnsafe(jobs);
      }
      return structuredClone(claimed);
    });
  }

  /** 뮤텍스 보유 상태에서만 호출할 것. */
  private async getAllUnsafe(): Promise<Job[]> {
    return this.db.getObjectDefault<Job[]>(JOBS_PATH, []);
  }

  /** 뮤텍스 보유 상태에서만 호출할 것. */
  private async saveAllUnsafe(jobs: Job[]): Promise<void> {
    await this.db.push(JOBS_PATH, jobs, true);
  }

  private paginate(jobs: Job[], page: number, limit: number): Paginated<Job> {
    const start = (page - 1) * limit;
    return {
      data: structuredClone(jobs.slice(start, start + limit)),
      total: jobs.length,
    };
  }
}
