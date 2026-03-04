// ... existing imports
import { supabase } from "../supabaseClient.js";

// ... existing functions (listExams, createExam, getExam, etc.)

export const saveExamStructure = async (req, res) => {
  const { id: examId } = req.params;
  const { exam, sections, questions, deletedQuestionIds, questionGroups, deletedGroupIds } = req.body;

  console.log(`\n========== SAVE START ==========`);
  console.log(`[SAVE] Exam ID: ${examId}`);
  console.log(`[SAVE] Sections received: ${sections?.length || 0}`);
  console.log(`[SAVE] Questions received: ${questions?.length || 0}`);
  console.log(`[SAVE] Question Groups received: ${questionGroups?.length || 0}`);
  
  if (questionGroups?.length > 0) {
    console.log(`[SAVE] Groups detail:`, JSON.stringify(questionGroups.map(g => ({
      id: g.id,
      section_id: g.section_id,
      type: g.question_type,
      range: `${g.question_range_start}-${g.question_range_end}`
    })), null, 2));
  }

  const warnings = [];
  const idMapping = { sections: {}, questions: {}, groups: {} };

  try {
    // 1. Update Exam Metadata (basic fields only)
    // Also store question groups in modules_config as a GUARANTEED fallback
    const modulesConfig = exam.modules_config || {};
    if (questionGroups && questionGroups.length > 0) {
      modulesConfig.listening_question_groups = questionGroups.map(g => ({
        id: g.id,
        section_id: g.section_id,
        group_order: g.group_order || 1,
        question_type: g.question_type,
        question_range_start: g.question_range_start,
        question_range_end: g.question_range_end,
        instruction_text: g.instruction_text || null,
        max_words: g.max_words || null,
        max_numbers: g.max_numbers || null,
        answer_format: g.answer_format || 'words_and_numbers',
        has_example: g.has_example || false,
        example_data: g.example_data || null,
        audio_start_time: g.audio_start_time || null,
        shared_options: g.shared_options || null,
        image_url: g.image_url || null,
        image_description: g.image_description || null,
        layout_type: g.layout_type || null,
        points_per_question: g.points_per_question || 1,
        case_sensitive: g.case_sensitive || false,
        spelling_tolerance: g.spelling_tolerance !== false
      }));
      console.log(`[SAVE] Storing ${questionGroups.length} groups in modules_config.listening_question_groups`);
    }
    
    const examPayload = {
      title: exam.title,
      description: exam.description,
      status: exam.status,
      modules_config: modulesConfig,
      code: exam.code,
      type: exam.type
    };
    
    const { error: examError } = await supabase
      .from("exams")
      .update(examPayload)
      .eq("id", examId);

    if (examError) {
      console.error(`[SAVE] Exam update error:`, examError);
      throw new Error(`Failed to update exam: ${examError.message}`);
    }
    console.log(`[SAVE] Exam metadata updated (including question groups fallback)`);

    // 2. Soft delete removed questions
    if (deletedQuestionIds?.length > 0) {
      const { error: deleteErr } = await supabase
        .from("questions")
        .update({ is_deleted: true })
        .in("id", deletedQuestionIds);
      if (deleteErr) warnings.push(`Soft delete: ${deleteErr.message}`);
    }

    // 3. Upsert Sections and their Questions/Groups
    for (const section of sections) {
      console.log(`\n[SAVE] Processing section: ${section.id} (${section.module_type})`);
      
      const sectionPayload = {
        exam_id: examId,
        module_type: section.module_type,
        section_order: section.section_order,
        title: section.title,
        content: section.content,
        audio_url: section.audio_url
        // task_config will be set separately for listening sections
      };

      let sectionId = section.id;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sectionId);
      
      if (isUUID) {
        // Update existing section
        const { error } = await supabase
          .from("exam_sections")
          .update(sectionPayload)
          .eq("id", sectionId);
        if (error) {
          console.error(`[SAVE] Section update error:`, error);
          warnings.push(`Section ${section.title}: ${error.message}`);
        } else {
          console.log(`[SAVE] Section updated: ${sectionId}`);
        }
      } else {
        // Insert new section
        const { data: newSection, error } = await supabase
          .from("exam_sections")
          .insert([sectionPayload])
          .select()
          .single();
        if (error) {
          console.error(`[SAVE] Section insert error:`, error);
          warnings.push(`Section ${section.title}: ${error.message}`);
          continue;
        }
        if (newSection) {
          idMapping.sections[sectionId] = newSection.id;
          console.log(`[SAVE] Section created: ${sectionId} -> ${newSection.id}`);
          sectionId = newSection.id;
        }
      }

      // 4. Save Questions for this section
      const sectionQuestions = questions.filter(q => q.section_id === section.id);
      console.log(`[SAVE] Section ${section.id} has ${sectionQuestions.length} questions`);
      
      for (const q of sectionQuestions) {
        // Pack all extra fields into question_data
        const { id, section_id, question_text, question_type, correct_answer, points, question_number, exam_id, created_at, is_deleted, ...extraFields } = q;
        
        const qPayload = {
          exam_id: examId,
          section_id: sectionId,
          question_text: question_text || q.text || '',
          question_type: question_type || q.type || 'multiple_choice',
          correct_answer: correct_answer || q.answer || '',
          points: points || 1,
          question_number: question_number || 0,
          question_data: Object.keys(extraFields).length > 0 ? extraFields : null
        };

        const isQUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q.id);

        if (isQUUID) {
          const { error } = await supabase
            .from("questions")
            .update(qPayload)
            .eq("id", q.id);
          if (error) {
            console.error(`[SAVE] Question update error for ${q.id}:`, error);
            warnings.push(`Q${question_number}: ${error.message}`);
          }
        } else {
          const { data: newQ, error } = await supabase
            .from("questions")
            .insert([qPayload])
            .select()
            .single();
          if (error) {
            console.error(`[SAVE] Question insert error:`, error);
            warnings.push(`Q${question_number}: ${error.message}`);
          }
          if (newQ) {
            idMapping.questions[q.id] = newQ.id;
            console.log(`[SAVE] Question created: ${q.id} -> ${newQ.id}`);
          }
        }
      }

      // 5. Handle Question Groups for listening sections
      if (section.module_type === 'listening' && questionGroups) {
        // Find groups that belong to this section (match by original OR new section ID)
        const originalSectionId = section.id;
        const sectionGroups = questionGroups.filter(g => {
          const match = g.section_id === originalSectionId || g.section_id === sectionId;
          console.log(`[SAVE] Group ${g.id} section_id=${g.section_id}, checking against original=${originalSectionId}, actual=${sectionId}, match=${match}`);
          return match;
        });
        console.log(`[SAVE] Section ${section.id} (${section.module_type}) has ${sectionGroups.length} question groups out of ${questionGroups.length} total`);
        
        if (sectionGroups.length > 0) {
          // Store groups in section's task_config with UPDATED section_id
          const groupsConfig = {
            question_groups: sectionGroups.map(g => ({
              id: g.id,
              section_id: sectionId, // Use the real (possibly new) section ID
              group_order: g.group_order || 1,
              question_type: g.question_type,
              question_range_start: g.question_range_start,
              question_range_end: g.question_range_end,
              instruction_text: g.instruction_text || null,
              max_words: g.max_words || null,
              max_numbers: g.max_numbers || null,
              answer_format: g.answer_format || 'words_and_numbers',
              has_example: g.has_example || false,
              example_data: g.example_data || null,
              audio_start_time: g.audio_start_time || null,
              shared_options: g.shared_options || null,
              image_url: g.image_url || null,
              image_description: g.image_description || null,
              layout_type: g.layout_type || null,
              points_per_question: g.points_per_question || 1,
              case_sensitive: g.case_sensitive || false,
              spelling_tolerance: g.spelling_tolerance !== false
            }))
          };
          
          console.log(`[SAVE] Saving groups to task_config for section ${sectionId}:`, JSON.stringify(groupsConfig.question_groups.map(g => ({
            id: g.id,
            section_id: g.section_id,
            type: g.question_type,
            range: `${g.question_range_start}-${g.question_range_end}`
          }))));
          
          const { error: taskConfigError } = await supabase
            .from("exam_sections")
            .update({ task_config: JSON.stringify(groupsConfig) })
            .eq("id", sectionId);
            
          if (taskConfigError) {
            console.error(`[SAVE] Failed to save groups to task_config:`, taskConfigError);
            warnings.push(`Groups for ${section.title}: ${taskConfigError.message}`);
          } else {
            console.log(`[SAVE] Groups saved to task_config for section ${sectionId}`);
          }
        }
      }
    }

    console.log(`\n========== SAVE COMPLETE ==========`);
    console.log(`[SAVE] ID Mappings:`, JSON.stringify(idMapping));
    console.log(`[SAVE] Warnings: ${warnings.length}`);
    if (warnings.length > 0) console.log(`[SAVE] Warning details:`, warnings);
    
    res.json({ 
      message: "Exam structure saved successfully", 
      idMapping,
      warnings: warnings.length > 0 ? warnings : undefined
    });
  } catch (err) {
    console.error("[SAVE] Fatal error:", err);
    res.status(500).json({ error: err.message, warnings });
  }
};

