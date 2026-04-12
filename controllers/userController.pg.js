import crypto from "crypto";
import { pool } from "../db.js";

export const listUsers = async (req, res) => {
  const { q } = req.query;
  try {
    let query, params;
    if (q) {
      const pattern = `%${q}%`;
      query = `SELECT * FROM users WHERE is_deleted = false
               AND (first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR username ILIKE $1)
               ORDER BY created_at DESC`;
      params = [pattern];
    } else {
      query = `SELECT * FROM users WHERE is_deleted = false ORDER BY created_at DESC`;
      params = [];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const createUser = async (req, res) => {
  const { firstName, lastName, email, role = "student", password } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "First Name and Last Name are required" });
  }

  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  const username = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomDigits}`.replace(/[^a-z0-9.]/g, "");

  const rawPassword = password || Math.random().toString(36).slice(-8);
  const passwordHash = crypto.createHash("sha256").update(rawPassword).digest("hex");

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (first_name, last_name, email, username, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [firstName, lastName, email || null, username, passwordHash, role]
    );

    res.status(201).json({ ...rows[0], temp_password: rawPassword });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Email or username already exists" });
    }
    res.status(500).json({ error: err.message });
  }
};

export const updateUser = async (req, res) => {
  const { id } = req.params;
  const { firstName, lastName, email, role, isActive, password } = req.body;

  try {
    const sets = [];
    const params = [];
    let idx = 1;

    if (firstName) { sets.push(`first_name = $${idx++}`); params.push(firstName); }
    if (lastName) { sets.push(`last_name = $${idx++}`); params.push(lastName); }
    if (email !== undefined) { sets.push(`email = $${idx++}`); params.push(email || null); }
    if (role) { sets.push(`role = $${idx++}`); params.push(role); }
    if (typeof isActive === "boolean") { sets.push(`is_active = $${idx++}`); params.push(isActive); }
    if (password) {
      sets.push(`password_hash = $${idx++}`);
      params.push(crypto.createHash("sha256").update(password).digest("hex"));
    }

    if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      params
    );

    if (rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_deleted = true, is_active = false WHERE id = $1 RETURNING *`,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json({ message: "User deleted successfully", user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const restoreUser = async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_deleted = false, is_active = true WHERE id = $1 RETURNING *`,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json({ message: "User restored successfully", user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const listDeletedUsers = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE is_deleted = true ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("List Deleted Users Error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const permanentlyDeleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    // Get all submission IDs for this user
    const { rows: submissions } = await pool.query(
      `SELECT id FROM exam_submissions WHERE user_id = $1`, [id]
    );
    const submissionIds = submissions.map(s => s.id);

    if (submissionIds.length > 0) {
      await pool.query(`DELETE FROM answers WHERE submission_id = ANY($1)`, [submissionIds]);
      await pool.query(`DELETE FROM writing_responses WHERE submission_id = ANY($1)`, [submissionIds]);
    }

    await pool.query(`DELETE FROM exam_submissions WHERE user_id = $1`, [id]);
    await pool.query(`DELETE FROM violations WHERE user_id = $1`, [id]);
    await pool.query(`DELETE FROM monitoring_logs WHERE user_id = $1`, [id]);

    const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1`, [id]);

    if (rowCount === 0) return res.status(404).json({ error: "User not found" });
    res.json({ message: "User permanently deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
