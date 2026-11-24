/**
 * Consistent, safe error taxonomy for Querynx services.
 *
 * Errors carry an HTTP status hint and a machine-readable code. Messages
 * must never leak internal paths, credentials or stack traces to clients.
 */

/** Base class for all Querynx application errors. */
export abstract class QuerynxError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }

  /** Safe public representation (no stack, no internals). */
  toPublic(): { code: string; message: string; status: number } {
    return { code: this.code, message: this.message, status: this.httpStatus };
  }
}

/** Request failed input validation. */
export class ValidationError extends QuerynxError {
  readonly code = "VALIDATION_ERROR";
  readonly httpStatus = 400;
}

/** Resource not found. */
export class NotFoundError extends QuerynxError {
  readonly code = "NOT_FOUND";
  readonly httpStatus = 404;
}

/** Missing or invalid authentication. */
export class UnauthorizedError extends QuerynxError {
  readonly code = "UNAUTHORIZED";
  readonly httpStatus = 401;
}

/** Authenticated but not permitted. */
export class ForbiddenError extends QuerynxError {
  readonly code = "FORBIDDEN";
  readonly httpStatus = 403;
}

/** Rate limit exceeded. */
export class RateLimitError extends QuerynxError {
  readonly code = "RATE_LIMITED";
  readonly httpStatus = 429;
}

export class UpstreamError extends QuerynxError {
  readonly code = "UPSTREAM_ERROR";
  readonly httpStatus = 502;
}

/** Downstream/upstream provider failed or timed out. */
export class ProviderError extends QuerynxError {
  readonly code = "PROVIDER_ERROR";
  readonly httpStatus = 502;
}

/** Job-level failure (crawl/research) reported through the jobs API. */
export class JobError extends QuerynxError {
  readonly code = "JOB_ERROR";
  readonly httpStatus = 500;
}

/** URL rejected by SSRF protections. */
export class BlockedUrlError extends QuerynxError {
  readonly code = "URL_BLOCKED";
  readonly httpStatus = 400;
}

/**
 * Render any thrown value into a safe, JSON-serializable error shape.
 * Internal errors are masked with a generic message plus a correlation id.
 */
export function toSafeError(
  err: unknown,
  requestId?: string,
): {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
  status: number;
} {
  if (err instanceof QuerynxError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(requestId ? { requestId } : {}),
      },
      status: err.httpStatus,
    };
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return {
      error: {
        code: "CANCELLED",
        message: "Request cancelled",
        ...(requestId ? { requestId } : {}),
      },
      status: 499,
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "An internal error occurred",
      ...(requestId ? { requestId } : {}),
    },
    status: 500,
  };
}
