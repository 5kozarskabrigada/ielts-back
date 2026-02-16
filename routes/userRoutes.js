import express from "express";
import { createUser, listUsers, updateUser, deleteUser } from "../controllers/userController.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole("admin"));

router.get("/", listUsers);
router.post("/", createUser);
router.put("/:id", updateUser);
router.delete("/:id", deleteUser);

export default router;
