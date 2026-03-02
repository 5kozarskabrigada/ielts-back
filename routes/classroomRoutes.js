import express from "express";
import { listClassrooms, createClassroom, getClassroom, addStudentToClassroom, removeStudentFromClassroom } from "../controllers/classroomController.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

// All routes require authentication and admin role
router.use(authMiddleware);
router.use(requireRole("admin"));

router.get("/", listClassrooms);
router.post("/", createClassroom);
router.get("/:id", getClassroom);
router.post("/:id/students", addStudentToClassroom);
router.delete("/:id/students/:studentId", removeStudentFromClassroom);

export default router;
