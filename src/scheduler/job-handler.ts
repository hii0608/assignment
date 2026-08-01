import {
  STUB_HANDLER_FAILURE_RATE,
  STUB_HANDLER_MAX_DELAY_MS,
  STUB_HANDLER_MIN_DELAY_MS,
} from '../common/config';
import { Job } from '../jobs/entities/job.entity';

/**
 * job 처리 로직의 교체 지점 (ARCHITECTURE.md §2).
 * 실제 도메인 작업(외부 API 호출, 파일 변환 등)이 연결되면 이 인터페이스의
 * 구현만 바꾸면 되고 스케줄러 코드는 변경되지 않는다. 실패는 reject로 표현.
 */
export interface JobHandler {
  handle(job: Job): Promise<void>;
}

export const JOB_HANDLER = Symbol('JOB_HANDLER');

export interface StubJobHandlerOptions {
  /** 실패 확률 (0~1). shouldFail이 주어지면 무시된다. */
  failureRate?: number;
  /** 결정적 실패 주입 — 테스트에서 사용 (TEST-PLAN §5: 확률 검증 금지). */
  shouldFail?: (job: Job) => boolean;
  /** 지연 모사 생략용 — 테스트에서 0으로 고정 가능. */
  minDelayMs?: number;
  maxDelayMs?: number;
}

/** 지연(1~3초)과 실패를 모사하는 스텁 구현. */
export class StubJobHandler implements JobHandler {
  constructor(private readonly options: StubJobHandlerOptions = {}) {}

  async handle(job: Job): Promise<void> {
    const min = this.options.minDelayMs ?? STUB_HANDLER_MIN_DELAY_MS;
    const max = this.options.maxDelayMs ?? STUB_HANDLER_MAX_DELAY_MS;
    const delay = min + Math.random() * (max - min);
    await new Promise((resolve) => setTimeout(resolve, delay));

    const failed =
      this.options.shouldFail?.(job) ??
      Math.random() < (this.options.failureRate ?? STUB_HANDLER_FAILURE_RATE);
    if (failed) {
      throw new Error(`처리 실패 모사 (stub): ${job.title}`);
    }
  }
}
