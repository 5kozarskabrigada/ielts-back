import crypto from "crypto";
import { supabase } from "../supabaseClient.js";

export const listUsers = async (req, res) => {
  const { q } = req.query;
  try {
    let query = supabase
      .from("users")
      .select("*")
      .eq("is_deleted", false)
      .order("created_at", { ascending: false });

    if (q) {
      query = query.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%,username.ilike.%${q}%`);
    }

    const { data, error } = await query;

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const createUser = async (req, res) => {
  const { firstName, lastName, email, role = "student", password } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "First Name and Last Name are required" });
  }

  // Auto-generate username: firstname.lastname + random suffix for uniqueness
  const randomSuffix = Math.random().toString(36).substring(2, 6);
  let username = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z0-9]/g, "") + "." + randomSuffix;

  // Password: provided or auto-generated
  const rawPassword = password || Math.random().toString(36).slice(-8);
  // Simple SHA-256 hash for MVP (Not secure for production, but avoids bcrypt issues)
const hashPassword = (password) => {
  return crypto.createHash("sha256").update(password).digest("hex");
};

const passwordHash = hashPassword(rawPassword);

  try {
    const { data, error } = await supabase
      .from("users")
      .insert([
        {
          first_name: firstName,
          last_name: lastName,
          email: email || null, // Allow null
          username,
          password_hash: passwordHash,
          role,
        },
      ])
      .select()
      .single();

    if (error) {
      if (error.code === "23505") { // Unique violation
        return res.status(409).json({ error: "Email or username already exists" });
      }
      throw error;
    }

    // Return the raw password so admin can distribute it
    res.status(201).json({ ...data, temp_password: rawPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateUser = async (req, res) => {
  const { id } = req.params;
  const { firstName, lastName, email, role, isActive } = req.body;

  try {
    const updates = {};
    if (firstName) updates.first_name = firstName;
    if (lastName) updates.last_name = lastName;
    if (email !== undefined) updates.email = email || null;
    if (role) updates.role = role;
    if (typeof isActive === "boolean") updates.is_active = isActive;

    const { data, error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    // Soft delete
    const { data, error } = await supabase
      .from("users")
      .update({ is_deleted: true, is_active: false })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json({ message: "User deleted successfully", user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
