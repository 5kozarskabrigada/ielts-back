// ... existing imports
import { supabase } from "../supabaseClient.js";

// ... existing functions (listExams, createExam, getExam, etc.)

// Helper to check if string is a valid UUID
const isUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

export const saveExamStructure = async (req, res) => {
  const { id: examId } = req.params;
  const { exam, sections, questions, deletedQuestionIds, questionGroups, deletedGroupIds } = req.body;

  console.log(`\n========== SAVE START (OPTIMIZED) ==========`);
  console.log(`[SAVE] Exam ID: ${examId}`);
  console.log(`[SAVE] Sections: ${sections?.length || 0}, Questions: ${questions?.length || 0}, Groups: ${questionGroups?.length || 0}`);

  const warnings = [];
  const idMapping = { sections: {}, questions: {}, groups: {} };

  try {
    // 1. Update Exam Metadata first (WITHOUT question groups - we'll add them after section IDs are resolved)
    const { error: examError } = await supabase
      .from("exams")
      .update({
        title: exam.title,
        description: exam.description,
        status: exam.status,
        code: exam.code,
        type: exam.type
      })
      .eq("id", examId);

    if (examError) throw new Error(`Failed to update exam: ${examError.message}`);
    console.log(`[SAVE] Exam metadata saved`);

    // 2. Soft delete removed questions (single batch operation)
    if (deletedQuestionIds?.length > 0) {
      await supabase.from("questions").update({ is_deleted: true }).in("id", deletedQuestionIds);
    }

    // 3. Process Sections - separate new vs existing for batching
    const existingSections = sections.filter(s => isUUID(s.id));
    const newSections = sections.filter(s => !isUUID(s.id));

    // Batch update existing sections
    if (existingSections.length > 0) {
      await Promise.all(existingSections.map(section => 
        supabase.from("exam_sections").update({
          exam_id: examId,
          module_type: section.module_type,
          section_order: section.section_order,
          title: section.title,
          content: section.content,
          audio_url: section.audio_url
        }).eq("id", section.id)
      ));
      console.log(`[SAVE] Updated ${existingSections.length} existing sections`);
    }

    // Insert new sections (must be sequential to get IDs)
    for (const section of newSections) {
      const { data: newSection, error } = await supabase
        .from("exam_sections")
        .insert([{
          exam_id: examId,
          module_type: section.module_type,
          section_order: section.section_order,
          title: section.title,
          content: section.content,
          audio_url: section.audio_url
        }])
        .select()
        .single();
      if (newSection) {
        idMapping.sections[section.id] = newSection.id;
        console.log(`[SAVE] New section: ${section.id} -> ${newSection.id}`);
      }
    }

    // 4. NOW save question groups to modules_config with MAPPED section IDs
    const modulesConfig = exam.modules_config || {};
    if (questionGroups && questionGroups.length > 0) {
      modulesConfig.listening_question_groups = questionGroups.map(g => {
        // Map section_id to real UUID if it was a temp ID
        const mappedSectionId = idMapping.sections[g.section_id] || g.section_id;
        return {
          id: g.id,
          section_id: mappedSectionId,
          group_order: g.group_order || 1,
          question_type: g.question_type,
          question_range_start: g.question_range_start,
          question_range_end: g.question_range_end,
          instruction_text: g.instruction_text || null,
          table_title: g.table_title || null,
          table_data: g.table_data || null,
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
        };
      });
      
      // Update exam with mapped question groups
      await supabase
        .from("exams")
        .update({ modules_config: modulesConfig })
        .eq("id", examId);
      console.log(`[SAVE] Saved ${modulesConfig.listening_question_groups.length} question groups to modules_config with mapped section IDs`);
    }

    // 5. Process Questions - batch by new vs existing
    // First, map section IDs for all questions
    const mappedQuestions = questions.map(q => {
      const mappedSectionId = idMapping.sections[q.section_id] || q.section_id;
      const { 
        id, section_id, question_text, question_type, correct_answer, points, question_number, 
        exam_id, created_at, is_deleted, 
        // Form/table completion fields
        is_info_row, row_order, label_text, info_text, question_template, answer_alternatives,
        // Options for multiple choice
        option_a, option_b, option_c, option_d,
        ...extraFields 
      } = q;
      return {
        originalId: id,
        isNew: !isUUID(id),
        payload: {
          exam_id: examId,
          section_id: mappedSectionId,
          question_text: question_text || q.text || '',
          question_type: question_type || q.type || 'multiple_choice',
          correct_answer: correct_answer || q.answer || '',
          points: points || 1,
          question_number: question_number || 0,
          // Form/table completion fields
          is_info_row: is_info_row || false,
          row_order: row_order || null,
          label_text: label_text || null,
          info_text: info_text || null,
          question_template: question_template || null,
          answer_alternatives: answer_alternatives || null,
          // Options for multiple choice
          option_a: option_a || null,
          option_b: option_b || null,
          option_c: option_c || null,
          option_d: option_d || null,
          question_data: Object.keys(extraFields).length > 0 ? extraFields : null
        }
      };
    });

    const existingQuestions = mappedQuestions.filter(q => !q.isNew);
    const newQuestions = mappedQuestions.filter(q => q.isNew);

    // Batch update existing questions (parallel)
    if (existingQuestions.length > 0) {
      await Promise.all(existingQuestions.map(q =>
        supabase.from("questions").update(q.payload).eq("id", q.originalId)
      ));
      console.log(`[SAVE] Updated ${existingQuestions.length} existing questions`);
    }

    // Batch insert new questions
    if (newQuestions.length > 0) {
      const { data: insertedQuestions, error: insertError } = await supabase
        .from("questions")
        .insert(newQuestions.map(q => q.payload))
        .select();
      
      if (insertedQuestions) {
        // Map old IDs to new IDs (by matching on question_number + section_id)
        insertedQuestions.forEach((inserted, idx) => {
          if (newQuestions[idx]) {
            idMapping.questions[newQuestions[idx].originalId] = inserted.id;
          }
        });
        console.log(`[SAVE] Inserted ${insertedQuestions.length} new questions`);
      }
    }

    // 6. Update task_config for listening sections (store groups there too as backup)
    const listeningSections = sections.filter(s => s.module_type === 'listening');
    if (listeningSections.length > 0 && questionGroups?.length > 0) {
      await Promise.all(listeningSections.map(section => {
        const realSectionId = idMapping.sections[section.id] || section.id;
        const sectionGroups = questionGroups.filter(g => 
          g.section_id === section.id || g.section_id === realSectionId
        );
        
        if (sectionGroups.length > 0) {
          const groupsConfig = {
            question_groups: sectionGroups.map(g => ({
              ...g,
              section_id: realSectionId
            }))
          };
          return supabase
            .from("exam_sections")
            .update({ task_config: JSON.stringify(groupsConfig) })
            .eq("id", realSectionId);
        }
        return Promise.resolve();
      }));
      console.log(`[SAVE] Updated task_config for ${listeningSections.length} listening sections`);
    }

    console.log(`========== SAVE COMPLETE ==========\n`);
    res.json({ message: "Exam saved", idMapping, warnings: warnings.length > 0 ? warnings : undefined });
  } catch (err) {
    console.error("[SAVE] Error:", err);
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
