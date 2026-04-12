import express from "express";
import { 
  logViolation, 
  getAllLogs, 
  getExamLogs,
  getAllSubmissions,
  getSubmissionDetails
} from "../controllers/monitoringController.pg.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authMiddleware);

router.post("/:id/violations", logViolation);

// Logs endpoints
router.get("/logs/all", getAllLogs);
router.get("/logs/exam/:examId", getExamLogs);

// Submissions endpoints
router.get("/submissions/all", getAllSubmissions);
router.get("/submissions/:id", getSubmissionDetails);

export default router;
