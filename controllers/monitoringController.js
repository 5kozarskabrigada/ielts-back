import { supabase } from "../supabaseClient.js";

export const logViolation = async (req, res) => {
  const { id: examId } = req.params;
  const userId = req.user.id;
  const { type, metadata } = req.body;

  if (!type) {
    return res.status(400).json({ error: "Violation type is required" });
  }

  try {
    const { data, error } = await supabase
      .from("violations")
      .insert([
        {
          user_id: userId,
          exam_id: examId,
          violation_type: type,
          metadata: metadata || {},
          occurred_at: new Date(),
        },
      ])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
