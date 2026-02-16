import crypto from "crypto";
import jwt from "jsonwebtoken";
import { supabase } from "../supabaseClient.js";

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
    // Check if input looks like an email
    const isEmail = email.includes("@");
    const column = isEmail ? "email" : "username";

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq(column, isEmail ? email : email.toLowerCase()) // Username is case-insensitive usually
      .single();

    if (error || !user) {
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
    const { data: user } = await supabase.from("users").select("id").eq("email", email).single();
    if (!user) return res.status(404).json({ error: "User not found" });

    // Generate token (simple random string for MVP)
    const resetToken = Math.random().toString(36).substring(2, 15);
    const expires = new Date(Date.now() + 3600000); // 1 hour

    // Store token (assuming schema update applied)
    await supabase.from("users").update({
      reset_token: resetToken,
      reset_token_expires: expires
    }).eq("id", user.id);

    // Mock sending email
    const resetLink = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
    console.log(`[EMAIL MOCK] Password reset link for ${email}: ${resetLink}`);
    
    res.json({ message: "Password reset link sent to your email (check server console)" });
  } catch (err) {
    res.status(500).json({ error: "Failed to process request" });
  }
};

// Helper for development to create the first admin
export const registerDevAdmin = async (req, res) => {
  const { email, password, firstName, lastName, username } = req.body;

  try {
    const passwordHash = hashPassword(password);
    const { data, error } = await supabase
      .from("users")
      .insert([
        {
          email,
          password_hash: passwordHash,
          first_name: firstName,
          last_name: lastName,
          username: username || `${firstName}.${lastName}`.toLowerCase(),
          role: "admin",
        },
      ])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to create admin" });
  }
};
