import { pool } from "../db.js";

export const listClassrooms = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, (SELECT COUNT(*) FROM classroom_students cs WHERE cs.classroom_id = c.id) AS student_count
       FROM classrooms c
       ORDER BY c.created_at DESC`
    );

    // Match Supabase response shape: students: [{ count: N }]
    const data = rows.map(row => {
      const { student_count, ...rest } = row;
      return { ...rest, students: [{ count: parseInt(student_count) }] };
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const createClassroom = async (req, res) => {
  const { name, description } = req.body;
  const createdBy = req.user?.id || null;

  if (!name) {
    return res.status(400).json({ error: "Classroom name is required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO classrooms (name, description, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [name, description || null, createdBy]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Create Classroom Error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const addStudentToClassroom = async (req, res) => {
  const { id } = req.params;
  const { studentId } = req.body;

  try {
    const { rows } = await pool.query(
      `INSERT INTO classroom_students (classroom_id, student_id) VALUES ($1, $2) RETURNING *`,
      [id, studentId]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: "Student already in classroom" });
    }
    res.status(500).json({ error: err.message });
  }
};

export const removeStudentFromClassroom = async (req, res) => {
  const { id, studentId } = req.params;

  try {
    await pool.query(
      `DELETE FROM classroom_students WHERE classroom_id = $1 AND student_id = $2`,
      [id, studentId]
    );

    res.json({ message: "Student removed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getClassroom = async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: classroomRows } = await pool.query(
      `SELECT * FROM classrooms WHERE id = $1`, [id]
    );

    if (classroomRows.length === 0) return res.status(404).json({ error: "Classroom not found" });

    const { rows: studentRows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.username
       FROM classroom_students cs
       JOIN users u ON u.id = cs.student_id
       WHERE cs.classroom_id = $1`,
      [id]
    );

    res.json({ ...classroomRows[0], students: studentRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateClassroom = async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Classroom name is required" });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE classrooms SET name = $1, description = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [name, description || null, id]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Classroom not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteClassroom = async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query(`DELETE FROM classroom_students WHERE classroom_id = $1`, [id]);
    await pool.query(`DELETE FROM classrooms WHERE id = $1`, [id]);
    res.json({ message: "Classroom deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