// ... export existing functions
export const listExams = async (req, res) => {
  try {
    const userRole = req.user?.role;
    
    let query = supabase
      .from("exams")
      .select("*")
      .neq("is_deleted", true) // Always exclude soft-deleted exams from main list
      .neq("status", "deleted"); // Double check status too

    // If student, only show active exams
    if (userRole === "student") {
      query = query.eq("status", "active");
    }
    // If admin, show all (draft, active, archived) EXCEPT deleted (handled above)

    const { data, error } = await query.order("created_at", { ascending: false });

    if (error) {
       // If is_deleted column missing, try gracefully
       if (error.code === '42703') {
         const { data: fallback, error: fbError } = await supabase
           .from("exams")
           .select("*")
           .neq("status", "deleted")
           .order("created_at", { ascending: false });
           
         if (fbError) throw fbError;
         return res.json(fallback);
       }
       throw error;
    }
    res.json(data);
  } catch (err) {
    console.error("List Exams Error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const deleteExam = async (req, res) => {
  const { id } = req.params;

  try {
    // Soft delete
    const { data, error } = await supabase
      .from("exams")
      .update({ status: 'deleted', is_deleted: true }) // Assuming is_deleted column exists or using status
      .eq("id", id)
      .select()
      .single();

    // Fallback if is_deleted column doesn't exist, just update status
    if (error && error.code === '42703') { // Undefined column
       const { error: fallbackError } = await supabase
        .from("exams")
        .update({ status: 'deleted' })
        .eq("id", id);
       if (fallbackError) throw fallbackError;
       return res.json({ message: "Exam deleted successfully (status set to deleted)" });
    } else if (error) {
      throw error;
    }

    res.json({ message: "Exam deleted successfully", exam: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const restoreExam = async (req, res) => {
  const { id } = req.params;

  try {
    // Generate a new access code when restoring
    const newAccessCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const { data, error } = await supabase
      .from("exams")
      .update({ status: 'draft', is_deleted: false, access_code: newAccessCode })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json({ message: "Exam restored successfully", exam: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const permanentlyDeleteExam = async (req, res) => {
  const { id } = req.params;

  try {
    // First delete all related questions
    await supabase.from("questions").delete().eq("exam_id", id);
    
    // Delete all related sections
    await supabase.from("exam_sections").delete().eq("exam_id", id);
    
    // Delete all submissions and answers
    const { data: submissions } = await supabase
      .from("exam_submissions")
      .select("id")
      .eq("exam_id", id);
    
    if (submissions?.length) {
      const submissionIds = submissions.map(s => s.id);
      await supabase.from("answers").delete().in("submission_id", submissionIds);
      await supabase.from("exam_submissions").delete().eq("exam_id", id);
    }
    
    // Finally delete the exam
    const { error } = await supabase
      .from("exams")
      .delete()
      .eq("id", id);

    if (error) throw error;
    res.json({ message: "Exam permanently deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const regenerateExamCode = async (req, res) => {
  const { id } = req.params;

  try {
    const newAccessCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const { data, error } = await supabase
      .from("exams")
      .update({ access_code: newAccessCode })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json({ message: "Exam code regenerated", exam: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Question soft delete
export const deleteQuestion = async (req, res) => {
  const { questionId } = req.params;

  try {
    const { data, error } = await supabase
      .from("questions")
      .update({ is_deleted: true })
      .eq("id", questionId)
      .select()
      .single();

    if (error) throw error;
    res.json({ message: "Question deleted successfully", question: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const restoreQuestion = async (req, res) => {
  const { questionId } = req.params;

  try {
    const { data, error } = await supabase
      .from("questions")
      .update({ is_deleted: false })
      .eq("id", questionId)
      .select()
      .single();

    if (error) throw error;
    res.json({ message: "Question restored successfully", question: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const listDeletedQuestions = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("questions")
      .select("*, exam:exam_id(title)")
      .eq("is_deleted", true)
      .order("updated_at", { ascending: false });

    if (error) {
      if (error.code === '42703') { // is_deleted column missing
        return res.json([]);
      }
      throw error;
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const permanentlyDeleteQuestion = async (req, res) => {
  const { questionId } = req.params;

  try {
    // Delete related answers first
    await supabase.from("answers").delete().eq("question_id", questionId);
    
    // Delete the question
    const { error } = await supabase
      .from("questions")
      .delete()
      .eq("id", questionId);

    if (error) throw error;
    res.json({ message: "Question permanently deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const listDeletedExams = async (req, res) => {
  try {
    // Try to fetch deleted exams
    // We check for is_deleted = true OR status = 'deleted'
    // Note: 'or' syntax in supabase-js is .or('col1.eq.val1,col2.eq.val2')
    
    const { data, error } = await supabase
      .from("exams")
      .select("*")
      .or("is_deleted.eq.true,status.eq.deleted")
      .order("updated_at", { ascending: false });

    if (error) {
       if (error.code === '42703') { // Undefined column
         // Fallback: try just status if is_deleted is missing
         const { data: fallbackData, error: fallbackError } = await supabase
          .from("exams")
          .select("*")
          .eq("status", "deleted")
          .order("created_at", { ascending: false });
          
         if (fallbackError) throw fallbackError;
         return res.json(fallbackData);
       }
       throw error;
    }
    res.json(data);
  } catch (err) {
    console.error("List Deleted Exams Error:", err);
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
    if (status) {
      updates.status = status;
      // Auto-generate access code when activating if not exists
      if (status === 'active') {
        // First check if exam already has an access code
        const { data: existing } = await supabase
          .from("exams")
          .select("access_code")
          .eq("id", id)
          .single();
        
        if (!existing?.access_code) {
          updates.access_code = Math.random().toString(36).substring(2, 8).toUpperCase();
        }
      }
    }
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

  console.log(`\n========== GET EXAM ${id} ==========`);

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

    console.log(`[GET] Sections loaded: ${sections?.length || 0}`);
    if (sections) {
      sections.forEach(s => {
        console.log(`[GET] Section ${s.id}: type=${s.module_type}, task_config=${s.task_config ? 'present (' + s.task_config.substring(0, 100) + '...)' : 'NULL'}`);
      });
    }

    // Fetch questions (exclude deleted)
    const { data: questions, error: questionsError } = await supabase
      .from("questions")
      .select("*")
      .eq("exam_id", id)
      .neq("is_deleted", true)
      .order("module_type")
      .order("question_number");

    if (questionsError) {
      // If is_deleted column missing, try without it
      if (questionsError.code === '42703') {
        const { data: fallbackQuestions } = await supabase
          .from("questions")
          .select("*")
          .eq("exam_id", id)
          .order("module_type")
          .order("question_number");
        
        // Merge question_data fields into each question object
        const mergedFallback = fallbackQuestions?.map(q => {
          const { question_data, ...rest } = q;
          return { ...rest, ...(question_data || {}) };
        }) || [];
        
        console.log(`[GET] Questions loaded (fallback): ${mergedFallback.length}`);
        
        const sanitizedFallback = role === "student"
          ? mergedFallback.map(q => {
              const { correct_answer, ...rest } = q;
              return rest;
            })
          : mergedFallback;

        // Fetch question groups for listening sections
        let questionGroups = [];
        const listeningSections = sections?.filter(s => s.module_type === 'listening') || [];
        const listeningSectionIds = listeningSections.map(s => s.id);
        
        if (listeningSectionIds.length > 0) {
          // Try dedicated table first
          const { data: groups, error: groupsError } = await supabase
            .from("listening_question_groups")
            .select("*")
            .in("section_id", listeningSectionIds)
            .order("group_order", { ascending: true });
          
          console.log(`[GET] Groups from table: ${groups?.length || 0}, error: ${groupsError?.message || 'none'}`);
          
          if (!groupsError && groups?.length > 0) {
            questionGroups = groups;
          } else {
            // Fallback 1: read from section's task_config
            console.log(`[GET] Falling back to task_config for groups`);
            for (const sec of listeningSections) {
              console.log(`[GET] Section ${sec.id} task_config:`, sec.task_config ? 'present' : 'null');
              if (sec.task_config) {
                try {
                  const config = typeof sec.task_config === 'string' ? JSON.parse(sec.task_config) : sec.task_config;
                  if (config.question_groups) {
                    console.log(`[GET] Found ${config.question_groups.length} groups in section ${sec.id}`);
                    questionGroups.push(...config.question_groups);
                  }
                } catch (e) { 
                  console.error(`[GET] Failed to parse task_config for section ${sec.id}:`, e.message);
                }
              }
            }
            
            // Fallback 2: read from exam's modules_config (GUARANTEED to exist)
            if (questionGroups.length === 0 && exam.modules_config?.listening_question_groups) {
              console.log(`[GET] Falling back to modules_config for groups`);
              questionGroups = exam.modules_config.listening_question_groups;
              console.log(`[GET] Found ${questionGroups.length} groups in modules_config`);
            }
          }
        }
        
        console.log(`[GET] Total question groups: ${questionGroups.length}`);
        if (questionGroups.length > 0) {
          console.log(`[GET] Groups:`, questionGroups.map(g => ({
            id: g.id,
            section_id: g.section_id,
            type: g.question_type,
            range: `${g.question_range_start}-${g.question_range_end}`
          })));
        }
        
        return res.json({ ...exam, sections, questions: sanitizedFallback || [], questionGroups });
      }
      throw questionsError;
    }

    // Merge question_data fields into each question object for frontend use
    const mergedQuestions = questions?.map(q => {
      const { question_data, ...rest } = q;
      // Spread question_data fields into the question object
      return { ...rest, ...(question_data || {}) };
    }) || [];

    console.log(`[GET] Questions loaded: ${mergedQuestions.length}`);

    // Remove correct answers if student
    const sanitizedQuestions = role === "student"
      ? mergedQuestions.map(q => {
          const { correct_answer, ...rest } = q;
          return rest;
        })
      : mergedQuestions;

    // Fetch question groups for listening sections
    let questionGroups = [];
    const listeningSections = sections?.filter(s => s.module_type === 'listening') || [];
    const listeningSectionIds = listeningSections.map(s => s.id);
    
    if (listeningSectionIds.length > 0) {
      // Try dedicated table first
      const { data: groups, error: groupsError } = await supabase
        .from("listening_question_groups")
        .select("*")
        .in("section_id", listeningSectionIds)
        .order("group_order", { ascending: true });
      
      console.log(`[GET] Groups from table: ${groups?.length || 0}, error: ${groupsError?.message || 'none'}`);
      
      if (!groupsError && groups?.length > 0) {
        questionGroups = groups;
      } else {
        // Fallback 1: read from section's task_config
        console.log(`[GET] Falling back to task_config for groups`);
        for (const sec of listeningSections) {
          console.log(`[GET] Section ${sec.id} task_config:`, sec.task_config ? 'present' : 'null');
          if (sec.task_config) {
            try {
              const config = typeof sec.task_config === 'string' ? JSON.parse(sec.task_config) : sec.task_config;
              if (config.question_groups) {
                console.log(`[GET] Found ${config.question_groups.length} groups in section ${sec.id}`);
                questionGroups.push(...config.question_groups);
              }
            } catch (e) { 
              console.error(`[GET] Failed to parse task_config for section ${sec.id}:`, e.message);
            }
          }
        }
        
        // Fallback 2: read from exam's modules_config (GUARANTEED to exist)
        if (questionGroups.length === 0 && exam.modules_config?.listening_question_groups) {
          console.log(`[GET] Falling back to modules_config for groups`);
          questionGroups = exam.modules_config.listening_question_groups;
          console.log(`[GET] Found ${questionGroups.length} groups in modules_config`);
        }
      }
    }

    console.log(`[GET] Total question groups: ${questionGroups.length}`);
    console.log(`========== GET COMPLETE ==========\n`);

    res.json({ ...exam, sections, questions: sanitizedQuestions, questionGroups });
  } catch (err) {
    console.error(`[GET] Error:`, err);
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

// Get exam statistics (participants count)
export const getExamStats = async (req, res) => {
  const { id } = req.params;

  try {
    // Get count of students currently in the exam (in_progress)
    const { count: activeCount, error: activeError } = await supabase
      .from("exam_submissions")
      .select("*", { count: "exact", head: true })
      .eq("exam_id", id)
      .eq("status", "in_progress");

    if (activeError) throw activeError;

    // Get total count of all students who have ever joined
    const { count: totalCount, error: totalError } = await supabase
      .from("exam_submissions")
      .select("*", { count: "exact", head: true })
      .eq("exam_id", id);

    if (totalError) throw totalError;

    // Get count of completed submissions
    const { count: completedCount, error: completedError } = await supabase
      .from("exam_submissions")
      .select("*", { count: "exact", head: true })
      .eq("exam_id", id)
      .in("status", ["submitted", "auto_submitted"]);

    if (completedError) throw completedError;

    res.json({
      active_participants: activeCount || 0,
      total_participants: totalCount || 0,
      completed_count: completedCount || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update access code manually
export const updateAccessCode = async (req, res) => {
  const { id } = req.params;
  const { access_code } = req.body;

  if (!access_code || access_code.length < 4 || access_code.length > 12) {
    return res.status(400).json({ error: "Access code must be between 4 and 12 characters" });
  }

  try {
    // Check if access code is already in use by another exam
    const { data: existing, error: checkError } = await supabase
      .from("exams")
      .select("id")
      .eq("access_code", access_code.toUpperCase())
      .neq("id", id)
      .maybeSingle();

    if (checkError) throw checkError;
    if (existing) {
      return res.status(400).json({ error: "This access code is already in use by another exam" });
    }

    const { data, error } = await supabase
      .from("exams")
      .update({ access_code: access_code.toUpperCase() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json({ message: "Access code updated", exam: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
