import { pool } from "../db.js";

/**
 * Lightweight middleware that logs per-request usage attributed to the
 * authenticated user.  It fires AFTER the response is sent so it never
 * slows down the actual request.
 *
 * Tracks:
 *  - user_id / role (from req.user set by authMiddleware)
 *  - HTTP method, path, status code
 *  - total response time in ms
 *
 * The INSERT itself is fire-and-forget; failures are silently logged to
 * avoid impacting normal traffic.
 */
export function usageTracker(req, res, next) {
  const start = process.hrtime.bigint();

  // Hook into the 'finish' event so we log after the response is sent
  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // Only track authenticated requests (req.user is set by authMiddleware)
    const userId = req.user?.id || null;
    if (!userId) return; // skip anonymous / health-check requests

    const userRole = req.user?.role || "unknown";
    const method = req.method;
    // Normalise path: strip UUIDs so we get groupable route patterns
    const rawPath = req.originalUrl.split("?")[0]; // drop query string
    const path = rawPath.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ":id"
    );

    pool
      .query(
        `INSERT INTO request_usage (user_id, user_role, method, path, status_code, response_time_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, userRole, method, path, res.statusCode, Math.round(elapsedMs)]
      )
      .catch((err) => {
        // Don't crash the app if the table doesn't exist yet or there's a transient error
        if (!usageTracker._warned) {
          console.warn("[usageTracker] Failed to log usage (will suppress further warnings):", err.message);
          usageTracker._warned = true;
        }
      });
  });

  next();
}
