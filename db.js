import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL environment variable");
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,                       // 20 persistent connections — handles 30+ students autosaving simultaneously
  idleTimeoutMillis: 30000,      // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if pool is full instead of hanging
  statement_timeout: 15000,      // Kill any query running > 15s (prevents stuck queries)
  ssl: DATABASE_URL.includes('sslmode=') ? { rejectUnauthorized: false } : false,
});

// Log pool connectivity on startup
pool.on("connect", () => {
  console.log("Neon PostgreSQL: new connection established");
});

pool.on("error", (err) => {
  console.error("Neon PostgreSQL pool error:", err.message);
});

// Health check helper — used by /api/health endpoint
export async function checkDbHealth() {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT NOW() AS now");
    return { ok: true, time: result.rows[0].now };
  } finally {
    client.release();
  }
}

/**
 * Run a query with automatic retry for transient failures.
 * Use this for critical writes like autosave.
 */
export async function queryWithRetry(text, params, options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const baseDelayMs = options.baseDelayMs || 300;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      const isTransient =
        err.code === "ECONNRESET" ||
        err.code === "EPIPE" ||
        err.code === "ETIMEDOUT" ||
        err.code === "57P01" || // admin_shutdown
        err.code === "57P02" || // crash_shutdown
        err.code === "57P03" || // cannot_connect_now
        err.code === "08006" || // connection_failure
        err.code === "08001" || // sqlclient_unable_to_establish_sqlconnection
        err.code === "08004";   // sqlserver_rejected_establishment_of_sqlconnection

      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }

      const waitMs = baseDelayMs * attempt;
      console.warn(`[queryWithRetry] Transient error (attempt ${attempt}/${maxAttempts}): ${err.code || err.message}. Retrying in ${waitMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
