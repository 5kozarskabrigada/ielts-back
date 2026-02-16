import express from "express";
import { login, registerDevAdmin, forgotPassword } from "../controllers/authController.js";

const router = express.Router();

router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/dev/register", registerDevAdmin);

export default router;
