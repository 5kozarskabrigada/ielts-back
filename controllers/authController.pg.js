import crypto from "crypto";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const hashPassword = (password) => {
  return crypto.createHash("sha256").update(password).digest("hex");
};

if (!JWT_SECRET) {
  console.warn("WARNING: JWT_SECRET is not defined in environment variables.");
}

export const login = async (req, res) => {
  const { email, password } = req.body; // 'email' field can now hold email OR username

  if (!email || !password) {
    return res.status(400).json({ error: "Please provide both username/email and password" });
  }

  try {
    const isEmail = email.includes("@");
    const column = isEmail ? "email" : "username";
    const value = isEmail ? email : email.toLowerCase();

    const { rows } = await pool.query(
      `SELECT * FROM users WHERE ${column} = $1 LIMIT 1`,
      [value]
    );
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.is_deleted) {
      return res.status(403).json({ error: "Account has been deactivated" });
    }

    const match = hashPassword(password) === user.password_hash;
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [email]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    const resetToken = Math.random().toString(36).substring(2, 15);
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      `UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3`,
      [resetToken, expires, user.id]
    );

    const resetLink = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
    console.log(`[EMAIL MOCK] Password reset link for ${email}: ${resetLink}`);
    
    res.json({ message: "Password reset link sent to your email (check server console)" });
  } catch (err) {
    res.status(500).json({ error: "Failed to process request" });
  }
};

export const registerDevAdmin = async (req, res) => {
  const { email, password, firstName, lastName, username } = req.body;

  try {
    const passwordHash = hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, username, role)
       VALUES ($1, $2, $3, $4, $5, 'admin')
       RETURNING *`,
      [email, passwordHash, firstName, lastName, username || `${firstName}.${lastName}`.toLowerCase()]
    );

    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: "Email or username already exists" });
    }
    res.status(500).json({ error: "Failed to create admin" });
  }
};
