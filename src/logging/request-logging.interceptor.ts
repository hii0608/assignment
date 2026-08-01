import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { FileLoggerService } from './file-logger.service';

/**
 * 전 요청 로깅 (ARCHITECTURE.md §8). PATCH는 변경 필드 내역(changes)을 포함해,
 * 현재 상태(jobs.json)는 수정 가능해도 이력(logs.txt)으로 타임라인을 재구성할
 * 수 있게 한다 (감사 추적). 에러 응답도 동일 형식으로 기록한다.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(private readonly fileLogger: FileLoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = Date.now();
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const base: Record<string, unknown> = {
      event: 'http.request',
      method: request.method,
      path: request.originalUrl ?? request.url,
    };
    if (request.method === 'PATCH') {
      base.changes = request.body;
    }

    return next.handle().pipe(
      tap(() => {
        const response = http.getResponse<Response>();
        this.fileLogger.write({
          ...base,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
        });
      }),
      catchError((error: unknown) => {
        const statusCode =
          error instanceof HttpException
            ? error.getStatus()
            : (HttpStatus.INTERNAL_SERVER_ERROR as number);
        this.fileLogger.write({
          ...base,
          statusCode,
          durationMs: Date.now() - startedAt,
        });
        return throwError(() => error);
      }),
    );
  }
}
