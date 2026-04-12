import { pool } from "../db.js";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

function safeParseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export const gradeWritingWithAI = async (req, res) => {
  const { submissionId, sectionId, taskNumber, responseText, taskType, taskPrompt, modelAnswer } = req.body;

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: "GROQ_API_KEY not configured on server" });
  }
  if (!responseText || responseText.trim().length === 0) {
    return res.status(400).json({ error: "No response text provided" });
  }

  const normalizedTaskNumber = Number(taskNumber) || 1;
  const wordCount = responseText.trim().split(/\s+/).length;
  const isTask1 = normalizedTaskNumber === 1;
  const minWords = isTask1 ? 150 : 250;

  try {
    let resolvedSectionId = sectionId || null;
    let resolvedTaskType = taskType;
    let resolvedTaskPrompt = taskPrompt;
    let resolvedModelAnswer = modelAnswer;

    const hydrateSectionContext = (section) => {
      if (!section) return;
      const taskConfig = safeParseJson(section.task_config);
      const promptParts = [taskConfig.instructions, taskConfig.prompt, section.content]
        .map(p => (typeof p === "string" ? p.trim() : "")).filter(Boolean);
      if (!resolvedTaskType) resolvedTaskType = taskConfig.type || section.title || null;
      if (!resolvedTaskPrompt && promptParts.length > 0) resolvedTaskPrompt = promptParts.join("\n\n");
      if (!resolvedModelAnswer) resolvedModelAnswer = taskConfig.modelAnswer || null;
      if (!resolvedSectionId) resolvedSectionId = section.id;
    };

    if (submissionId && !resolvedSectionId) {
      const { rows: subRows } = await pool.query(`SELECT exam_id FROM exam_submissions WHERE id = $1`, [submissionId]);
      if (subRows[0]?.exam_id) {
        const { rows: sections } = await pool.query(
          `SELECT id, section_order, title, content, task_config
           FROM exam_sections WHERE exam_id = $1 AND module_type = 'writing' ORDER BY section_order ASC`,
          [subRows[0].exam_id]
        );
        if (sections.length > 0) hydrateSectionContext(sections[normalizedTaskNumber - 1] || sections[0]);
      }
    }

    if (resolvedSectionId && (!resolvedTaskType || !resolvedTaskPrompt || !resolvedModelAnswer)) {
      const { rows } = await pool.query(
        `SELECT id, title, content, task_config FROM exam_sections WHERE id = $1`, [resolvedSectionId]
      );
      hydrateSectionContext(rows[0]);
    }

    const systemPrompt = `You are an expert IELTS examiner with years of experience grading writing tasks. Grade the following IELTS Writing ${isTask1 ? 'Task 1' : 'Task 2'} response strictly according to the official IELTS 9-band descriptors.

TASK TYPE: ${resolvedTaskType || (isTask1 ? 'Academic Report/Letter' : 'Discursive Essay')}

TASK PROMPT:
${resolvedTaskPrompt || 'Not provided'}

${resolvedModelAnswer ? `MODEL ANSWER (for reference only):
${resolvedModelAnswer}` : ''}

STUDENT'S RESPONSE:
${responseText}

WORD COUNT: ${wordCount} (minimum required: ${minWords})

${isTask1 ? `
TASK 1 GRADING CRITERIA:
- Task Achievement (TA): Does the response cover all requirements of the task? Is there a clear overview? Are key features selected and adequately described?
- Coherence and Cohesion (CC): Is information logically organized? Are paragraphing and cohesive devices used effectively?
- Lexical Resource (LR): Is there a sufficient range of vocabulary? Are less common words used with awareness of style?
- Grammatical Range and Accuracy (GRA): Is there a range of sentence structures? Are complex structures attempted?
` : `
TASK 2 GRADING CRITERIA:
- Task Response (TR): Does the response address all parts of the task? Is a clear position presented throughout?
- Coherence and Cohesion (CC): Is there a logical structure with clear progression?
- Lexical Resource (LR): Is there a wide range of vocabulary?
- Grammatical Range and Accuracy (GRA): Is there a variety of complex structures?
`}

IMPORTANT: If word count < ${minWords}, penalize Task Response/Achievement directly.

Respond ONLY with valid JSON:
{
  "task_response": <0-9>, "task_response_feedback": "<feedback>",
  "coherence_cohesion": <0-9>, "coherence_feedback": "<feedback>",
  "lexical_resource": <0-9>, "lexical_feedback": "<feedback>",
  "grammatical_range": <0-9>, "grammar_feedback": "<feedback>",
  "overall_band": <average rounded to 0.5>,
  "overall_feedback": "<summary>",
  "word_count_penalty": <true/false>,
  "key_improvements": ["<1>", "<2>", "<3>"]
}`;

    const groqPayload = {
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are an expert IELTS examiner. Always respond with valid JSON only, no markdown." },
        { role: "user", content: systemPrompt }
      ],
      temperature: 0.3, max_tokens: 2048,
    };

    let response;
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
      try {
        response = await fetch(GROQ_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify(groqPayload),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) break;
        // Retry on rate-limit or server errors
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '3', 10);
          console.warn(`Groq API returned ${response.status}, retrying in ${retryAfter}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }
        break; // Non-retryable error
      } catch (fetchErr) {
        clearTimeout(timeout);
        if (attempt < MAX_RETRIES) {
          console.warn(`Groq API fetch error: ${fetchErr.message}, retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        console.error("Groq API fetch failed after retries:", fetchErr);
        return res.status(504).json({ error: fetchErr.name === 'AbortError' ? "AI grading timed out. Please try again." : "AI service connection failed. Please try again." });
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("Groq API Error:", errorData);
      return res.status(response.status === 429 ? 429 : 500).json({ 
        error: response.status === 429 
          ? "AI grading service is busy. Please wait a moment and try again." 
          : "AI grading service unavailable: " + (errorData.error?.message || JSON.stringify(errorData))
      });
    }

    const aiResult = await response.json();
    const textContent = aiResult.choices?.[0]?.message?.content;
    if (!textContent) return res.status(500).json({ error: "Invalid response from AI service" });

    let grading;
    try {
      const cleanJson = textContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      grading = JSON.parse(cleanJson);
    } catch {
      console.error("Failed to parse AI response:", textContent);
      return res.status(500).json({ error: "Failed to parse AI grading response", raw: textContent });
    }

    if (submissionId) {
      if (!resolvedSectionId) {
        const { rows: subRows } = await pool.query(`SELECT exam_id FROM exam_submissions WHERE id = $1`, [submissionId]);
        if (subRows[0]?.exam_id) {
          const { rows: sections } = await pool.query(
            `SELECT id, section_order FROM exam_sections WHERE exam_id = $1 AND module_type = 'writing' ORDER BY section_order ASC`,
            [subRows[0].exam_id]
          );
          if (sections.length > 0) resolvedSectionId = sections[normalizedTaskNumber - 1]?.id || sections[0]?.id;
        }
      }

      // Check for existing writing_response
      const { rows: existRows } = await pool.query(
        `SELECT id FROM writing_responses WHERE submission_id = $1 AND task_number = $2 LIMIT 1`,
        [submissionId, normalizedTaskNumber]
      );

      const aiFeedback = JSON.stringify({
        feedback: grading.overall_feedback || grading.feedback,
        task_response_feedback: grading.task_response_feedback,
        coherence_feedback: grading.coherence_feedback,
        lexical_feedback: grading.lexical_feedback,
        grammar_feedback: grading.grammar_feedback,
        key_improvements: grading.key_improvements,
        word_count_penalty: grading.word_count_penalty
      });

      if (existRows[0]) {
        await pool.query(
          `UPDATE writing_responses SET
            section_id = $1, response_text = $2, word_count = $3,
            ai_overall_band = $4, ai_task_response_score = $5, ai_coherence_score = $6,
            ai_lexical_score = $7, ai_grammar_score = $8, ai_feedback = $9,
            ai_graded_at = NOW(), final_band = $4
           WHERE id = $10`,
          [resolvedSectionId, responseText, wordCount,
           grading.overall_band, grading.task_response, grading.coherence_cohesion,
           grading.lexical_resource, grading.grammatical_range, aiFeedback,
           existRows[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO writing_responses
            (submission_id, section_id, task_number, response_text, word_count,
             ai_overall_band, ai_task_response_score, ai_coherence_score,
             ai_lexical_score, ai_grammar_score, ai_feedback, ai_graded_at, final_band)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $6)`,
          [submissionId, resolvedSectionId, normalizedTaskNumber, responseText, wordCount,
           grading.overall_band, grading.task_response, grading.coherence_cohesion,
           grading.lexical_resource, grading.grammatical_range, aiFeedback]
        );
      }

      await pool.query(
        `UPDATE exam_submissions SET writing_grading_status = 'ai_graded' WHERE id = $1`,
        [submissionId]
      );
    }

    res.json({
      success: true,
      grading: {
        overall_band: grading.overall_band,
        task_response: grading.task_response,
        coherence_cohesion: grading.coherence_cohesion,
        lexical_resource: grading.lexical_resource,
        grammatical_range: grading.grammatical_range,
        feedback: grading.overall_feedback || grading.feedback,
        task_response_feedback: grading.task_response_feedback,
        coherence_feedback: grading.coherence_feedback,
        lexical_feedback: grading.lexical_feedback,
        grammar_feedback: grading.grammar_feedback,
        key_improvements: grading.key_improvements,
        word_count: wordCount,
        word_count_penalty: grading.word_count_penalty
      }
    });
  } catch (err) {
    console.error("AI Grading Error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const overrideWritingGrade = async (req, res) => {
  const { responseId } = req.params;
  const { override_band, feedback } = req.body;
  const adminId = req.user.id;

  try {
    const { rows } = await pool.query(
      `UPDATE writing_responses SET
        admin_override_band = $1, admin_feedback = $2, admin_graded_by = $3,
        admin_graded_at = NOW(), final_band = $1
       WHERE id = $4 RETURNING *`,
      [override_band, feedback, adminId, responseId]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Writing response not found" });

    if (rows[0].submission_id) {
      await pool.query(
        `UPDATE exam_submissions SET writing_grading_status = 'admin_reviewed' WHERE id = $1`,
        [rows[0].submission_id]
      );
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const overrideAnswerGrade = async (req, res) => {
  const { answerId } = req.params;
  const { is_correct, score, notes } = req.body;

  try {
    const sets = [`admin_notes = $1`, `graded_by = 'admin'`, `updated_at = NOW()`];
    const params = [notes || null];
    let idx = 2;

    if (is_correct !== undefined) { sets.push(`admin_override_correct = $${idx++}`); params.push(is_correct); }
    if (score !== undefined) { sets.push(`admin_override_score = $${idx++}`); params.push(score); }

    params.push(answerId);
    const { rows } = await pool.query(
      `UPDATE answers SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      params
    );

    if (rows.length === 0) return res.status(404).json({ error: "Answer not found" });

    if (rows[0].submission_id) {
      await recalculateSubmissionScore(rows[0].submission_id);
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const bulkOverrideAnswers = async (req, res) => {
  const { overrides } = req.body;
  if (!Array.isArray(overrides) || overrides.length === 0) {
    return res.status(400).json({ error: "No overrides provided" });
  }

  try {
    const results = [];
    let submissionId = null;

    for (const override of overrides) {
      try {
        const sets = [`admin_notes = $1`, `graded_by = 'admin'`, `updated_at = NOW()`];
        const params = [override.notes || null];
        let idx = 2;

        if (override.is_correct !== undefined) { sets.push(`admin_override_correct = $${idx++}`); params.push(override.is_correct); }
        if (override.score !== undefined) { sets.push(`admin_override_score = $${idx++}`); params.push(override.score); }

        params.push(override.answerId);
        const { rows } = await pool.query(
          `UPDATE answers SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
          params
        );

        if (rows[0]) {
          results.push({ answerId: override.answerId, success: true });
          if (rows[0].submission_id) submissionId = rows[0].submission_id;
        } else {
          results.push({ answerId: override.answerId, success: false, error: "Not found" });
        }
      } catch (err) {
        results.push({ answerId: override.answerId, success: false, error: err.message });
      }
    }

    if (submissionId) await recalculateSubmissionScore(submissionId);

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

async function recalculateSubmissionScore(submissionId) {
  try {
    const { rows: answers } = await pool.query(
      `SELECT is_correct, score, admin_override_correct, admin_override_score FROM answers WHERE submission_id = $1`,
      [submissionId]
    );
    if (!answers || answers.length === 0) return;

    let totalScore = 0, totalCorrect = 0;
    const totalQuestions = answers.length;

    answers.forEach(a => {
      const isCorrect = a.admin_override_correct !== null ? a.admin_override_correct : a.is_correct;
      const score = a.admin_override_score !== null ? a.admin_override_score : a.score;
      if (isCorrect) totalCorrect++;
      totalScore += score || 0;
    });

    const overallBand = totalQuestions > 0 ? (totalScore / totalQuestions) * 9 : 0;

    await pool.query(
      `UPDATE exam_submissions SET total_correct = $1, overall_band_score = $2 WHERE id = $3`,
      [totalCorrect, overallBand, submissionId]
    );
  } catch (err) {
    console.error("Error recalculating submission score:", err);
  }
}

export const getSubmissionsForGrading = async (req, res) => {
  const { examId, status, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = [];
    let params = [];
    let idx = 1;

    if (examId) { where.push(`es.exam_id = $${idx++}`); params.push(examId); }
    if (status) {
      if (status === 'needs_grading') {
        where.push(`es.writing_grading_status IN ('pending', 'ai_graded')`);
      } else {
        where.push(`es.status = $${idx++}`); params.push(status);
      }
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const { rows } = await pool.query(
      `SELECT es.*,
              json_build_object('id', u.id, 'name', CONCAT(u.first_name, ' ', u.last_name), 'email', u.email) AS users,
              json_build_object('id', e.id, 'title', e.title, 'type', e.type) AS exams
       FROM exam_submissions es
       LEFT JOIN users u ON u.id = es.user_id
       LEFT JOIN exams e ON e.id = es.exam_id
       ${whereClause}
       ORDER BY es.submitted_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), offset]
    );

    res.json({ submissions: rows, total: rows.length, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getSubmissionDetail = async (req, res) => {
  const { submissionId } = req.params;

  try {
    const { rows: subRows } = await pool.query(
      `SELECT es.*,
              json_build_object('id', u.id, 'name', CONCAT(u.first_name, ' ', u.last_name), 'email', u.email) AS users,
              json_build_object('id', e.id, 'title', e.title, 'type', e.type) AS exams
       FROM exam_submissions es
       LEFT JOIN users u ON u.id = es.user_id
       LEFT JOIN exams e ON e.id = es.exam_id
       WHERE es.id = $1`,
      [submissionId]
    );

    if (subRows.length === 0) return res.status(404).json({ error: "Submission not found" });
    const submission = subRows[0];

    const { rows: answers } = await pool.query(
      `SELECT a.*,
              json_build_object(
                'id', q.id, 'question_text', q.question_text, 'question_type', q.question_type,
                'correct_answer', q.correct_answer, 'points', q.points, 'question_number', q.question_number,
                'section_id', q.section_id,
                'exam_sections', json_build_object('id', s.id, 'title', s.title, 'module_type', s.module_type)
              ) AS questions
       FROM answers a
       LEFT JOIN questions q ON q.id = a.question_id
       LEFT JOIN exam_sections s ON s.id = q.section_id
       WHERE a.submission_id = $1
       ORDER BY a.created_at`,
      [submissionId]
    );

    const { rows: writingResponses } = await pool.query(
      `SELECT * FROM writing_responses WHERE submission_id = $1`, [submissionId]
    );

    res.json({ submission, answers, writingResponses: writingResponses || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const exportResultsCSV = async (req, res) => {
  const { examId } = req.query;

  try {
    let query = `SELECT es.*, u.first_name, u.last_name, u.email AS user_email
                 FROM exam_submissions es
                 LEFT JOIN users u ON u.id = es.user_id
                 WHERE es.status IN ('submitted', 'auto_submitted')`;
    const params = [];

    if (examId) {
      query += ` AND es.exam_id = $1`;
      params.push(examId);
    }
    query += ` ORDER BY es.submitted_at DESC`;

    const { rows } = await pool.query(query, params);

    const headers = ["Student Name", "Email", "Exam", "Overall Band", "Total Correct", "Total Questions", "Status", "Submitted At"];
    const csvRows = rows.map(s => [
      `${s.first_name || ''} ${s.last_name || ''}`.trim() || "Unknown",
      s.user_email || "",
      s.exam_id,
      s.overall_band_score ? parseFloat(s.overall_band_score).toFixed(1) : "N/A",
      s.total_correct || 0,
      s.total_questions || 0,
      s.status,
      s.submitted_at || ""
    ]);

    const csv = [headers.join(","), ...csvRows.map(r => r.join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=exam_results.csv");
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
