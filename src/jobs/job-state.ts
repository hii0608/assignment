import { ConflictException } from '@nestjs/common';

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export type TransitionActor = 'user' | 'scheduler';

/**
 * 허용 전이 표 (ARCHITECTURE.md §4). 여기 없는 전이는 전부 409.
 * 문서의 표와 1:1 대조 가능하도록 데이터로 유지한다.
 */
const ALLOWED_TRANSITIONS: ReadonlyArray<{
  from: JobStatus;
  to: JobStatus;
  actor: TransitionActor;
}> = [
  { from: JobStatus.PENDING, to: JobStatus.PROCESSING, actor: 'scheduler' },
  { from: JobStatus.PROCESSING, to: JobStatus.COMPLETED, actor: 'scheduler' },
  { from: JobStatus.PROCESSING, to: JobStatus.PENDING, actor: 'scheduler' },
  { from: JobStatus.PROCESSING, to: JobStatus.FAILED, actor: 'scheduler' },
  { from: JobStatus.PENDING, to: JobStatus.CANCELLED, actor: 'user' },
  { from: JobStatus.FAILED, to: JobStatus.PENDING, actor: 'user' },
];

/** 전이 검증 유일 지점 (CLAUDE.md 규칙 4). 불허 전이는 409를 던진다. */
export function assertTransition(
  from: JobStatus,
  to: JobStatus,
  actor: TransitionActor,
): void {
  const allowed = ALLOWED_TRANSITIONS.some(
    (t) => t.from === from && t.to === to && t.actor === actor,
  );
  if (!allowed) {
    throw new ConflictException(`허용되지 않는 상태 전이: ${from} → ${to}`);
  }
}

/** title/description 수정이 허용되는 상태 (ARCHITECTURE.md §5 PATCH 정책). */
export const CONTENT_EDITABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
  JobStatus.PENDING,
  JobStatus.FAILED,
]);
