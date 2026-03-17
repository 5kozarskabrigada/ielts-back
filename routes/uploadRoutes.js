import express from "express";
import multer from "multer";
import { uploadPassageImage, uploadListeningAudio } from "../controllers/examController.js";
import { requireRole, authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();
const IMAGE_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024; // 10MB
const AUDIO_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024; // 100MB

const imageUpload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: IMAGE_UPLOAD_LIMIT_BYTES }
});

const audioUpload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: AUDIO_UPLOAD_LIMIT_BYTES }
});

const withSingleUpload = (uploader, fieldName, limitMessage) => (req, res, next) => {
	uploader.single(fieldName)(req, res, (err) => {
		if (!err) return next();

		if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
			return res.status(400).json({ error: limitMessage });
		}

		return next(err);
	});
};

router.use(authMiddleware);

// Only admin can upload passage images
router.post(
	"/passage-image",
	requireRole("admin"),
	withSingleUpload(imageUpload, "image", "Image file is too large (max 10MB)"),
	uploadPassageImage
);

router.post(
	"/listening-audio",
	requireRole("admin"),
	withSingleUpload(audioUpload, "audio", "Audio file is too large (max 100MB)"),
	uploadListeningAudio
);

export default router;
