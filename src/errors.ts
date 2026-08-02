export enum MailErrorCode {
  AuthError = 'AuthError',
  NetworkError = 'NetworkError',
  ValidationError = 'ValidationError',
  QuotaError = 'QuotaError',
}

export class MailMCPError extends Error {
  constructor(
    public readonly code: MailErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = code;
  }
}

export class AuthError extends MailMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(MailErrorCode.AuthError, message, options);
  }
}

export class NetworkError extends MailMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(MailErrorCode.NetworkError, message, options);
  }
}

export class ValidationError extends MailMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(MailErrorCode.ValidationError, message, options);
  }
}

export class QuotaError extends MailMCPError {
  constructor(message: string, options?: ErrorOptions) {
    super(MailErrorCode.QuotaError, message, options);
  }
}
