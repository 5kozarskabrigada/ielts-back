// ... existing imports
import { supabase } from "../supabaseClient.js";

// ... existing functions (listExams, createExam, getExam, etc.)

export const saveExamStructure = async (req, res) => {
  const { id: examId } = req.params;
  const { exam, sections, questions } = req.body;

  try {
    // 1. Update Exam Metadata
    const { error: examError } = await supabase
      .from("exams")
      .update({
        title: exam.title,
        description: exam.description,
        status: exam.status,
        modules_config: exam.modules_config,
        code: exam.code,
        type: exam.type
      })
      .eq("id", examId);

    if (examError) throw examError;

    // 2. Upsert Sections
    // Note: This assumes sections have IDs (even temp ones need to be handled, usually backend ignores or replaces temp IDs)
    // For simplicity, we'll upsert based on ID if it's a valid UUID, or insert if it's a temp ID (client should send without ID or handle mapping)
    // A better approach for "save entire structure" is complex. 
    // Here we will iterate.
    
    for (const section of sections) {
      const payload = {
        exam_id: examId,
        module_type: section.module_type,
        section_order: section.section_order,
        title: section.title,
        content: section.content,
        audio_url: section.audio_url
      };

      let sectionId = section.id;
      
      // If ID is temporary (starts with 'l', 'r', 'w' or 'temp'), remove it to let DB generate new one, OR update if it's real UUID
      // This logic depends on whether we created them in DB yet. 
      // If we want to support full sync, we might need to delete old sections and re-insert, but that breaks foreign keys.
      // Strategy: Upsert. If ID is not UUID, insert.
      
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sectionId);
      
      if (isUUID) {
        await supabase.from("exam_sections").update(payload).eq("id", sectionId);
      } else {
        const { data: newSection } = await supabase.from("exam_sections").insert([payload]).select().single();
        sectionId = newSection.id; // Map temp ID to new real ID for questions
      }

      // 3. Upsert Questions for this section
      const sectionQuestions = questions.filter(q => q.section_id === section.id);
      
      for (const q of sectionQuestions) {
        const qPayload = {
          exam_id: examId,
          section_id: sectionId, // Use the real (possibly new) section ID
          question_text: q.text,
          question_type: q.type,
          correct_answer: q.answer,
          points: 1,
          question_number: 0 // Logic to set this based on index?
        };

        const isQUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q.id);

        if (isQUUID) {
          await supabase.from("questions").update(qPayload).eq("id", q.id);
        } else {
          await supabase.from("questions").insert([qPayload]);
        }
      }
    }

    res.json({ message: "Exam structure saved successfully" });
  } catch (err) {
    console.error("Save Structure Error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ... export existing functions
export const listExams = async (req, res) => {
  const { role, id: userId } = req.user;

  try {
    let query = supabase.from("exams").select("id, title, description, duration_minutes, status, created_at, access_code, security_level, target_audience");

    if (role === "student") {
      query = query.eq("status", "active");
    }

    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const createExam = async (req, res) => {
  const { title, description, duration_minutes, modules_config, access_code, security_level, target_audience, assigned_classroom_id } = req.body;
  const createdBy = req.user.id;

  if (!title || !duration_minutes) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const { data: exam, error } = await supabase
      .from("exams")
      .insert([
        {
          title,
          description,
          duration_minutes,
          modules_config: modules_config || {},
          access_code: access_code || Math.random().toString(36).substring(2, 8).toUpperCase(),
          created_by: createdBy,
          status: "draft",
          security_level: security_level || "standard",
          target_audience: target_audience || "all",
          assigned_classroom_id: assigned_classroom_id || null,
        },
      ])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(exam);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateExamStatus = async (req, res) => {
  const { id } = req.params;
  const { status, security_level, target_audience, assigned_classroom_id } = req.body;

  try {
    const updates = {};
    if (status) updates.status = status;
    if (security_level) updates.security_level = security_level;
    if (target_audience) updates.target_audience = target_audience;
    if (assigned_classroom_id !== undefined) updates.assigned_classroom_id = assigned_classroom_id;

    const { data, error } = await supabase
      .from("exams")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getExamLogs = async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from("violations")
      .select("*, user:user_id(first_name, last_name, email, username)")
      .eq("exam_id", id)
      .order("occurred_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getExam = async (req, res) => {
  const { id } = req.params;
  const { role } = req.user;

  try {
    // Get exam details
    const { data: exam, error: examError } = await supabase
      .from("exams")
      .select("*")
      .eq("id", id)
      .single();

    if (examError || !exam) {
      return res.status(404).json({ error: "Exam not found" });
    }

    // Check access
    if (role === "student" && exam.status !== "active") {
      return res.status(403).json({ error: "Exam is not active" });
    }

    // Fetch sections
    const { data: sections } = await supabase
      .from("exam_sections")
      .select("*")
      .eq("exam_id", id)
      .order("section_order", { ascending: true });

    // Fetch questions
    const { data: questions, error: questionsError } = await supabase
      .from("questions")
      .select("*")
      .eq("exam_id", id)
      .order("module_type")
      .order("question_number");

    if (questionsError) throw questionsError;

    // Remove correct answers if student
    const sanitizedQuestions = role === "student"
      ? questions.map(q => {
          const { correct_answer, ...rest } = q;
          return rest;
        })
      : questions;

    res.json({ ...exam, sections, questions: sanitizedQuestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Create a section
export const createSection = async (req, res) => {
  const { id: examId } = req.params;
  const { module_type, section_order, title, content, audio_url, duration_minutes } = req.body;

  try {
    const { data, error } = await supabase
      .from("exam_sections")
      .insert([
        {
          exam_id: examId,
          module_type,
          section_order,
          title,
          content,
          audio_url,
          duration_minutes
        }
      ])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const addQuestions = async (req, res) => {
  const { id: examId } = req.params;
  const { questions } = req.body; // Array of questions

  if (!Array.isArray(questions)) {
    return res.status(400).json({ error: "Questions must be an array" });
  }

  try {
    const questionsWithExamId = questions.map(q => ({
      exam_id: examId,
      ...q
    }));

    const { data, error } = await supabase
      .from("questions")
      .insert(questionsWithExamId)
      .select();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const submitExam = async (req, res) => {
  const { id: examId } = req.params;
  const userId = req.user.id;
  const { answers, time_spent_by_module } = req.body;

  try {
    // Check if already submitted
    const { data: existing } = await supabase
      .from("exam_submissions")
      .select("id")
      .eq("exam_id", examId)
      .eq("user_id", userId)
      .single();

    if (existing) {
      return res.status(409).json({ error: "Already submitted" });
    }

    // Fetch questions to grade
    const { data: questions } = await supabase
      .from("questions")
      .select("id, correct_answer, points")
      .eq("exam_id", examId);

    let totalScore = 0;
    let totalPoints = 0;
    const gradedAnswers = [];

    questions.forEach(q => {
      const userAns = answers[q.id];
      let isCorrect = false;
      let score = 0;

      if (userAns !== undefined) {
        // Simple string matching for MVP (case-insensitive)
        if (String(userAns).trim().toLowerCase() === String(q.correct_answer).trim().toLowerCase()) {
          isCorrect = true;
          score = q.points || 1;
        }
      }

      totalScore += score;
      totalPoints += (q.points || 1);

      gradedAnswers.push({
        question_id: q.id,
        user_answer: userAns,
        is_correct: isCorrect,
        score
      });
    });

    const overallBand = totalPoints > 0 ? (totalScore / totalPoints) * 9 : 0;

    // Create submission
    const { data: submission, error: subError } = await supabase
      .from("exam_submissions")
      .insert([
        {
          user_id: userId,
          exam_id: examId,
          scores_by_module: {}, 
          overall_band_score: overallBand,
          total_correct: totalScore,
          total_questions: questions.length,
          time_spent_by_module,
          status: "submitted",
          submitted_at: new Date(),
        },
      ])
      .select()
      .single();

    if (subError) throw subError;

    // Store answers
    const answerRecords = gradedAnswers.map(a => ({
      submission_id: submission.id,
      question_id: a.question_id,
      user_answer: a.user_answer,
      is_correct: a.is_correct,
      score: a.score
    }));

    const { error: ansError } = await supabase
      .from("answers")
      .insert(answerRecords);

    if (ansError) throw ansError;

    res.json({ message: "Exam submitted successfully", score: overallBand });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
