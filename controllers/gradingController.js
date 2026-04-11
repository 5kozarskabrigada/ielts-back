import { supabase } from "../supabaseClient.js";

// AI Grading for Writing Section - Groq (free)
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

function safeParseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Grade writing response using Groq AI
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
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean);

      if (!resolvedTaskType) {
        resolvedTaskType = taskConfig.type || section.title || null;
      }
      if (!resolvedTaskPrompt && promptParts.length > 0) {
        resolvedTaskPrompt = promptParts.join("\n\n");
      }
      if (!resolvedModelAnswer) {
        resolvedModelAnswer = taskConfig.modelAnswer || null;
      }
      if (!resolvedSectionId) {
        resolvedSectionId = section.id;
      }
    };

    if (submissionId && !resolvedSectionId) {
      const { data: sub } = await supabase
        .from("exam_submissions")
        .select("exam_id")
        .eq("id", submissionId)
        .single();

      if (sub?.exam_id) {
        const { data: sections } = await supabase
          .from("exam_sections")
          .select("id, section_order, title, content, task_config")
          .eq("exam_id", sub.exam_id)
          .eq("module_type", "writing")
          .order("section_order", { ascending: true });

        if (sections && sections.length > 0) {
          const matchedSection = sections[normalizedTaskNumber - 1] || sections[0];
          hydrateSectionContext(matchedSection);
        }
      }
    }

    if (resolvedSectionId && (!resolvedTaskType || !resolvedTaskPrompt || !resolvedModelAnswer)) {
      const { data: section } = await supabase
        .from("exam_sections")
        .select("id, title, content, task_config")
        .eq("id", resolvedSectionId)
        .maybeSingle();

      hydrateSectionContext(section);
    }

    // Construct the AI prompt with detailed IELTS criteria
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
- Task Achievement (TA): Does the response cover all requirements of the task? Is there a clear overview? Are key features selected and adequately described? Is data/information appropriately selected and reported?
- Coherence and Cohesion (CC): Is information logically organized? Are paragraphing and cohesive devices used effectively? Is there a clear progression throughout?
- Lexical Resource (LR): Is there a sufficient range of vocabulary? Are less common words used with awareness of style and collocation? Are there errors in word choice/spelling?
- Grammatical Range and Accuracy (GRA): Is there a range of sentence structures? Are complex structures attempted? How frequent/impactful are the grammatical errors?
` : `
TASK 2 GRADING CRITERIA:
- Task Response (TR): Does the response address all parts of the task? Is a clear position presented throughout? Are ideas extended, supported and well-developed? Are relevant examples given?
- Coherence and Cohesion (CC): Is there a logical structure with clear progression? Is each paragraph focused on a central topic? Are cohesive devices used accurately and appropriately?
- Lexical Resource (LR): Is there a wide range of vocabulary? Are less common lexical items used skillfully? Are there errors in word formation/spelling?
- Grammatical Range and Accuracy (GRA): Is there a variety of complex structures? Are grammar and punctuation generally well-controlled? Do errors impede communication?
`}

IMPORTANT NOTES:
- If the word count is below the minimum (${minWords}), penalize the Task Response/Achievement score directly (typically -1 band or more).
- Be fair but rigorous. A Band 9 is near-perfect; a Band 5 is modest; below Band 4 indicates serious problems.
- Give specific, actionable feedback referencing actual phrases/sentences from the essay.

Respond ONLY with a valid JSON object (no markdown code blocks, no extra text):
{
  "task_response": <number 0-9, can use 0.5 increments>,
  "task_response_feedback": "<Specific feedback for ${isTask1 ? 'Task Achievement' : 'Task Response'} with examples from the text>",
  "coherence_cohesion": <number 0-9, can use 0.5 increments>,
  "coherence_feedback": "<Specific feedback for Coherence & Cohesion with examples>",
  "lexical_resource": <number 0-9, can use 0.5 increments>,
  "lexical_feedback": "<Specific feedback for Lexical Resource with examples>",
  "grammatical_range": <number 0-9, can use 0.5 increments>,
  "grammar_feedback": "<Specific feedback for Grammar with examples of errors found>",
  "overall_band": <average of above 4, rounded to nearest 0.5>,
  "overall_feedback": "<1-2 paragraph summary of strengths and main weaknesses>",
  "word_count_penalty": <true if under minimum, false otherwise>,
  "key_improvements": ["<specific improvement 1>", "<specific improvement 2>", "<specific improvement 3>"]
}`;

    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: "You are an expert IELTS examiner. Always respond with valid JSON only, no markdown." },
          { role: "user", content: systemPrompt }
        ],
        temperature: 0.3,
        max_tokens: 2048,
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("Groq API Error:", errorData);
      return res.status(500).json({ error: "AI grading service unavailable: " + (errorData.error?.message || JSON.stringify(errorData)) });
    }

    const aiResult = await response.json();
    const textContent = aiResult.choices?.[0]?.message?.content;

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
    if (submissionId) {
      if (!resolvedSectionId) {
        const { data: sub } = await supabase
          .from("exam_submissions")
          .select("exam_id")
          .eq("id", submissionId)
          .single();
        if (sub?.exam_id) {
          const { data: sections } = await supabase
            .from("exam_sections")
            .select("id, section_order")
            .eq("exam_id", sub.exam_id)
            .eq("module_type", "writing")
            .order("section_order", { ascending: true });
          if (sections && sections.length > 0) {
            // Match by task number (task 1 = first writing section, task 2 = second, etc.)
            resolvedSectionId = sections[normalizedTaskNumber - 1]?.id || sections[0]?.id;
          }
        }
      }

      // Try to find existing response by submission + task_number (more reliable than section_id)
      let existingId = null;
      const { data: existByTask } = await supabase
        .from("writing_responses")
        .select("id")
        .eq("submission_id", submissionId)
        .eq("task_number", normalizedTaskNumber)
        .maybeSingle();
      if (existByTask) existingId = existByTask.id;

      const writeData = {
        submission_id: submissionId,
        section_id: resolvedSectionId || null,
        task_number: normalizedTaskNumber,
        response_text: responseText,
        word_count: wordCount,
        ai_overall_band: grading.overall_band,
        ai_task_response_score: grading.task_response,
        ai_coherence_score: grading.coherence_cohesion,
        ai_lexical_score: grading.lexical_resource,
        ai_grammar_score: grading.grammatical_range,
        ai_feedback: JSON.stringify({
          feedback: grading.overall_feedback || grading.feedback,
          task_response_feedback: grading.task_response_feedback,
          coherence_feedback: grading.coherence_feedback,
          lexical_feedback: grading.lexical_feedback,
          grammar_feedback: grading.grammar_feedback,
          key_improvements: grading.key_improvements,
          word_count_penalty: grading.word_count_penalty
        }),
        ai_graded_at: new Date().toISOString(),
        final_band: grading.overall_band
      };

      let saveResult;
      if (existingId) {
        saveResult = await supabase
          .from("writing_responses")
          .update(writeData)
          .eq("id", existingId)
          .select()
          .single();
      } else {
        saveResult = await supabase
          .from("writing_responses")
          .insert([writeData])
          .select()
          .single();
      }

      if (saveResult.error) {
        console.error("Failed to save writing response:", saveResult.error);
        // Still return the grading but flag that save failed
        return res.json({
          success: true,
          save_error: saveResult.error.message,
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
      }

      console.log("Writing response saved successfully, id:", saveResult.data?.id);

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
