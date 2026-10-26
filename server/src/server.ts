import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { connectDb, disconnectDb } from "./config/db.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();

try {
  await connectDb(env.MONGODB_URI);
  console.log("MongoDB connected");
} catch (error) {
  console.error("MongoDB connection failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}

// In production the server also serves the built React app, so client and API share one origin.
const clientDist = fileURLToPath(new URL("../../client/dist", import.meta.url));
const serveClient = env.NODE_ENV === "production" && existsSync(clientDist);
const app = createApp(env, { poolSweepMs: 60_000, ...(serveClient && { staticDir: clientDist }) });
if (serveClient) console.log(`Serving client from ${clientDist}`);

if (!env.CHANNEL3_API_KEY) {
  console.warn("CHANNEL3_API_KEY is not set: product search will return 503 until it is configured.");
}
if (!env.GEMINI_API_KEY) {
  console.warn("GEMINI_API_KEY is not set: AI generation will return 503 until it is configured.");
}

if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
  console.warn("PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET are not set: checkout will return 503 until they are configured.");
}

const server = app.listen(env.PORT, () => {
  console.log(`Server listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

function shutdown() {
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
