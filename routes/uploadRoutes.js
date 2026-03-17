import express from "express";
import multer from "multer";
import { uploadPassageImage, uploadListeningAudio } from "../controllers/examController.js";
import { requireRole, authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authMiddleware);

// Only admin can upload passage images
router.post("/passage-image", requireRole("admin"), upload.single("image"), uploadPassageImage);
router.post("/listening-audio", requireRole("admin"), upload.single("audio"), uploadListeningAudio);

export default router;
