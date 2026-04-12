import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import examRoutes from "./routes/examRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import classroomRoutes from "./routes/classroomRoutes.js";
import gradingRoutes from "./routes/gradingRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import monitoringRoutes from "./routes/monitoringRoutes.js";

const app = express();
const PORT = process.env.PORT || 4000;

// CORS — explicit config so error responses also include headers
const corsOptions = {
  origin: true,            // reflect request origin (same as wildcard but works with credentials)
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
  maxAge: 86400,           // cache preflight for 24h — reduces OPTIONS round-trips
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/exams", examRoutes);
app.use("/api/admin", adminRoutes); // Protected by authMiddleware in router
app.use("/api/classrooms", classroomRoutes); // Protected by authMiddleware in router
app.use("/api/grading", gradingRoutes); // AI grading and admin overrides
app.use("/api/upload", uploadRoutes); // Passage image upload endpoint
app.use("/api/monitoring", monitoringRoutes); // Monitoring logs and submissions

// Health check
app.get("/", (req, res) => {
  res.send("IELTS Platform API is running");
});

// DB health check
import { checkDbHealth } from "./db.js";
app.get("/api/health", async (req, res) => {
  try {
    const ok = await checkDbHealth();
    res.json({ status: ok ? "ok" : "degraded", db: ok ? "connected" : "unreachable" });
  } catch (err) {
    res.status(503).json({ status: "error", db: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Global error handler — ensures CORS headers are always present even on crashes
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Graceful shutdown — release pool on SIGTERM (Render sends this on deploy)
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing pool...');
  const { pool } = await import('./db.js');
  await pool.end().catch(() => {});
  process.exit(0);
});
