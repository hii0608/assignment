import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JOB_MAX_ATTEMPTS } from '../common/config';
import { Job } from './entities/job.entity';
import {
  assertTransition,
  CONTENT_EDITABLE_STATUSES,
  JobStatus,
} from './job-state';
import { JobsRepository, Paginated } from './jobs.repository';

export interface CreateJobInput {
  title: string;
  description?: string;
}

export interface UpdateJobInput {
  title?: string;
  description?: string;
  status?: JobStatus;
}

export interface SearchJobsInput {
  title?: string;
  status?: JobStatus;
  page: number;
  limit: number;
}

@Injectable()
export class JobsService {
  constructor(private readonly repository: JobsRepository) {}

  async create(input: CreateJobInput): Promise<Job> {
    const now = new Date().toISOString();
    return this.repository.create({
      id: randomUUID(),
      title: input.title,
      description: input.description ?? '',
      status: JobStatus.PENDING,
      attempts: 0,
      maxAttempts: JOB_MAX_ATTEMPTS,
      failReason: null,
      createdAt: now,
      updatedAt: now,
      processedAt: null,
    });
  }

  async findAll(page: number, limit: number): Promise<Paginated<Job>> {
    return this.repository.findAll(page, limit);
  }

  async findOne(id: string): Promise<Job> {
    const job = await this.repository.findById(id);
    if (job === null) {
      throw new NotFoundException(`Job을 찾을 수 없음: ${id}`);
    }
    return job;
  }

  async search(input: SearchJobsInput): Promise<Paginated<Job>> {
    return this.repository.search(
      { title: input.title, status: input.status },
      input.page,
      input.limit,
    );
  }

  /**
   * PATCH 정책 (ARCHITECTURE.md §5). 검증과 적용 전체가 Repository의
   * 뮤텍스 안(mutator)에서 실행되어 스케줄러 claiming과의 레이스가 없다.
   */
  async update(id: string, input: UpdateJobInput): Promise<Job> {
    const updated = await this.repository.update(id, (job) => {
      const editsContent =
        input.title !== undefined || input.description !== undefined;
      if (editsContent && !CONTENT_EDITABLE_STATUSES.has(job.status)) {
        throw new ConflictException(
          `title/description 수정은 pending·failed 상태에서만 가능 (현재: ${job.status})`,
        );
      }
      if (input.status !== undefined) {
        assertTransition(job.status, input.status, 'user');
        if (
          job.status === JobStatus.FAILED &&
          input.status === JobStatus.PENDING
        ) {
          // 수동 재시도는 "조건이 달라진 새 출발" (ARCHITECTURE.md §4)
          job.attempts = 0;
          job.failReason = null;
        }
        job.status = input.status;
      }
      if (input.title !== undefined) {
        job.title = input.title;
      }
      if (input.description !== undefined) {
        job.description = input.description;
      }
      job.updatedAt = new Date().toISOString();
      return job;
    });
    if (updated === null) {
      throw new NotFoundException(`Job을 찾을 수 없음: ${id}`);
    }
    return updated;
  }
}
