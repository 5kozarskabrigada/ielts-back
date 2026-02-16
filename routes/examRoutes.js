import express from "express";
import { listExams, createExam, getExam, addQuestions, submitExam, updateExamStatus, getExamLogs, createSection, saveExamStructure } from "../controllers/examController.js";
import { logViolation } from "../controllers/monitoringController.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authMiddleware);

// Public routes (authenticated)
router.get("/", listExams);
router.get("/:id", getExam);
router.post("/:id/submit", submitExam);
router.post("/:id/violations", logViolation);

// Admin routes
router.post("/", requireRole("admin"), createExam);
router.post("/:id/sections", requireRole("admin"), createSection);
router.post("/:id/questions", requireRole("admin"), addQuestions);
router.put("/:id/status", requireRole("admin"), updateExamStatus);
router.get("/:id/logs", requireRole("admin"), getExamLogs);
router.put("/:id/structure", requireRole("admin"), saveExamStructure);

export default router;
