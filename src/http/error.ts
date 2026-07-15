interface DrizzleProxyErrorOptions {
  body?: unknown;
  cause?: unknown;
  status?: number;
  statusText?: string;
}

export class DrizzleProxyError extends Error {
  readonly body?: unknown;
  readonly status?: number;
  readonly statusText?: string;

  constructor(message: string, options: DrizzleProxyErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'DrizzleProxyError';
    this.body = options.body;
    this.status = options.status;
    this.statusText = options.statusText;
  }
}
