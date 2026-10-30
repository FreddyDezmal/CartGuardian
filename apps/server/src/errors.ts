import type { ErrorRequestHandler } from "express";
import type { ApiErrorBody } from "@cartguardian/shared";

/** An error that is safe to show to the client. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // express.json() failures
  if (err?.type === "entity.too.large") {
    res.status(413).json(body("PAYLOAD_TOO_LARGE", "Request body is too large."));
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json(body("INVALID_JSON", "Request body is not valid JSON."));
    return;
  }
  if (err instanceof HttpError) {
    if (err.status >= 500) console.error(`[${req.method} ${req.path}] ${err.code}: ${err.message}`);
    res.status(err.status).json(body(err.code, err.message, err.details));
    return;
  }
  // Unknown error: log it, never leak internals to the client.
  console.error(`[${req.method} ${req.path}] Unhandled error`, err);
  res.status(500).json(body("INTERNAL_ERROR", "Something went wrong on the server."));
};

function body(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
