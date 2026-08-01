import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * 에러 응답 통일 필터 (ARCHITECTURE.md §5):
 * { statusCode, error, message, timestamp, path }
 *
 * HttpException이 아닌 예외도 같은 구조의 500으로 감싸,
 * 어떤 경로에서도 응답 계약이 깨지지 않게 한다.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR as number;
    let error = 'Internal Server Error';
    let message: string | string[] = '서버 내부 오류';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        error = exception.name;
      } else {
        const record = body as { error?: string; message?: string | string[] };
        error = record.error ?? exception.name;
        message = record.message ?? exception.message;
      }
    }

    response.status(statusCode).json({
      statusCode,
      error,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
