import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LOG_FILE_PATH } from '../common/config';
import { FileLoggerService, LOG_FILE_TOKEN } from './file-logger.service';
import { RequestLoggingInterceptor } from './request-logging.interceptor';

@Module({
  providers: [
    FileLoggerService,
    // e2e 테스트에서 overrideProvider로 임시 파일 경로를 주입한다
    { provide: LOG_FILE_TOKEN, useValue: LOG_FILE_PATH },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
  exports: [FileLoggerService],
})
export class LoggingModule {}
