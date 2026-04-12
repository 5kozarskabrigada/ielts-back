import { pool } from "../db.js";

export const getDashboardStats = async (req, res) => {
  try {
    const [userResult, activeResult, completedResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users WHERE role = 'student'`),
      pool.query(`SELECT COUNT(*) FROM exams WHERE status = 'active'`),
      pool.query(`SELECT COUNT(*) FROM exam_submissions WHERE status = 'completed'`),
    ]);

    res.json({
      totalUsers: parseInt(userResult.rows[0].count) || 0,
      activeExams: parseInt(activeResult.rows[0].count) || 0,
      completedExams: parseInt(completedResult.rows[0].count) || 0,
      pendingGrading: 0,
      systemHealth: "Operational"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getAdminLogs = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT al.*, u.username AS admin_username
       FROM admin_logs al
       LEFT JOIN users u ON u.id = al.admin_id
       ORDER BY al.created_at DESC
       LIMIT 50`
    );

    // Match Supabase response shape: admin: { username }
    const data = rows.map(row => {
      const { admin_username, ...rest } = row;
      return { ...rest, admin: { username: admin_username } };
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getScoringConfigs = async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM scoring_configs`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateScoringConfig = async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  const adminId = req.user.id;

  try {
    const { rows } = await pool.query(
      `INSERT INTO scoring_configs (config_key, config_value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (config_key) DO UPDATE SET config_value = $2, updated_by = $3, updated_at = NOW()
       RETURNING *`,
      [key, JSON.stringify(value), adminId]
    );

    // Audit Log
    await pool.query(
      `INSERT INTO admin_logs (admin_id, action_type, target_resource, details)
       VALUES ($1, 'UPDATE_CONFIG', 'scoring_configs', $2)`,
      [adminId, JSON.stringify({ key, value_preview: JSON.stringify(value).substring(0, 50) })]
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
