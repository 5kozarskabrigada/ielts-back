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
        users:user_id (
          id,
          first_name,
          last_name,
          email
        ),
        exams:exam_id (
          id,
          title
        )
      `)
      .order('timestamp', { ascending: false });

    if (error) {
      console.error('Supabase error fetching logs:', error);
      throw error;
    }

    // Format the response - handle potentially null data
    const formattedLogs = (logs || []).map(log => ({
      id: log.id,
      event_type: log.event_type,
      timestamp: log.timestamp,
      metadata: log.metadata,
      user_id: log.user_id,
      user_name: log.users ? `${log.users.first_name} ${log.users.last_name}`.trim() : 'Unknown',
      user_email: log.users?.email,
      exam_id: log.exam_id,
      exam_title: log.exams?.title
    }));

    res.json(formattedLogs);
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch logs' });
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
        users:user_id (
          id,
          first_name,
          last_name,
          email
        )
      `)
      .eq('exam_id', examId)
      .order('timestamp', { ascending: false });

    if (error) {
      console.error('Supabase error fetching exam logs:', error);
      throw error;
    }

    // Format the response
    const formattedLogs = (logs || []).map(log => ({
      id: log.id,
      event_type: log.event_type,
      timestamp: log.timestamp,
      metadata: log.metadata,
      user_id: log.user_id,
      user_name: log.users ? `${log.users.first_name} ${log.users.last_name}`.trim() : 'Unknown',
      user_email: log.users?.email
    }));

    res.json(formattedLogs);
  } catch (error) {
    console.error('Failed to fetch exam logs:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch exam logs' });
  }
};

// Get all submissions for admin
export const getAllSubmissions = async (req, res) => {
  try {
    const { data: submissions, error } = await supabase
      .from('exam_submissions')
      .select(`
        *,
        users:user_id (
          id,
          first_name,
          last_name,
          email
        ),
        exams:exam_id (
          id,
          title
        )
      `)
      .order('submitted_at', { ascending: false });

    if (error) {
      console.error('Supabase error fetching submissions:', error);
      throw error;
    }

    // Handle potentially null data
    const submissionsArray = submissions || [];

    // Calculate stats
    const totalSubmissions = submissionsArray.length;
    const avgBandScore = submissionsArray.length > 0
      ? (submissionsArray.reduce((sum, s) => sum + (s.band_score || 0), 0) / submissionsArray.length).toFixed(1)
      : 0;
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const thisWeekCount = submissionsArray.filter(s => new Date(s.submitted_at) > oneWeekAgo).length;

    const activeExams = new Set(submissionsArray.map(s => s.exam_id)).size;

    // Format submissions
    const formattedSubmissions = submissionsArray.map(sub => ({
      id: sub.id,
      user_id: sub.user_id,
      user_name: sub.users ? `${sub.users.first_name} ${sub.users.last_name}`.trim() : 'Unknown',
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
    res.status(500).json({ error: error.message || 'Failed to fetch submissions' });
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
        users:user_id (
          id,
          first_name,
          last_name,
          email
        ),
        exams:exam_id (
          id,
          title
        )
      `)
      .eq('id', id)
      .single();

    if (error) {
      console.error('Supabase error fetching submission details:', error);
      throw error;
    }

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Get associated logs for this submission
    const { data: logs } = await supabase
      .from('monitoring_logs')
      .select('*')
      .eq('exam_id', submission.exam_id)
      .eq('user_id', submission.user_id)
      .order('timestamp', { ascending: false });

    res.json({
      ...submission,
      user_name: submission.users ? `${submission.users.first_name} ${submission.users.last_name}`.trim() : 'Unknown',
      user_email: submission.users?.email,
      exam_title: submission.exams?.title,
      logs: logs || []
    });
  } catch (error) {
    console.error('Failed to fetch submission details:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch submission details' });
  }
};
