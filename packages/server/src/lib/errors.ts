/** 可预期的业务错误：带 HTTP 状态码 + 机器可读 code，前端据此显示人话。 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }

  static badRequest(code: string, message: string): AppError {
    return new AppError(400, code, message);
  }
  static unauthorized(message = '请先登录'): AppError {
    return new AppError(401, 'unauthorized', message);
  }
  static forbidden(message = '没有权限执行此操作'): AppError {
    return new AppError(403, 'forbidden', message);
  }
  static notFound(message = '资源不存在'): AppError {
    return new AppError(404, 'not_found', message);
  }
  static conflict(code: string, message: string): AppError {
    return new AppError(409, code, message);
  }
  static tooMany(message = '操作太频繁，请稍后再试'): AppError {
    return new AppError(429, 'rate_limited', message);
  }
}
