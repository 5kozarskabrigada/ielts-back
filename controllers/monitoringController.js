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

// Get all logs for admin
export const getAllLogs = async (req, res) => {
  try {
    const { data: logs, error } = await supabase
      .from('monitoring_logs')
      .select(`
        *,
        users!monitoring_logs_user_id_fkey (
          id,
          full_name,
          email
        ),
        exams!monitoring_logs_exam_id_fkey (
          id,
          title
        )
      `)
      .order('timestamp', { ascending: false });

    if (error) throw error;

    // Format the response
    const formattedLogs = logs.map(log => ({
      id: log.id,
      event_type: log.event_type,
      timestamp: log.timestamp,
      metadata: log.metadata,
      user_id: log.user_id,
      user_name: log.users?.full_name,
      user_email: log.users?.email,
      exam_id: log.exam_id,
      exam_title: log.exams?.title
    }));

    res.json(formattedLogs);
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
};

// Get logs for a specific exam
export const getExamLogs = async (req, res) => {
  try {
    const { examId } = req.params;

    const { data: logs, error } = await supabase
      .from('monitoring_logs')
      .select(`
        *,
        users!monitoring_logs_user_id_fkey (
          id,
          full_name,
          email
        )
      `)
      .eq('exam_id', examId)
      .order('timestamp', { ascending: false });

    if (error) throw error;

    // Format the response
    const formattedLogs = logs.map(log => ({
      id: log.id,
      event_type: log.event_type,
      timestamp: log.timestamp,
      metadata: log.metadata,
      user_id: log.user_id,
      user_name: log.users?.full_name,
      user_email: log.users?.email
    }));

    res.json(formattedLogs);
  } catch (error) {
    console.error('Failed to fetch exam logs:', error);
    res.status(500).json({ error: 'Failed to fetch exam logs' });
  }
};

// Get all submissions for admin
export const getAllSubmissions = async (req, res) => {
  try {
    const { data: submissions, error } = await supabase
      .from('exam_submissions')
      .select(`
        *,
        users!exam_submissions_user_id_fkey (
          id,
          full_name,
          email
        ),
        exams!exam_submissions_exam_id_fkey (
          id,
          title
        )
      `)
      .order('submitted_at', { ascending: false });

    if (error) throw error;

    // Calculate stats
    const totalSubmissions = submissions.length;
    const avgBandScore = submissions.length > 0
      ? (submissions.reduce((sum, s) => sum + (s.band_score || 0), 0) / submissions.length).toFixed(1)
      : 0;
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const thisWeekCount = submissions.filter(s => new Date(s.submitted_at) > oneWeekAgo).length;

    const activeExams = new Set(submissions.map(s => s.exam_id)).size;

    // Format submissions
    const formattedSubmissions = submissions.map(sub => ({
      id: sub.id,
      user_id: sub.user_id,
      user_name: sub.users?.full_name,
      user_email: sub.users?.email,
      exam_id: sub.exam_id,
      exam_title: sub.exams?.title,
      submitted_at: sub.submitted_at,
      band_score: sub.band_score,
      answers: sub.answers,
      time_spent: sub.time_spent
    }));

    res.json({
      stats: {
        total: totalSubmissions,
        avgBandScore,
        thisWeek: thisWeekCount,
        activeExams
      },
      submissions: formattedSubmissions
    });
  } catch (error) {
    console.error('Failed to fetch submissions:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
};

// Get detailed submission by ID
export const getSubmissionDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: submission, error } = await supabase
      .from('exam_submissions')
      .select(`
        *,
        users!exam_submissions_user_id_fkey (
          id,
          full_name,
          email
        ),
        exams!exam_submissions_exam_id_fkey (
          id,
          title
        )
      `)
      .eq('id', id)
      .single();

    if (error) throw error;

    // Get associated logs for this submission
    const { data: logs } = await supabase
      .from('monitoring_logs')
      .select('*')
      .eq('exam_id', submission.exam_id)
      .eq('user_id', submission.user_id)
      .order('timestamp', { ascending: false });

    res.json({
      ...submission,
      user_name: submission.users?.full_name,
      user_email: submission.users?.email,
      exam_title: submission.exams?.title,
      logs: logs || []
    });
  } catch (error) {
    console.error('Failed to fetch submission details:', error);
    res.status(500).json({ error: 'Failed to fetch submission details' });
  }
};
