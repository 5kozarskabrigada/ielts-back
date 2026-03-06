import express from "express";
import multer from "multer";
import { uploadPassageImage } from "../controllers/examController.js";
import { requireRole, authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authMiddleware);

// Only admin can upload passage images
router.post("/passage-image", requireRole("admin"), upload.single("image"), uploadPassageImage);

export default router;
