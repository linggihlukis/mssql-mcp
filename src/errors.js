export class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
  }
}

export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
