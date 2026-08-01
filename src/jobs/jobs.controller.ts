import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Job } from './entities/job.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { PaginationDto } from './dto/pagination.dto';
import { SearchJobsDto } from './dto/search-jobs.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { Paginated } from './jobs.repository';
import { JobsService } from './jobs.service';

interface ListResponse {
  data: Job[];
  meta: { total: number; page: number; limit: number };
}

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post()
  async create(@Body() dto: CreateJobDto): Promise<Job> {
    return this.jobsService.create(dto);
  }

  @Get()
  async findAll(@Query() pagination: PaginationDto): Promise<ListResponse> {
    const result = await this.jobsService.findAll(
      pagination.page,
      pagination.limit,
    );
    return this.toListResponse(result, pagination);
  }

  // 정적 라우트를 :id보다 먼저 선언할 것 (ARCHITECTURE.md §5).
  // Express 계열은 선언 순서대로 첫 매칭을 취하므로, :id가 먼저면
  // "search" 문자열을 id로 삼켜 이 엔드포인트가 도달 불가능해진다.
  @Get('search')
  async search(@Query() dto: SearchJobsDto): Promise<ListResponse> {
    if (dto.title === undefined && dto.status === undefined) {
      throw new BadRequestException(
        '검색 조건이 최소 1개 필요합니다 (title, status)',
      );
    }
    const result = await this.jobsService.search(dto);
    return this.toListResponse(result, dto);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Job> {
    return this.jobsService.findOne(id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateJobDto,
  ): Promise<Job> {
    return this.jobsService.update(id, dto);
  }

  private toListResponse(
    result: Paginated<Job>,
    pagination: PaginationDto,
  ): ListResponse {
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: pagination.page,
        limit: pagination.limit,
      },
    };
  }
}
