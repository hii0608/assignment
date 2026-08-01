import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { JobStatus } from '../job-state';

/**
 * 수정 가능 필드는 title/description/status뿐 (ARCHITECTURE.md §5).
 * attempts 등 시스템 관리 필드는 전역 forbidNonWhitelisted가 400으로 거부한다.
 */
export class UpdateJobDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(JobStatus)
  status?: JobStatus;
}
