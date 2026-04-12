import { pool } from "../db.js";

export const logViolation = async (req, res) => {
  const { id: examId } = req.params;
  const userId = req.user.id;
  const { type, metadata } = req.body;

  if (!type) {
    return res.status(400).json({ error: "Violation type is required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO violations (user_id, exam_id, violation_type, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [userId, examId, type, JSON.stringify(metadata || {})]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getAllLogs = async (req, res) => {
  try {
    const { rows: logs } = await pool.query(
      `SELECT ml.*,
              u.id AS user_id_ref, u.first_name, u.last_name, u.email AS user_email,
              e.id AS exam_id_ref, e.title AS exam_title
       FROM monitoring_logs ml
       LEFT JOIN users u ON u.id = ml.user_id
       LEFT JOIN exams e ON e.id = ml.exam_id
       ORDER BY ml.timestamp DESC`
    );

    const { rows: violations } = await pool.query(
      `SELECT v.*,
              u.id AS user_id_ref, u.first_name, u.last_name, u.email AS user_email,
              e.id AS exam_id_ref, e.title AS exam_title
       FROM violations v
       LEFT JOIN users u ON u.id = v.user_id
       LEFT JOIN exams e ON e.id = v.exam_id
       ORDER BY v.occurred_at DESC`
    );

    const formattedLogs = logs.map(log => ({
      id: log.id,
      event_type: log.event_type,
      timestamp: log.timestamp,
      metadata: log.metadata,
      user_id: log.user_id,
      user_name: `${log.first_name || ''} ${log.last_name || ''}`.trim() || 'Unknown',
      user_email: log.user_email,
      exam_id: log.exam_id,
      exam_title: log.exam_title
    }));

    const formattedViolations = violations.map(v => ({
      id: v.id,
      event_type: v.violation_type,
      timestamp: v.occurred_at,
      metadata: v.metadata,
      user_id: v.user_id,
      user_name: `${v.first_name || ''} ${v.last_name || ''}`.trim() || 'Unknown',
      user_email: v.user_email,
      exam_id: v.exam_id,
      exam_title: v.exam_title
    }));

    const allLogs = [...formattedLogs, ...formattedViolations]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json(allLogs);
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch logs' });
  }
};

export const getExamLogs = async (req, res) => {
  try {
    const { examId } = req.params;

    const { rows: logs } = await pool.query(
      `SELECT ml.*,
              u.first_name, u.last_name, u.email AS user_email
       FROM monitoring_logs ml
       LEFT JOIN users u ON u.id = ml.user_id
       WHERE ml.exam_id = $1
       ORDER BY ml.timestamp DESC`,
      [examId]
    );

    const formattedLogs = logs.map(log => ({
      id: log.id,
      event_type: log.event_type,
      timestamp: log.timestamp,
      metadata: log.metadata,
      user_id: log.user_id,
      user_name: `${log.first_name || ''} ${log.last_name || ''}`.trim() || 'Unknown',
      user_email: log.user_email
    }));

    res.json(formattedLogs);
  } catch (error) {
    console.error('Failed to fetch exam logs:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch exam logs' });
  }
};

export const getAllSubmissions = async (req, res) => {
  try {
    const { rows: submissions } = await pool.query(
      `SELECT es.*,
              u.id AS u_id, u.first_name, u.last_name, u.email AS user_email,
              e.id AS e_id, e.title AS exam_title
       FROM exam_submissions es
       LEFT JOIN users u ON u.id = es.user_id
       LEFT JOIN exams e ON e.id = es.exam_id
       ORDER BY es.submitted_at DESC`
    );

    const totalSubmissions = submissions.length;
    const avgBandScore = totalSubmissions > 0
      ? (submissions.reduce((sum, s) => sum + (parseFloat(s.band_score) || 0), 0) / totalSubmissions).toFixed(1)
      : 0;
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const thisWeekCount = submissions.filter(s => new Date(s.submitted_at) > oneWeekAgo).length;
    const activeExams = new Set(submissions.map(s => s.exam_id)).size;

    const formattedSubmissions = submissions.map(sub => ({
      id: sub.id,
      user_id: sub.user_id,
      user_name: `${sub.first_name || ''} ${sub.last_name || ''}`.trim() || 'Unknown',
      user_email: sub.user_email,
      exam_id: sub.exam_id,
      exam_title: sub.exam_title,
      submitted_at: sub.submitted_at,
      band_score: sub.band_score,
      scores_by_module: sub.scores_by_module || {},
      total_correct: sub.total_correct || 0,
      total_questions: sub.total_questions || 0,
      status: sub.status || 'submitted',
      time_spent: sub.time_spent
    }));

    res.json({
      stats: { total: totalSubmissions, avgBandScore, thisWeek: thisWeekCount, activeExams },
      submissions: formattedSubmissions
    });
  } catch (error) {
    console.error('Failed to fetch submissions:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch submissions' });
  }
};

export const getSubmissionDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: subRows } = await pool.query(
      `SELECT es.*,
              u.first_name, u.last_name, u.email AS user_email,
              e.title AS exam_title, e.modules_config
       FROM exam_submissions es
       LEFT JOIN users u ON u.id = es.user_id
       LEFT JOIN exams e ON e.id = es.exam_id
       WHERE es.id = $1`,
      [id]
    );

    if (subRows.length === 0) return res.status(404).json({ error: 'Submission not found' });
    const submission = subRows[0];

    const { rows: logs } = await pool.query(
      `SELECT * FROM monitoring_logs WHERE exam_id = $1 AND user_id = $2 ORDER BY timestamp DESC`,
      [submission.exam_id, submission.user_id]
    );

    const { rows: violations } = await pool.query(
      `SELECT * FROM violations WHERE exam_id = $1 AND user_id = $2 ORDER BY occurred_at DESC`,
      [submission.exam_id, submission.user_id]
    );

    const { rows: answers } = await pool.query(
      `SELECT a.*,
              q.id AS q_id, q.question_number, q.question_type, q.question_text,
              q.correct_answer, q.question_data,
              s.id AS section_id, s.title AS section_title, s.module_type, s.section_order
       FROM answers a
       LEFT JOIN questions q ON q.id = a.question_id
       LEFT JOIN exam_sections s ON s.id = q.section_id
       WHERE a.submission_id = $1
       ORDER BY a.created_at ASC`,
      [id]
    );

    const answerDetails = answers
      .filter(ans => ans.q_id)
      .map(ans => ({
        question_id: ans.question_id,
        question_number: ans.question_number,
        question_type: ans.question_type,
        question_text: ans.question_text || '',
        user_answer: ans.user_answer,
        correct_answer: ans.correct_answer,
        is_correct: ans.is_correct,
        score: ans.score,
        module_type: ans.module_type || 'unknown',
        section_title: ans.section_title || 'Unknown',
        section_order: ans.section_order || 0,
        options: ans.question_data || {}
      }))
      .sort((a, b) => {
        const moduleOrder = { listening: 0, reading: 1, writing: 2 };
        const moduleDiff = (moduleOrder[a.module_type] || 99) - (moduleOrder[b.module_type] || 99);
        if (moduleDiff !== 0) return moduleDiff;
        if (a.section_order !== b.section_order) return a.section_order - b.section_order;
        return a.question_number - b.question_number;
      });

    const answersByModule = {
      listening: { correct: 0, wrong: 0, answers: [] },
      reading: { correct: 0, wrong: 0, answers: [] },
      writing: { correct: 0, wrong: 0, answers: [] }
    };

    answerDetails.forEach(ans => {
      if (answersByModule[ans.module_type]) {
        answersByModule[ans.module_type].answers.push(ans);
        if (ans.is_correct) answersByModule[ans.module_type].correct++;
        else answersByModule[ans.module_type].wrong++;
      }
    });

    // Recover summary_completion answers from raw submission data
    const rawSubmissionAnswers = submission.answers;
    if (rawSubmissionAnswers && typeof rawSubmissionAnswers === 'object') {
      const placeholderKeys = Object.keys(rawSubmissionAnswers).filter(k => k.startsWith('summary_placeholder_'));
      if (placeholderKeys.length > 0) {
        const allGroups = [
          ...(submission.modules_config?.listening_question_groups || []),
          ...(submission.modules_config?.reading_question_groups || [])
        ];
        const { rows: examSections } = await pool.query(
          `SELECT id, module_type, title, section_order FROM exam_sections WHERE exam_id = $1`,
          [submission.exam_id]
        );
        const sectionMap = {};
        examSections.forEach(s => { sectionMap[s.id] = s; });

        for (const key of placeholderKeys) {
          const parts = key.replace('summary_placeholder_', '').split('_');
          const blankIndex = parseInt(parts.pop(), 10);
          const groupId = parts.join('_');
          const group = allGroups.find(g => g.id === groupId);
          if (!group) continue;

          const qNum = group.question_range_start + blankIndex;
          const userAnswer = rawSubmissionAnswers[key];
          const correctAnswer = group.summary_data?.answers?.[blankIndex] || '';
          const section = sectionMap[group.section_id];
          const moduleType = section?.module_type || 'reading';

          const alreadyExists = answerDetails.some(a =>
            a.section_order === (section?.section_order || 0) && a.question_number === qNum
          );
          if (alreadyExists) continue;

          const userStr = userAnswer ? String(userAnswer).trim().toLowerCase() : '';
          let isCorrect = false;
          if (userStr && correctAnswer) {
            const correctOptions = String(correctAnswer).split('/').map(s => s.trim().toLowerCase());
            isCorrect = correctOptions.includes(userStr);
          }

          const entry = {
            question_id: key,
            question_number: qNum,
            question_type: 'summary_completion',
            question_text: `Summary completion blank ${blankIndex + 1}`,
            user_answer: userAnswer || null,
            correct_answer: correctAnswer,
            is_correct: isCorrect,
            score: isCorrect ? 1 : 0,
            module_type: moduleType,
            section_title: section?.title || 'Unknown',
            section_order: section?.section_order || 0,
            options: {}
          };

          answerDetails.push(entry);
          if (answersByModule[moduleType]) {
            answersByModule[moduleType].answers.push(entry);
            if (isCorrect) answersByModule[moduleType].correct++;
            else answersByModule[moduleType].wrong++;
          }
        }

        answerDetails.sort((a, b) => {
          const moduleOrder = { listening: 0, reading: 1, writing: 2 };
          const moduleDiff = (moduleOrder[a.module_type] || 99) - (moduleOrder[b.module_type] || 99);
          if (moduleDiff !== 0) return moduleDiff;
          if (a.section_order !== b.section_order) return a.section_order - b.section_order;
          return a.question_number - b.question_number;
        });
      }
    }

    // Writing responses
    const { rows: writingResponses } = await pool.query(
      `SELECT * FROM writing_responses WHERE submission_id = $1 ORDER BY task_number ASC`,
      [id]
    );

    let rawAnswers = null;
    if (submission.answers && typeof submission.answers === 'object' && Object.keys(submission.answers).length > 0) {
      rawAnswers = submission.answers;
    } else {
      const { rows: autosaveRows } = await pool.query(
        `SELECT answers_data FROM exam_autosaves
         WHERE exam_id = $1 AND user_id = $2
         ORDER BY last_updated DESC LIMIT 1`,
        [submission.exam_id, submission.user_id]
      );
      if (autosaveRows[0]?.answers_data) {
        rawAnswers = typeof autosaveRows[0].answers_data === 'string'
          ? JSON.parse(autosaveRows[0].answers_data)
          : autosaveRows[0].answers_data;
      }
    }

    const { rows: writingSections } = await pool.query(
      `SELECT id, section_order, title, task_config
       FROM exam_sections
       WHERE exam_id = $1 AND module_type = 'writing'
       ORDER BY section_order ASC`,
      [submission.exam_id]
    );

    const finalWritingResponses = [];
    const existingTaskNumbers = new Set(writingResponses.map(wr => wr.task_number));

    if (writingResponses.length > 0) {
      finalWritingResponses.push(...writingResponses);
    }

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
            ai_overall_band: null, ai_task_response_score: null,
            ai_coherence_score: null, ai_lexical_score: null, ai_grammar_score: null,
            ai_feedback: null, admin_override_band: null, admin_feedback: null,
          });
          existingTaskNumbers.add(taskNumber);
        }
      }
    }

    if (writingSections && writingSections.length > 0) {
      for (let i = 0; i < writingSections.length; i++) {
        const taskNumber = i + 1;
        if (!existingTaskNumbers.has(taskNumber)) {
          const section = writingSections[i];
          finalWritingResponses.push({
            id: `empty-${taskNumber}`,
            submission_id: id, section_id: section?.id || null,
            task_number: taskNumber, response_text: '', word_count: 0,
            section_title: section?.title || `Writing Task ${taskNumber}`,
            ai_overall_band: null, ai_task_response_score: null,
            ai_coherence_score: null, ai_lexical_score: null, ai_grammar_score: null,
            ai_feedback: null, admin_override_band: null, admin_feedback: null,
          });
        }
      }
    }

    finalWritingResponses.sort((a, b) => a.task_number - b.task_number);

    res.json({
      ...submission,
      user_name: `${submission.first_name || ''} ${submission.last_name || ''}`.trim() || 'Unknown',
      user_email: submission.user_email,
      exam_title: submission.exam_title,
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
