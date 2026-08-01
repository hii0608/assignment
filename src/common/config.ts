/**
 * 시스템 전역 상수. 매직 넘버 금지 규칙(CLAUDE.md)에 따라 모든 수치는 여기서만 정의한다.
 *
 * 스케줄러 제약식 (ARCHITECTURE.md §7):
 *   SCHEDULER_BATCH_SIZE × STUB_HANDLER_MAX_DELAY_MS < SCHEDULER_POLL_INTERVAL_MS
 *   (5 × 3초 = 15초 < 30초) — 정상 상황에서 주기 overlap이 발생하지 않도록 유지한다.
 *   값을 바꿀 때는 이 제약식을 반드시 재계산할 것.
 */

export const SCHEDULER_POLL_INTERVAL_MS = 30_000;
export const SCHEDULER_BATCH_SIZE = 5;

export const JOB_MAX_ATTEMPTS = 3;

export const STUB_HANDLER_MIN_DELAY_MS = 1_000;
export const STUB_HANDLER_MAX_DELAY_MS = 3_000;
/** 스텁의 실패 모사 확률. 실제 구동에서도 재시도·failed 경로가 관찰되게 한다. */
export const STUB_HANDLER_FAILURE_RATE = 0.2;

export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;

export const DB_FILE_PATH = 'jobs.json';
export const LOG_FILE_PATH = 'logs.txt';

export const DEFAULT_PORT = 3000;
