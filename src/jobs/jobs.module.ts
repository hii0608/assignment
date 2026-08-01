import { Module } from '@nestjs/common';
import { DB_FILE_PATH } from '../common/config';
import { DB_FILE_TOKEN, JobsRepository } from './jobs.repository';

@Module({
  providers: [
    JobsRepository,
    // e2e 테스트에서 overrideProvider로 임시 파일 경로를 주입한다 (TEST-PLAN §2)
    { provide: DB_FILE_TOKEN, useValue: DB_FILE_PATH },
  ],
  exports: [JobsRepository],
})
export class JobsModule {}
