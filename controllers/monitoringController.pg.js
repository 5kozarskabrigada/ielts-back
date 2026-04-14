import { pool } from "../db.js";

const LISTENING_BAND_TABLE = [
  { min: 39, max: 40, band: 9.0 },
  { min: 37, max: 38, band: 8.5 },
  { min: 35, max: 36, band: 8.0 },
  { min: 32, max: 34, band: 7.5 },
  { min: 30, max: 31, band: 7.0 },
  { min: 26, max: 29, band: 6.5 },
  { min: 23, max: 25, band: 6.0 },
  { min: 18, max: 22, band: 5.5 },
  { min: 16, max: 17, band: 5.0 },
  { min: 13, max: 15, band: 4.5 },
  { min: 10, max: 12, band: 4.0 },
  { min: 7, max: 9, band: 3.5 },
  { min: 4, max: 6, band: 3.0 },
  { min: 3, max: 3, band: 2.5 },
  { min: 2, max: 2, band: 2.0 },
  { min: 1, max: 1, band: 1.0 },
  { min: 0, max: 0, band: 0.0 },
];

const ACADEMIC_READING_BAND_TABLE = [
  { min: 39, max: 40, band: 9.0 },
  { min: 37, max: 38, band: 8.5 },
  { min: 35, max: 36, band: 8.0 },
  { min: 33, max: 34, band: 7.5 },
  { min: 30, max: 32, band: 7.0 },
  { min: 27, max: 29, band: 6.5 },
  { min: 23, max: 26, band: 6.0 },
  { min: 19, max: 22, band: 5.5 },
  { min: 15, max: 18, band: 5.0 },
  { min: 13, max: 14, band: 4.5 },
  { min: 10, max: 12, band: 4.0 },
  { min: 8, max: 9, band: 3.5 },
  { min: 7, max: 7, band: 3.5 },
  { min: 6, max: 6, band: 3.0 },
  { min: 5, max: 5, band: 3.0 },
  { min: 4, max: 4, band: 3.0 },
  { min: 3, max: 3, band: 2.5 },
  { min: 2, max: 2, band: 2.0 },
  { min: 1, max: 1, band: 1.0 },
  { min: 0, max: 0, band: 0.0 },
];

const getBandFromCorrect = (correctAnswers, table) => {
  const n = Math.round(Number(correctAnswers) || 0);
  if (n >= 1 && n <= 9) {
    if (n === 1) return 1.0;
    if (n === 2) return 2.0;
    if (n === 3) return 2.5;
    if (n >= 4 && n <= 6) return 3.0;
    return 3.5; // 7-9
  }
  const matched = table.find((row) => n >= row.min && n <= row.max);
  return matched ? matched.band : 0;
};

const roundHalf = (value) => Math.round((Number(value) || 0) * 2) / 2;

