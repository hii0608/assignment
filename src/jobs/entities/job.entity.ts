import { JobStatus } from '../job-state';

export interface Job {
  id: string;
  title: string;
  description: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  failReason: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}
