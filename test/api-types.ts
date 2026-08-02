import { Job } from '../src/jobs/entities/job.entity';

/** GET /jobs, GET /jobs/search 응답 (ARCHITECTURE.md §5) */
export interface ListResponse {
  data: Job[];
  meta: { total: number; page: number; limit: number };
}

/** 전역 Exception Filter 에러 응답 (ARCHITECTURE.md §5) */
export interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  timestamp: string;
  path: string;
}
