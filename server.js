import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import examRoutes from "./routes/examRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import classroomRoutes from "./routes/classroomRoutes.js";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/exams", examRoutes);
app.use("/api/admin", adminRoutes); // Protected by authMiddleware in router
app.use("/api/classrooms", classroomRoutes); // Protected by authMiddleware in router

// Health check
app.get("/", (req, res) => {
  res.send("IELTS Platform API is running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
