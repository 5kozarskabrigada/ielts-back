import { supabase } from "../supabaseClient.js";

// Gemini AI Grading for Writing Section
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

// Grade writing response using Gemini AI
export const gradeWritingWithAI = async (req, res) => {
  const { submissionId, sectionId, taskNumber, responseText, taskType, taskPrompt, modelAnswer } = req.body;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
  }

  if (!responseText || responseText.trim().length === 0) {
    return res.status(400).json({ error: "No response text provided" });
  }

  const wordCount = responseText.trim().split(/\s+/).length;
  const isTask1 = taskNumber === 1;
  const minWords = isTask1 ? 150 : 250;

  try {
    // Construct the AI prompt
    const systemPrompt = `You are an expert IELTS examiner. Grade the following IELTS Writing ${isTask1 ? 'Task 1' : 'Task 2'} response.

TASK TYPE: ${taskType || (isTask1 ? 'Academic Report' : 'Essay')}

TASK PROMPT:
${taskPrompt || 'Not provided'}

${modelAnswer ? `MODEL ANSWER (for reference, do not share with student):
${modelAnswer}` : ''}

STUDENT'S RESPONSE:
${responseText}

WORD COUNT: ${wordCount} (minimum required: ${minWords})

Grade this response on each of the 4 IELTS criteria using the IELTS 9-band scale:
1. Task Response (TR) - How well did the student address all parts of the task?
2. Coherence and Cohesion (CC) - How well organized and connected is the writing?
3. Lexical Resource (LR) - Range and accuracy of vocabulary
4. Grammatical Range and Accuracy (GRA) - Range and accuracy of grammar

Respond ONLY with a JSON object in this exact format (no markdown, no explanation outside JSON):
{
  "task_response": <score 0-9>,
  "coherence_cohesion": <score 0-9>,
  "lexical_resource": <score 0-9>,
  "grammatical_range": <score 0-9>,
  "overall_band": <average of above 4 scores, rounded to nearest 0.5>,
  "feedback": "<2-3 paragraphs of constructive feedback including strengths and areas for improvement>",
  "word_count_penalty": <true if under minimum, false otherwise>,
  "key_improvements": ["<improvement 1>", "<improvement 2>", "<improvement 3>"]
}`;

    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: systemPrompt }]
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Gemini API Error:", errorData);
      return res.status(500).json({ error: "AI grading service unavailable: " + (errorData.error?.message || JSON.stringify(errorData)) });
    }

    const aiResult = await response.json();
    const textContent = aiResult.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textContent) {
      return res.status(500).json({ error: "Invalid response from AI service" });
    }

    // Parse the JSON response
    let grading;
    try {
      // Clean up the response (remove markdown code blocks if present)
      const cleanJson = textContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      grading = JSON.parse(cleanJson);
    } catch (parseError) {
      console.error("Failed to parse AI response:", textContent);
      return res.status(500).json({ error: "Failed to parse AI grading response", raw: textContent });
    }

    // Save to database if submission context provided
    if (submissionId && sectionId) {
      const { data: existingResponse } = await supabase
        .from("writing_responses")
        .select("id")
        .eq("submission_id", submissionId)
        .eq("section_id", sectionId)
        .eq("task_number", taskNumber)
        .single();

      const writeData = {
        submission_id: submissionId,
        section_id: sectionId,
        task_number: taskNumber,
        response_text: responseText,
        word_count: wordCount,
        ai_overall_band: grading.overall_band,
        ai_task_response_score: grading.task_response,
        ai_coherence_score: grading.coherence_cohesion,
        ai_lexical_score: grading.lexical_resource,
        ai_grammar_score: grading.grammatical_range,
        ai_feedback: JSON.stringify({
          feedback: grading.feedback,
          key_improvements: grading.key_improvements,
          word_count_penalty: grading.word_count_penalty
        }),
        ai_graded_at: new Date().toISOString(),
        final_band: grading.overall_band
      };

      if (existingResponse) {
        await supabase
          .from("writing_responses")
          .update(writeData)
          .eq("id", existingResponse.id);
      } else {
        await supabase
          .from("writing_responses")
          .insert([writeData]);
      }

      // Update submission grading status
      await supabase
        .from("exam_submissions")
        .update({ writing_grading_status: "ai_graded" })
        .eq("id", submissionId);
    }

    res.json({
      success: true,
      grading: {
        overall_band: grading.overall_band,
        task_response: grading.task_response,
        coherence_cohesion: grading.coherence_cohesion,
        lexical_resource: grading.lexical_resource,
        grammatical_range: grading.grammatical_range,
        feedback: grading.feedback,
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

// Admin override for writing response
export const overrideWritingGrade = async (req, res) => {
  const { responseId } = req.params;
  const { override_band, feedback } = req.body;
  const adminId = req.user.id;

  try {
    const { data, error } = await supabase
      .from("writing_responses")
      .update({
        admin_override_band: override_band,
        admin_feedback: feedback,
        admin_graded_by: adminId,
        admin_graded_at: new Date().toISOString(),
        final_band: override_band // Trigger will also set this, but explicit is clear
      })
      .eq("id", responseId)
      .select()
      .single();

    if (error) throw error;

    // Update submission status
    if (data?.submission_id) {
      await supabase
        .from("exam_submissions")
        .update({ writing_grading_status: "admin_reviewed" })
        .eq("id", data.submission_id);
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin override for any answer (listening/reading questions)
export const overrideAnswerGrade = async (req, res) => {
  const { answerId } = req.params;
  const { is_correct, score, notes } = req.body;

  try {
    const updateData = {
      admin_notes: notes || null,
      graded_by: 'admin',
      updated_at: new Date().toISOString()
    };

    // Only set overrides if provided
    if (is_correct !== undefined) {
      updateData.admin_override_correct = is_correct;
    }
    if (score !== undefined) {
      updateData.admin_override_score = score;
    }

    const { data, error } = await supabase
      .from("answers")
      .update(updateData)
      .eq("id", answerId)
      .select()
      .single();

    if (error) throw error;

    // Recalculate submission total if needed
    if (data?.submission_id) {
      await recalculateSubmissionScore(data.submission_id);
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Bulk override for multiple answers
export const bulkOverrideAnswers = async (req, res) => {
  const { overrides } = req.body; // Array of { answerId, is_correct, score, notes }

  if (!Array.isArray(overrides) || overrides.length === 0) {
    return res.status(400).json({ error: "No overrides provided" });
  }

  try {
    const results = [];
    let submissionId = null;

    for (const override of overrides) {
      const updateData = {
        admin_notes: override.notes || null,
        graded_by: 'admin',
        updated_at: new Date().toISOString()
      };

      if (override.is_correct !== undefined) {
        updateData.admin_override_correct = override.is_correct;
      }
      if (override.score !== undefined) {
        updateData.admin_override_score = override.score;
      }

      const { data, error } = await supabase
        .from("answers")
        .update(updateData)
        .eq("id", override.answerId)
        .select()
        .single();

      if (error) {
        results.push({ answerId: override.answerId, success: false, error: error.message });
      } else {
        results.push({ answerId: override.answerId, success: true });
        if (data?.submission_id) submissionId = data.submission_id;
      }
    }

    // Recalculate submission score once at the end
    if (submissionId) {
      await recalculateSubmissionScore(submissionId);
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Helper function to recalculate submission score after admin overrides
async function recalculateSubmissionScore(submissionId) {
  try {
    const { data: answers } = await supabase
      .from("answers")
      .select("is_correct, score, admin_override_correct, admin_override_score")
      .eq("submission_id", submissionId);

    if (!answers) return;

    let totalScore = 0;
    let totalCorrect = 0;
    const totalQuestions = answers.length;

    answers.forEach(a => {
      // Use admin override if available, otherwise original
      const isCorrect = a.admin_override_correct !== null ? a.admin_override_correct : a.is_correct;
      const score = a.admin_override_score !== null ? a.admin_override_score : a.score;

      if (isCorrect) totalCorrect++;
      totalScore += score || 0;
    });

    const overallBand = totalQuestions > 0 ? (totalScore / totalQuestions) * 9 : 0;

    await supabase
      .from("exam_submissions")
      .update({
        total_correct: totalCorrect,
        overall_band_score: overallBand
      })
      .eq("id", submissionId);

  } catch (err) {
    console.error("Error recalculating submission score:", err);
  }
}

// Get all submissions with detailed answers for admin review
export const getSubmissionsForGrading = async (req, res) => {
  const { examId, status, page = 1, limit = 20 } = req.query;

  try {
    let query = supabase
      .from("exam_submissions")
      .select(`
        *,
        users:user_id (id, name, email),
        exams:exam_id (id, title, type)
      `)
      .order("submitted_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (examId) {
      query = query.eq("exam_id", examId);
    }
    if (status) {
      if (status === 'needs_grading') {
        query = query.in("writing_grading_status", ["pending", "ai_graded"]);
      } else {
        query = query.eq("status", status);
      }
    }

    const { data, error, count } = await query;

    if (error) throw error;

    res.json({
      submissions: data,
      total: count,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get detailed submission with all answers for grading view
export const getSubmissionDetail = async (req, res) => {
  const { submissionId } = req.params;

  try {
    // Get submission info
    const { data: submission, error: subError } = await supabase
      .from("exam_submissions")
      .select(`
        *,
        users:user_id (id, name, email),
        exams:exam_id (id, title, type)
      `)
      .eq("id", submissionId)
      .single();

    if (subError) throw subError;

    // Get all answers with question details
    const { data: answers, error: ansError } = await supabase
      .from("answers")
      .select(`
        *,
        questions:question_id (
          id, question_text, question_type, correct_answer, points, question_number, section_id,
          exam_sections:section_id (id, title, module_type)
        )
      `)
      .eq("submission_id", submissionId)
      .order("created_at");

    if (ansError) throw ansError;

    // Get writing responses if any
    const { data: writingResponses, error: writingError } = await supabase
      .from("writing_responses")
      .select("*")
      .eq("submission_id", submissionId);

    if (writingError && writingError.code !== '42P01') { // Ignore if table doesn't exist yet
      console.warn("Writing responses table not found:", writingError);
    }

    res.json({
      submission,
      answers,
      writingResponses: writingResponses || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Export CSV results
export const exportResultsCSV = async (req, res) => {
  const { examId } = req.query;

  try {
    let query = supabase
      .from("exam_submissions")
      .select(`
        *,
        users:user_id (name, email)
      `)
      .in("status", ["submitted", "auto_submitted"]);

    if (examId) {
      query = query.eq("exam_id", examId);
    }

    const { data, error } = await query.order("submitted_at", { ascending: false });

    if (error) throw error;

    // Build CSV
    const headers = ["Student Name", "Email", "Exam", "Overall Band", "Total Correct", "Total Questions", "Status", "Submitted At"];
    const rows = data.map(s => [
      s.users?.name || "Unknown",
      s.users?.email || "",
      s.exam_id,
      s.overall_band_score?.toFixed(1) || "N/A",
      s.total_correct || 0,
      s.total_questions || 0,
      s.status,
      s.submitted_at || ""
    ]);

    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=exam_results.csv");
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
