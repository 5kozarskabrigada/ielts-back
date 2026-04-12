import express from "express";
import { getDashboardStats, getAdminLogs, getScoringConfigs, updateScoringConfig } from "../controllers/adminController.pg.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

// All routes require auth + admin role
router.use(authMiddleware);
router.use(requireRole("admin"));

router.get("/stats", getDashboardStats);
router.get("/logs", getAdminLogs);
router.get("/configs", getScoringConfigs);
router.put("/configs/:key", updateScoringConfig);

export default router;
