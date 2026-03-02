import express from "express";
import { listExams, createExam, getExam, addQuestions, submitExam, updateExamStatus, getExamLogs, createSection, saveExamStructure, deleteExam, restoreExam, listDeletedExams, permanentlyDeleteExam, regenerateExamCode, deleteQuestion, restoreQuestion, listDeletedQuestions, permanentlyDeleteQuestion } from "../controllers/examController.js";
import { logViolation } from "../controllers/monitoringController.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authMiddleware);

// Public routes (authenticated)
router.get("/", listExams);
router.get("/:id", getExam);
router.post("/:id/submit", submitExam);
router.post("/:id/violations", logViolation);

// Admin routes - Must place /deleted/all and /questions/deleted before /:id routes
router.get("/deleted/all", requireRole("admin"), listDeletedExams);
router.get("/questions/deleted", requireRole("admin"), listDeletedQuestions);
router.post("/", requireRole("admin"), createExam);
router.post("/:id/sections", requireRole("admin"), createSection);
router.post("/:id/questions", requireRole("admin"), addQuestions);
router.put("/:id/status", requireRole("admin"), updateExamStatus);
router.get("/:id/logs", requireRole("admin"), getExamLogs);
router.put("/:id/structure", requireRole("admin"), saveExamStructure);
router.put("/:id/regenerate-code", requireRole("admin"), regenerateExamCode);
router.delete("/:id/permanent", requireRole("admin"), permanentlyDeleteExam);
router.delete("/:id", requireRole("admin"), deleteExam);
router.put("/:id/restore", requireRole("admin"), restoreExam);

// Question specific routes
router.delete("/questions/:questionId", requireRole("admin"), deleteQuestion);
router.put("/questions/:questionId/restore", requireRole("admin"), restoreQuestion);
router.delete("/questions/:questionId/permanent", requireRole("admin"), permanentlyDeleteQuestion);

export default router;
