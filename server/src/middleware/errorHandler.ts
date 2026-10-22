import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "request_error",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "Route not found." } });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "validation_error",
        message: "Invalid request.",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, ...(error.details && { details: error.details }) },
    });
    return;
  }
  // Malformed JSON bodies and oversized payloads from body-parser
  const status = typeof error?.status === "number" && error.status >= 400 && error.status < 500 ? error.status : 500;
  if (status === 500) console.error("Unhandled error:", error);
  res.status(status).json({
    error: {
      code: status === 500 ? "internal_error" : "bad_request",
      message: status === 500 ? "Something went wrong." : "The request could not be processed.",
    },
  });
};
