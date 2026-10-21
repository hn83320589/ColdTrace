/** 可預期的業務錯誤，會轉成對應的 HTTP 狀態碼回給呼叫端 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string, id: string | number) {
    super('NOT_FOUND', `找不到${what}：${id}`, 404);
  }
}
