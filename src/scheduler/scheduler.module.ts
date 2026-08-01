import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { JOB_HANDLER, StubJobHandler } from './job-handler';
import { JobsScheduler } from './jobs.scheduler';

@Module({
  imports: [JobsModule],
  providers: [
    JobsScheduler,
    // 테스트에서 overrideProvider로 결정적 실패 주입 핸들러를 교체한다
    { provide: JOB_HANDLER, useValue: new StubJobHandler() },
  ],
})
export class SchedulerModule {}
