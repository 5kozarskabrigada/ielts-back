import express from "express";
import { logViolation } from "../controllers/monitoringController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authMiddleware);

router.post("/:id/violations", logViolation);

export default router;
