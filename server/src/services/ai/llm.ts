import type { ZodType } from "zod";

/** Standard JSON Schema describing the model's output (strict-mode compatible: every property required, no extras). */
export type JsonSchema = Record<string, unknown>;

export interface JsonGenerationRequest<T> {
  /** Short identifier for the output shape, e.g. "procurement_plan". */
  schemaName: string;
  system: string;
  user: string;
  responseSchema: JsonSchema;
  /** Validates the parsed output; providers' schema enforcement is never fully trusted. */
  parse: ZodType<T>;
  temperature?: number;
}

export interface LlmClient {
  readonly model: string;
  generateJson<T>(request: JsonGenerationRequest<T>): Promise<T>;
}

/** Thrown when the model answered but its output was unusable; callers may retry with feedback. */
export class LlmOutputError extends Error {}