const pickWritingBand = (row) => {
  const candidates = [row?.admin_override_band, row?.final_band, row?.ai_overall_band];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
};

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

    const submissionIds = submissions.map((s) => s.id).filter(Boolean);
    const correctBySubmissionAndModule = {};
    const writingBySubmission = {};

    if (submissionIds.length > 0) {
      const { rows: answerRows } = await pool.query(
        `SELECT a.submission_id,
                COALESCE(a.admin_override_correct, a.is_correct) AS effective_correct,
                s.module_type
         FROM answers a
         LEFT JOIN questions q ON q.id = a.question_id
         LEFT JOIN exam_sections s ON s.id = q.section_id
         WHERE a.submission_id = ANY($1::uuid[])`,
        [submissionIds]
      );

      (answerRows || []).forEach((row) => {
        const submissionId = row.submission_id;
        const moduleType = row.module_type;
        if (!submissionId || (moduleType !== 'listening' && moduleType !== 'reading' && moduleType !== 'writing')) {
          return;
        }

        if (!correctBySubmissionAndModule[submissionId]) {
          correctBySubmissionAndModule[submissionId] = { listening: 0, reading: 0, writing: 0 };
        }

        if (row.effective_correct === true) {
          correctBySubmissionAndModule[submissionId][moduleType] += 1;
        }
      });

      const { rows: writingRows } = await pool.query(
        `SELECT submission_id, admin_override_band, final_band, ai_overall_band
         FROM writing_responses
         WHERE submission_id = ANY($1::uuid[])`,
        [submissionIds]
      );

      (writingRows || []).forEach((row) => {
        const submissionId = row.submission_id;
        if (!submissionId) return;
        if (!writingBySubmission[submissionId]) {
          writingBySubmission[submissionId] = [];
        }
        const band = pickWritingBand(row);
        if (band != null) {
          writingBySubmission[submissionId].push(band);
        }
      });
    }
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const thisWeekCount = submissions.filter(s => new Date(s.submitted_at) > oneWeekAgo).length;
    const activeExams = new Set(submissions.map(s => s.exam_id)).size;

    const formattedSubmissions = submissions.map(sub => {
      const moduleCorrect = correctBySubmissionAndModule[sub.id] || { listening: 0, reading: 0, writing: 0 };
      const listeningBand = getBandFromCorrect(moduleCorrect.listening, LISTENING_BAND_TABLE);
      const readingBand = getBandFromCorrect(moduleCorrect.reading, ACADEMIC_READING_BAND_TABLE);
      const writingBands = writingBySubmission[sub.id] || [];
      const writingBand = writingBands.length > 0
        ? writingBands.reduce((sum, value) => sum + value, 0) / writingBands.length
        : null;
      const writingChecked = writingBands.length > 0;

      const moduleBandsForOverall = writingChecked
        ? [listeningBand, readingBand, writingBand].filter((v) => Number.isFinite(v))
        : [];
      const computedOverallBand = moduleBandsForOverall.length === 3
        ? roundHalf(moduleBandsForOverall.reduce((sum, value) => sum + value, 0) / moduleBandsForOverall.length)
        : null;

      return {
        id: sub.id,
        user_id: sub.user_id,
        user_name: `${sub.first_name || ''} ${sub.last_name || ''}`.trim() || 'Unknown',
        user_email: sub.user_email,
        exam_id: sub.exam_id,
        exam_title: sub.exam_title,
        submitted_at: sub.submitted_at,
        band_score: computedOverallBand,
        scores_by_module: {
          ...(sub.scores_by_module || {}),
          listening: listeningBand,
          reading: readingBand,
          writing: writingChecked ? writingBand : null,
        },
        writing_checked: writingChecked,
        listening_correct: moduleCorrect.listening,
        reading_correct: moduleCorrect.reading,
        total_correct: sub.total_correct || 0,
        total_questions: sub.total_questions || 0,
        status: sub.status || 'submitted',
        time_spent: sub.time_spent
      };
    });

    const avgBandScore = totalSubmissions > 0
      ? (() => {
          const graded = formattedSubmissions.filter((s) => Number.isFinite(Number(s.band_score)));
          if (graded.length === 0) return '-';
          return (graded.reduce((sum, s) => sum + (parseFloat(s.band_score) || 0), 0) / graded.length).toFixed(1);
        })()
      : 0;

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
        section_id: ans.section_id || null,
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
      listening: { correct: 0, wrong: 0, skipped: 0, answers: [] },
      reading: { correct: 0, wrong: 0, skipped: 0, answers: [] },
      writing: { correct: 0, wrong: 0, skipped: 0, answers: [] }
    };

    answerDetails.forEach(ans => {
      if (answersByModule[ans.module_type]) {
        answersByModule[ans.module_type].answers.push(ans);
        if (ans.is_correct === true) answersByModule[ans.module_type].correct++;
        else if (ans.is_correct === false) answersByModule[ans.module_type].wrong++;
        else answersByModule[ans.module_type].skipped++;
      }
    });

    // Recover group-based answers (summary/table/form/note/map/diagram/sentence)
    // from raw submission data when DB answer rows are missing.
    const rawSubmissionAnswers = submission.answers;
    if (rawSubmissionAnswers && typeof rawSubmissionAnswers === 'object') {
      const allGroups = [
        ...(submission.modules_config?.listening_question_groups || []),
        ...(submission.modules_config?.reading_question_groups || [])
      ];

      const recoverableTypes = new Set([
        'summary_completion',
        'table_completion',
        'form_completion',
        'note_completion',
        'map_labeling',
        'diagram_labeling',
        'sentence_completion'
      ]);

      if (allGroups.length > 0) {
        const { rows: examSections } = await pool.query(
          `SELECT id, module_type, title, section_order FROM exam_sections WHERE exam_id = $1`,
          [submission.exam_id]
        );

        const sectionMap = {};
        examSections.forEach((s) => { sectionMap[s.id] = s; });

        for (const group of allGroups) {
          if (!group || !recoverableTypes.has(group.question_type)) continue;
          const start = Number(group.question_range_start || 0);
          const end = Number(group.question_range_end || 0);
          if (!start || !end || end < start) continue;

          const section = sectionMap[group.section_id] || {};
          const moduleType = section.module_type || 'reading';

          for (let qNum = start; qNum <= end; qNum++) {
            const blankIndex = qNum - start;
            const keyCandidates = [
              `summary_placeholder_${group.id}_${blankIndex}`,
              `table_${group.id}_blank_${blankIndex}`
            ];

            const answerKey = keyCandidates.find((k) => Object.prototype.hasOwnProperty.call(rawSubmissionAnswers, k)) || null;
            const userAnswer = answerKey ? rawSubmissionAnswers[answerKey] : null;
            const correctAnswer = group.question_type === 'summary_completion'
              ? (group.summary_data?.answers?.[blankIndex] || '')
              : '';

            const alreadyExists = answerDetails.some((a) =>
              Number(a.question_number) === Number(qNum) &&
              (a.section_id ? a.section_id === group.section_id : a.section_order === (section.section_order || 0))
            );
            if (alreadyExists) continue;

            let isCorrect = null;
            if (userAnswer != null && userAnswer !== '' && correctAnswer) {
              const userStr = String(userAnswer).trim().toLowerCase();
              const correctOptions = String(correctAnswer).split('/').map((s) => s.trim().toLowerCase()).filter(Boolean);
              isCorrect = correctOptions.includes(userStr);
            }

            const entry = {
              question_id: answerKey || `recovered_${group.id}_${blankIndex}`,
              section_id: group.section_id || null,
              question_number: qNum,
              question_type: group.question_type,
              question_text: `${group.question_type.replace(/_/g, ' ')} item ${qNum}`,
              user_answer: userAnswer,
              correct_answer: correctAnswer,
              is_correct: isCorrect,
              score: isCorrect === true ? 1 : (isCorrect === false ? 0 : null),
              module_type: moduleType,
              section_title: section.title || 'Unknown',
              section_order: section.section_order || 0,
              options: {}
            };

            answerDetails.push(entry);
            if (answersByModule[moduleType]) {
              answersByModule[moduleType].answers.push(entry);
              if (isCorrect === true) answersByModule[moduleType].correct++;
              else if (isCorrect === false) answersByModule[moduleType].wrong++;
              else answersByModule[moduleType].skipped++;
            }
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

    const writingBands = finalWritingResponses
      .map((wr) => pickWritingBand(wr))
      .filter((value) => value != null);
    const writingChecked = writingBands.length > 0;
    const writingBand = writingChecked
      ? writingBands.reduce((sum, value) => sum + value, 0) / writingBands.length
      : null;

    const listeningBand = getBandFromCorrect(answersByModule.listening.correct, LISTENING_BAND_TABLE);
    const readingBand = getBandFromCorrect(answersByModule.reading.correct, ACADEMIC_READING_BAND_TABLE);
    const overallBand = writingChecked
      ? roundHalf((listeningBand + readingBand + writingBand) / 3)
      : null;

    res.json({
      ...submission,
      band_score: overallBand,
      overall_band_score: overallBand,
      scores_by_module: {
        ...(submission.scores_by_module || {}),
        listening: listeningBand,
        reading: readingBand,
        writing: writingChecked ? writingBand : null,
      },
      writing_checked: writingChecked,
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
