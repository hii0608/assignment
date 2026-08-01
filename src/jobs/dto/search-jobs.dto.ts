import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { JobStatus } from '../job-state';
import { PaginationDto } from './pagination.dto';

/**
 * "파라미터 0개면 400" 규칙(ARCHITECTURE.md §5)은 컨트롤러에서 명시 검증한다.
 * 모든 필드가 @IsOptional인 DTO에서는 class-validator 검증이 전부 스킵되어,
 * 데코레이터로 표현하려면 팬텀 프로퍼티 트릭이 필요하기 때문 (리뷰 가능성 우선).
 */
export class SearchJobsDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;

  @IsOptional()
  @IsEnum(JobStatus)
  status?: JobStatus;
}
