import express from "express";
import { createUser, listUsers, updateUser, deleteUser, restoreUser, listDeletedUsers } from "../controllers/userController.js";
import { authMiddleware, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole("admin"));

router.get("/", listUsers);
router.get("/deleted", listDeletedUsers);
router.post("/", createUser);
router.put("/:id", updateUser);
router.delete("/:id", deleteUser);
router.put("/:id/restore", restoreUser);

export default router;
