import { supabase } from "../supabaseClient.js";

export const getDashboardStats = async (req, res) => {
  try {
    const { count: userCount, error: userError } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .eq("role", "student");

    const { count: activeExams, error: activeError } = await supabase
      .from("exams")
      .select("*", { count: "exact", head: true })
      .eq("status", "active");

    const { count: completedExams, error: completedError } = await supabase
      .from("exam_submissions")
      .select("*", { count: "exact", head: true })
      .eq("status", "completed");

    if (userError || activeError || completedError) throw new Error("Failed to fetch stats");

    res.json({
      totalUsers: userCount || 0,
      activeExams: activeExams || 0,
      completedExams: completedExams || 0,
      pendingGrading: 0, // Placeholder for async AI grading queue
      systemHealth: "Operational"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getAdminLogs = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("admin_logs")
      .select("*, admin:admin_id(username)")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getScoringConfigs = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("scoring_configs")
      .select("*");

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateScoringConfig = async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  const adminId = req.user.id;

  try {
    const { data, error } = await supabase
      .from("scoring_configs")
      .upsert({ 
        config_key: key, 
        config_value: value, 
        updated_by: adminId,
        updated_at: new Date()
      })
      .select()
      .single();

    if (error) throw error;

    // Audit Log
    await supabase.from("admin_logs").insert({
      admin_id: adminId,
      action_type: "UPDATE_CONFIG",
      target_resource: "scoring_configs",
      details: { key, value_preview: JSON.stringify(value).substring(0, 50) }
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
