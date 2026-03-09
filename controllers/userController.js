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

  // Auto-generate username: firstname.lastname + 4 random digits for uniqueness
  const randomDigits = Math.floor(1000 + Math.random() * 9000); // 4 digit number (1000-9999)
  const username = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomDigits}`.replace(/[^a-z0-9.]/g, "");

  // Password: provided or auto-generated
  const rawPassword = password || Math.random().toString(36).slice(-8);

  // Simple SHA-256 hash for MVP
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
  const { firstName, lastName, email, role, isActive, password } = req.body;

  try {
    const updates = {};
    if (firstName) updates.first_name = firstName;
    if (lastName) updates.last_name = lastName;
    if (email !== undefined) updates.email = email || null;
    if (role) updates.role = role;
    if (typeof isActive === "boolean") updates.is_active = isActive;
    if (password) {
      // Simple SHA-256 hash for MVP
      updates.password_hash = crypto.createHash("sha256").update(password).digest("hex");
    }

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
    // Soft delete user
    const { data, error } = await supabase
      .from("users")
      .update({ is_deleted: true, is_active: false })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    // Also soft-handle submissions: mark them so they don't clutter results
    // (actual deletion happens in permanentlyDeleteUser)
    
    res.json({ message: "User deleted successfully", user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const restoreUser = async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from("users")
      .update({ is_deleted: false, is_active: true })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json({ message: "User restored successfully", user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const listDeletedUsers = async (req, res) => {
  try {
    // Check if is_deleted column exists first or handle error
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("is_deleted", true)
      .order("updated_at", { ascending: false });

    if (error) {
      // If column doesn't exist, return empty array instead of 500
      if (error.code === '42703') { // Undefined column
        console.warn("is_deleted column missing in users table");
        return res.json([]);
      }
      throw error;
    }
    res.json(data);
  } catch (err) {
    console.error("List Deleted Users Error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const permanentlyDeleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    // Get all submission IDs for this user
    const { data: submissions } = await supabase
      .from("exam_submissions")
      .select("id")
      .eq("user_id", id);

    const submissionIds = (submissions || []).map(s => s.id);

    // Delete answers linked to user's submissions
    if (submissionIds.length > 0) {
      await supabase.from("answers").delete().in("submission_id", submissionIds);
      await supabase.from("writing_responses").delete().in("submission_id", submissionIds);
    }

    // Delete submissions, violations, and monitoring logs
    await supabase.from("exam_submissions").delete().eq("user_id", id);
    await supabase.from("violations").delete().eq("user_id", id);
    await supabase.from("monitoring_logs").delete().eq("user_id", id);

    // Permanently delete user from database
    const { error } = await supabase
      .from("users")
      .delete()
      .eq("id", id);

    if (error) throw error;
    res.json({ message: "User permanently deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
