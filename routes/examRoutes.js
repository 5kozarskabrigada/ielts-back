import express from "express";
import { listExams, createExam, getExam, addQuestions, submitExam, updateExamStatus, getExamLogs, createSection, saveExamStructure, deleteExam, restoreExam, listDeletedExams, permanentlyDeleteExam, regenerateExamCode, deleteQuestion, restoreQuestion, listDeletedQuestions, permanentlyDeleteQuestion, getExamStats, updateAccessCode, verifyExamCode, autosaveAnswers, logExamEvent, checkExamStatus, proxyListeningAudio } from "../controllers/examController.js";
import { logViolation } from "../controllers/monitoringController.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

// Public media proxy route (token verified in controller)
router.get("/audio-proxy", proxyListeningAudio);

router.use(authMiddleware);

// Public routes (authenticated)
router.get("/", listExams);
router.get("/:id", getExam);
router.get("/:id/status", checkExamStatus); // Check if exam was submitted / has autosave
router.post("/verify-code", verifyExamCode); // Student joins exam with code
router.post("/:id/autosave", autosaveAnswers); // Auto-save during exam
router.post("/:id/log", logExamEvent); // Log exam events
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
router.get("/:id/stats", requireRole("admin"), getExamStats);
router.put("/:id/structure", requireRole("admin"), saveExamStructure);
router.put("/:id/regenerate-code", requireRole("admin"), regenerateExamCode);
router.put("/:id/access-code", requireRole("admin"), updateAccessCode);
router.delete("/:id/permanent", requireRole("admin"), permanentlyDeleteExam);
router.delete("/:id", requireRole("admin"), deleteExam);
router.put("/:id/restore", requireRole("admin"), restoreExam);

// Question specific routes
router.delete("/questions/:questionId", requireRole("admin"), deleteQuestion);
router.put("/questions/:questionId/restore", requireRole("admin"), restoreQuestion);
router.delete("/questions/:questionId/permanent", requireRole("admin"), permanentlyDeleteQuestion);

export default router;
