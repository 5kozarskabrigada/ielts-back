import express from "express";
import { getDashboardStats, getAdminLogs, getScoringConfigs, updateScoringConfig } from "../controllers/adminController.js";
import { requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

// All routes require admin role
router.use(requireRole("admin"));

router.get("/stats", getDashboardStats);
router.get("/logs", getAdminLogs);
router.get("/configs", getScoringConfigs);
router.put("/configs/:key", updateScoringConfig);

export default router;
