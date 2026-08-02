import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FileLoggerService } from '../logging/file-logger.service';
import {
  SCHEDULER_BATCH_SIZE,
  SCHEDULER_POLL_INTERVAL_MS,
} from '../common/config';
import { Job } from '../jobs/entities/job.entity';
import { assertTransition, JobStatus } from '../jobs/job-state';
import { JobsRepository } from '../jobs/jobs.repository';
import { JOB_HANDLER } from './job-handler';
import type { JobHandler } from './job-handler';

/**
 * 폴링 워커 (ARCHITECTURE.md §7).
 * 한 주기: overlap 가드 → [뮤텍스] claiming → 뮤텍스 밖에서 처리 →
 * [뮤텍스] 결과 기록 → 요약 로깅.
 * 배치 내 처리는 순차 — 제약식(배치 5 × 건당 최대 3초 = 15초 < 주기 30초)이
 * 순차 기준 최악치로 계산되어 있다.
 */
@Injectable()
export class JobsScheduler implements OnApplicationBootstrap {
  private isRunning = false;

  constructor(
    private readonly repository: JobsRepository,
    @Inject(JOB_HANDLER) private readonly handler: JobHandler,
    private readonly fileLogger: FileLoggerService,
  ) {}

  /**
   * 부팅 시 크래시 복구 (ARCHITECTURE.md §7). 단일 프로세스 전제에서 부팅
   * 시점에 processing인 job은 전부 고아이다 — 살아 있는 워커가 있었을 수 없다.
   * 첫 tick은 부팅 후 폴링 주기(30초)가 지나야 돌므로 복구가 항상 선행된다.
   */
  async onApplicationBootstrap(): Promise<void> {
    const jobIds = await this.repository.recoverOrphanedProcessing();
    if (jobIds.length > 0) {
      this.fileLogger.write({
        event: 'scheduler.recovery',
        recovered: jobIds.length,
        jobIds,
      });
    }
  }

  @Interval(SCHEDULER_POLL_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.isRunning) {
      // 정상 상황에서는 도달하지 않는 안전망 — 도달 자체가 이상 신호이므로 기록
      this.fileLogger.write({
        event: 'scheduler.skip',
        reason: 'previous cycle still running',
      });
      return;
    }
    this.isRunning = true;
    const startedAt = Date.now();
    try {
      const claimed =
        await this.repository.claimPendingBatch(SCHEDULER_BATCH_SIZE);
      this.fileLogger.write({
        event: 'scheduler.cycle.start',
        claimed: claimed.length,
      });
      let completed = 0;
      let retried = 0;
      let failed = 0;
      for (const job of claimed) {
        const result = await this.processOne(job);
        if (result === 'completed') completed += 1;
        else if (result === 'retried') retried += 1;
        else failed += 1;
      }
      this.fileLogger.write({
        event: 'scheduler.cycle.summary',
        claimed: claimed.length,
        completed,
        retried,
        failed,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      this.isRunning = false;
    }
  }

  private async processOne(
    job: Job,
  ): Promise<'completed' | 'retried' | 'failed'> {
    try {
      await this.handler.handle(job);
      await this.recordResult(job.id, (j) => {
        assertTransition(j.status, JobStatus.COMPLETED, 'scheduler');
        j.status = JobStatus.COMPLETED;
        j.processedAt = new Date().toISOString();
        return j;
      });
      this.logJobResult(job, 'completed', job.attempts, null);
      return 'completed';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const nextAttempts = job.attempts + 1;
      if (nextAttempts < job.maxAttempts) {
        await this.recordResult(job.id, (j) => {
          assertTransition(j.status, JobStatus.PENDING, 'scheduler');
          j.status = JobStatus.PENDING;
          j.attempts = nextAttempts;
          return j;
        });
        this.logJobResult(job, 'retried', nextAttempts, reason);
        return 'retried';
      }
      await this.recordResult(job.id, (j) => {
        assertTransition(j.status, JobStatus.FAILED, 'scheduler');
        j.status = JobStatus.FAILED;
        j.attempts = nextAttempts;
        j.failReason = reason;
        j.processedAt = new Date().toISOString();
        return j;
      });
      this.logJobResult(job, 'failed', nextAttempts, reason);
      return 'failed';
    }
  }

  private async recordResult(
    id: string,
    mutator: (job: Job) => Job,
  ): Promise<void> {
    await this.repository.update(id, (job) => {
      const mutated = mutator(job);
      mutated.updatedAt = new Date().toISOString();
      return mutated;
    });
  }

  private logJobResult(
    job: Job,
    result: string,
    attempts: number,
    failReason: string | null,
  ): void {
    this.fileLogger.write({
      event: 'scheduler.job.result',
      jobId: job.id,
      title: job.title,
      result,
      attempts,
      failReason,
    });
  }
}
