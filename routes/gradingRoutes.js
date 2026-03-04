import express from "express";
import { 
  gradeWritingWithAI, 
  overrideWritingGrade, 
  overrideAnswerGrade,
  bulkOverrideAnswers,
  getSubmissionsForGrading,
  getSubmissionDetail,
  exportResultsCSV
} from "../controllers/gradingController.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// AI Grading (can be triggered by student on submit or admin manually)
router.post("/writing/ai-grade", gradeWritingWithAI);

// Admin only routes
router.get("/submissions", requireRole("admin"), getSubmissionsForGrading);
router.get("/submissions/:submissionId", requireRole("admin"), getSubmissionDetail);
router.get("/export", requireRole("admin"), exportResultsCSV);

// Admin override routes
router.put("/writing/:responseId/override", requireRole("admin"), overrideWritingGrade);
router.put("/answers/:answerId/override", requireRole("admin"), overrideAnswerGrade);
router.put("/answers/bulk-override", requireRole("admin"), bulkOverrideAnswers);

export default router;
