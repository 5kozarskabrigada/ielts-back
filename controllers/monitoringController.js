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
    // Fetch from monitoring_logs table
    const { data: logs, error: logsError } = await supabase
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

    if (logsError) {
      console.error('Supabase error fetching logs:', logsError);
      throw logsError;
    }

    // Fetch from violations table
    const { data: violations, error: violationsError } = await supabase
      .from('violations')
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
      .order('occurred_at', { ascending: false });

    if (violationsError) {
      console.error('Supabase error fetching violations:', violationsError);
      // Don't throw, just log and continue with empty violations
    }

    // Format monitoring_logs
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

    // Format violations as logs
    const formattedViolations = (violations || []).map(violation => ({
      id: violation.id,
      event_type: violation.violation_type, // Use violation_type as event_type
      timestamp: violation.occurred_at, // Map occurred_at to timestamp for consistency
      metadata: violation.metadata,
      user_id: violation.user_id,
      user_name: violation.users ? `${violation.users.first_name} ${violation.users.last_name}`.trim() : 'Unknown',
      user_email: violation.users?.email,
      exam_id: violation.exam_id,
      exam_title: violation.exams?.title
    }));

    // Combine both arrays and sort by timestamp
    const allLogs = [...formattedLogs, ...formattedViolations]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json(allLogs);
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
      scores_by_module: sub.scores_by_module || {},
      total_correct: sub.total_correct || 0,
      total_questions: sub.total_questions || 0,
      status: sub.status || 'submitted',
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

    // Get violations for this submission
    const { data: violations } = await supabase
      .from('violations')
      .select('*')
      .eq('exam_id', submission.exam_id)
      .eq('user_id', submission.user_id)
      .order('occurred_at', { ascending: false });

    // Get detailed answers with question and section information
    const { data: answers, error: answersError } = await supabase
      .from('answers')
      .select(`
        *,
        questions (
          id,
          question_number,
          question_type,
          question_text,
          correct_answer,
          question_data,
          exam_sections (
            id,
            title,
            module_type,
            section_order
          )
        )
      `)
      .eq('submission_id', id)
      .order('created_at', { ascending: true });

    if (answersError) {
      console.error('Error fetching answers:', answersError);
    }

    // Format answer details for frontend
    const answerDetails = (answers || [])
      .filter(ans => ans.questions) // Skip if question was deleted and join returned null
      .map(ans => ({
        question_id: ans.question_id,
        question_number: ans.questions.question_number,
        question_type: ans.questions.question_type,
        question_text: ans.questions.question_text || '',
        user_answer: ans.user_answer,
        correct_answer: ans.questions.correct_answer,
        is_correct: ans.is_correct,
        score: ans.score,
        module_type: ans.questions.exam_sections?.module_type || 'unknown',
        section_title: ans.questions.exam_sections?.title || 'Unknown',
        section_order: ans.questions.exam_sections?.section_order || 0,
        options: ans.questions.question_data || {}
      }))
      .sort((a, b) => {
        // Sort by module order (listening first, then reading, then writing)
        const moduleOrder = { listening: 0, reading: 1, writing: 2 };
        const moduleDiff = (moduleOrder[a.module_type] || 99) - (moduleOrder[b.module_type] || 99);
        if (moduleDiff !== 0) return moduleDiff;
        // Then by section order
        if (a.section_order !== b.section_order) return a.section_order - b.section_order;
        // Then by question number
        return a.question_number - b.question_number;
      });

    // Group answers by module with correct/wrong counts
    const answersByModule = {
      listening: { correct: 0, wrong: 0, answers: [] },
      reading: { correct: 0, wrong: 0, answers: [] },
      writing: { correct: 0, wrong: 0, answers: [] }
    };

    answerDetails.forEach(ans => {
      if (answersByModule[ans.module_type]) {
        answersByModule[ans.module_type].answers.push(ans);
        if (ans.is_correct) {
          answersByModule[ans.module_type].correct++;
        } else {
          answersByModule[ans.module_type].wrong++;
        }
      }
    });

    // Get writing responses for this submission
    const { data: writingResponses } = await supabase
      .from('writing_responses')
      .select('*')
      .eq('submission_id', id)
      .order('task_number', { ascending: true });

    // Always check raw answers to fill in any missing tasks
    let rawAnswers = null;
    if (submission.answers && typeof submission.answers === 'object' && Object.keys(submission.answers).length > 0) {
      rawAnswers = submission.answers;
    } else {
      // Check autosaves table as fallback
      const { data: autosave } = await supabase
        .from('exam_autosaves')
        .select('answers_data')
        .eq('exam_id', submission.exam_id)
        .eq('user_id', submission.user_id)
        .order('last_updated', { ascending: false })
        .limit(1)
        .single();
      if (autosave?.answers_data) {
        rawAnswers = typeof autosave.answers_data === 'string' ? JSON.parse(autosave.answers_data) : autosave.answers_data;
      }
    }

    // Get writing sections for context
    const { data: writingSections } = await supabase
      .from('exam_sections')
      .select('id, section_order, title, task_config')
      .eq('exam_id', submission.exam_id)
      .eq('module_type', 'writing')
      .order('section_order', { ascending: true });

    // Build complete list: start with DB records, add missing tasks from raw answers
    const finalWritingResponses = [];
    const existingTaskNumbers = new Set((writingResponses || []).map(wr => wr.task_number));
    
    // Add all DB records first
    if (writingResponses && writingResponses.length > 0) {
      finalWritingResponses.push(...writingResponses);
    }

    // Check for missing tasks in raw answers
    if (rawAnswers && typeof rawAnswers === 'object') {
      const writingKeys = Object.keys(rawAnswers).filter(k => k.startsWith('writing_task_'));
      for (const key of writingKeys) {
        const taskNumber = parseInt(key.replace('writing_task_', ''), 10);
        if (!existingTaskNumbers.has(taskNumber)) {
          const essayText = rawAnswers[key] || '';
          const section = writingSections?.find(s => s.section_order === taskNumber - 1) || writingSections?.[taskNumber - 1];
          finalWritingResponses.push({
            id: `raw-${taskNumber}`,
            submission_id: id,
            section_id: section?.id || null,
            task_number: taskNumber,
            response_text: essayText,
            word_count: essayText.trim() ? essayText.trim().split(/\s+/).length : 0,
            section_title: section?.title || `Writing Task ${taskNumber}`,
            ai_overall_band: null,
            ai_task_response_score: null,
            ai_coherence_score: null,
            ai_lexical_score: null,
            ai_grammar_score: null,
            ai_feedback: null,
            admin_override_band: null,
            admin_feedback: null,
          });
        }
      }
    }

    // Sort by task number
    finalWritingResponses.sort((a, b) => a.task_number - b.task_number);

    res.json({
      ...submission,
      user_name: submission.users ? `${submission.users.first_name} ${submission.users.last_name}`.trim() : 'Unknown',
      user_email: submission.users?.email,
      exam_title: submission.exams?.title,
      answers: answerDetails,
      answers_by_module: answersByModule,
      writing_responses: finalWritingResponses,
      logs: logs || [],
      violations: violations || []
    });
  } catch (error) {
    console.error('Failed to fetch submission details:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch submission details' });
  }
};
