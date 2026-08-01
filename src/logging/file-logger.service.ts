import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';

export const LOG_FILE_TOKEN = Symbol('LOG_FILE_PATH');

/**
 * logs.txt JSON Lines 로거 (ARCHITECTURE.md §8).
 * 한 줄 = JSON 객체 1개. JSON 인코딩이 개행을 이스케이프하므로 사용자 입력을
 * 통한 로그 인젝션이 원천 차단된다. append-only + 단일 write stream이라
 * 뮤텍스는 불필요 (§6).
 */
@Injectable()
export class FileLoggerService implements LoggerService, OnModuleDestroy {
  private readonly stream: WriteStream;

  constructor(@Inject(LOG_FILE_TOKEN) logFilePath: string) {
    this.stream = createWriteStream(logFilePath, { flags: 'a' });
  }

  /** 구조화 로그의 주 통로. 인터셉터·스케줄러가 이벤트 객체를 직접 기록한다. */
  write(entry: Record<string, unknown>): void {
    this.stream.write(
      JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n',
    );
  }

  log(message: unknown, context?: string): void {
    this.write({ level: 'log', context, message });
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write({ level: 'error', context, message, trace });
  }

  warn(message: unknown, context?: string): void {
    this.write({ level: 'warn', context, message });
  }

  onModuleDestroy(): void {
    this.stream.end();
  }
}
