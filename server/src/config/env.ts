import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CLIENT_ORIGIN: z.url().default("http://localhost:5173"),
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, "must start with mongodb:// or mongodb+srv://"),
  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  // Optional so the server still boots without it; search endpoints return 503 until it is set.
  CHANNEL3_API_KEY: z.string().trim().min(1).optional(),
  CHANNEL3_DAILY_SEARCH_LIMIT: z.coerce.number().int().min(1).max(1000).default(50),
  // Optional for the same reason; the AI generate endpoint returns 503 until it is set.
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  GEMINI_MODEL: z.string().trim().min(1).default("gemini-2.5-flash"),
  // PayPal Sandbox REST app credentials; checkout returns 503 until both are set.
  PAYPAL_CLIENT_ID: z.string().trim().min(1).optional(),
  PAYPAL_CLIENT_SECRET: z.string().trim().min(1).optional(),
  AI_DAILY_GENERATION_LIMIT: z.coerce.number().int().min(1).max(1000).default(20),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // On Render, default the public origin to the service URL so PayPal return URLs work without extra config.
  const withDefaults = { ...source, CLIENT_ORIGIN: source.CLIENT_ORIGIN || source.RENDER_EXTERNAL_URL };
  const parsed = envSchema.safeParse(withDefaults);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return parsed.data;
}
