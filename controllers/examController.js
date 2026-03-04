// ... existing imports
import { supabase } from "../supabaseClient.js";

// ... existing functions (listExams, createExam, getExam, etc.)

export const saveExamStructure = async (req, res) => {
  const { id: examId } = req.params;
  const { exam, sections, questions, deletedQuestionIds, questionGroups, deletedGroupIds } = req.body;

  const warnings = []; // Track non-fatal issues

  try {
    // 1. Update Exam Metadata - try progressively smaller payloads
    const examFields = [
      { title: exam.title },
      { description: exam.description },
      { status: exam.status },
      { modules_config: exam.modules_config },
      { code: exam.code },
      { type: exam.type },
      { listening_config: exam.listening_config || null }
    ];
    
    // Build payload, removing fields that cause errors
    let examPayload = {};
    for (const field of examFields) {
      examPayload = { ...examPayload, ...field };
    }
    
    let examSaved = false;
    while (!examSaved && Object.keys(examPayload).length > 0) {
      const { error: examError } = await supabase
        .from("exams")
        .update(examPayload)
        .eq("id", examId);

      if (examError) {
        if (examError.code === '42703') {
          // Column doesn't exist - find and remove it
          const missingCol = examError.message.match(/column "([^"]+)"/)?.[1];
          if (missingCol) {
            warnings.push(`Column '${missingCol}' not found in exams table, skipping`);
            delete examPayload[missingCol];
          } else {
            // Can't identify column, try removing last added field
            const keys = Object.keys(examPayload);
            delete examPayload[keys[keys.length - 1]];
          }
        } else {
          throw examError;
        }
      } else {
        examSaved = true;
      }
    }

    // 2. Soft delete any questions that were removed (non-blocking)
    if (deletedQuestionIds && deletedQuestionIds.length > 0) {
      try {
        const { error: deleteError } = await supabase
          .from("questions")
          .update({ is_deleted: true })
          .in("id", deletedQuestionIds);
        
        if (deleteError) {
          warnings.push(`Soft delete skipped: ${deleteError.message}`);
        }
      } catch (e) {
        warnings.push(`Soft delete failed: ${e.message}`);
      }
    }

    // Map to store oldId -> newId mapping to return to frontend
    const idMapping = {
      sections: {},
      questions: {},
      groups: {}
    };

    // Helper: Try to save with progressively smaller payload
    const saveWithFallback = async (table, payload, id = null) => {
      let currentPayload = { ...payload };
      let maxAttempts = Object.keys(currentPayload).length;
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          if (id) {
            const { data, error } = await supabase.from(table).update(currentPayload).eq("id", id).select().single();
            if (error) {
              if (error.code === '42703') {
                const missingCol = error.message.match(/column "([^"]+)"/)?.[1];
                if (missingCol && currentPayload[missingCol] !== undefined) {
                  warnings.push(`Column '${missingCol}' not found in ${table}, skipping`);
                  delete currentPayload[missingCol];
                  continue;
                }
              }
              throw error;
            }
            return { data, error: null };
          } else {
            const { data, error } = await supabase.from(table).insert([currentPayload]).select().single();
            if (error) {
              if (error.code === '42703') {
                const missingCol = error.message.match(/column "([^"]+)"/)?.[1];
                if (missingCol && currentPayload[missingCol] !== undefined) {
                  warnings.push(`Column '${missingCol}' not found in ${table}, skipping`);
                  delete currentPayload[missingCol];
                  continue;
                }
              }
              throw error;
            }
            return { data, error: null };
          }
        } catch (err) {
          if (attempt === maxAttempts - 1) throw err;
        }
      }
      return { data: null, error: new Error('All fields failed') };
    };

    // 3. Upsert Sections
    for (const section of sections) {
      const sectionPayload = {
        exam_id: examId,
        module_type: section.module_type,
        section_order: section.section_order,
        title: section.title,
        content: section.content,
        audio_url: section.audio_url,
        task_config: section.task_config || null,
        audio_start_time: section.audio_start_time || 0,
        section_description: section.section_description || null
      };

      let sectionId = section.id;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sectionId);
      
      try {
        if (isUUID) {
          await saveWithFallback("exam_sections", sectionPayload, sectionId);
        } else {
          const { data: newSection } = await saveWithFallback("exam_sections", sectionPayload);
          if (newSection) {
            idMapping.sections[sectionId] = newSection.id;
            sectionId = newSection.id;
          }
        }
      } catch (err) {
        warnings.push(`Section ${section.title || sectionId} save failed: ${err.message}`);
        continue; // Skip this section's questions but continue with others
      }

      // 4. Upsert Questions for this section
      const sectionQuestions = questions.filter(q => q.section_id === section.id);
      
      for (const q of sectionQuestions) {
        try {
          // Extract standard DB columns
          const standardFields = ['id', 'section_id', 'question_text', 'text', 'question_type', 'type',
                                  'correct_answer', 'answer', 'points', 'question_number', 'exam_id', 
                                  'module_type', 'created_at', 'is_deleted', 'difficulty_level'];
          
          // All other fields (options, headings, endings, match options, etc.) go into question_data
          const questionData = {};
          for (const [key, value] of Object.entries(q)) {
            if (!standardFields.includes(key) && value !== undefined && value !== null && value !== '') {
              questionData[key] = value;
            }
          }

          const qPayload = {
            exam_id: examId,
            section_id: sectionId, // Use the real (possibly new) section ID
            question_text: q.question_text || q.text || '', // Handle potential naming mismatch
            question_type: q.question_type || q.type,
            correct_answer: q.correct_answer || q.answer,
            points: q.points || 1,
            question_number: q.question_number || 0,
            question_data: Object.keys(questionData).length > 0 ? questionData : null
          };

          const qId = q.id;
          const isQUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(qId);

          if (isQUUID) {
            await saveWithFallback("questions", qPayload, qId);
          } else {
            const { data: newQuestion } = await saveWithFallback("questions", qPayload);
            if (newQuestion) {
              idMapping.questions[qId] = newQuestion.id;
            }
          }
        } catch (qErr) {
          warnings.push(`Question ${q.question_number || q.id} save failed: ${qErr.message}`);
          // Continue with next question
        }
      }

      // 5. Handle Question Groups for listening sections
      // Store question groups in section content as JSON if table doesn't exist
      if (section.module_type === 'listening' && questionGroups) {
        const sectionGroups = questionGroups.filter(g => g.section_id === section.id);
        
        // Try to use the dedicated table, fall back to storing in section
        let useGroupsTable = true;
        
        for (const group of sectionGroups) {
          if (!useGroupsTable) break;
          
          const groupPayload = {
            section_id: sectionId,
            group_order: group.group_order || 1,
            question_range_start: group.question_range_start,
            question_range_end: group.question_range_end,
            question_type: group.question_type,
            instruction_text: group.instruction_text || null,
            max_words: group.max_words || null,
            max_numbers: group.max_numbers || null,
            answer_format: group.answer_format || 'words_and_numbers',
            has_example: group.has_example || false,
            example_data: group.example_data || null,
            audio_start_time: group.audio_start_time || null,
            shared_options: group.shared_options || null,
            image_url: group.image_url || null,
            image_description: group.image_description || null,
            layout_type: group.layout_type || null,
            points_per_question: group.points_per_question || 1,
            case_sensitive: group.case_sensitive || false,
            spelling_tolerance: group.spelling_tolerance !== false
          };

          const groupId = group.id;
          const isGroupUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupId);

          try {
            if (isGroupUUID) {
              const { error: gUpdateError } = await supabase
                .from("listening_question_groups")
                .update(groupPayload)
                .eq("id", groupId);
              if (gUpdateError) {
                if (gUpdateError.code === '42P01' || gUpdateError.code === '42703') {
                  useGroupsTable = false;
                } else {
                  warnings.push(`Group update failed: ${gUpdateError.message}`);
                }
              }
            } else {
              const { data: newGroup, error: gInsertError } = await supabase
                .from("listening_question_groups")
                .insert([groupPayload])
                .select()
                .single();
              
              if (gInsertError) {
                if (gInsertError.code === '42P01' || gInsertError.code === '42703') {
                  useGroupsTable = false;
                } else {
                  warnings.push(`Group insert failed: ${gInsertError.message}`);
                }
              }
              if (newGroup) idMapping.groups[groupId] = newGroup.id;
            }
          } catch (err) {
            if (err.code === '42P01' || err.code === '42703') {
              useGroupsTable = false;
            } else {
              warnings.push(`Group save error: ${err.message}`);
            }
          }
        }
        
        // Fallback: store groups in section's task_config as JSON
        if (!useGroupsTable && sectionGroups.length > 0) {
          try {
            const groupsData = sectionGroups.map(g => ({
              ...g,
              section_id: sectionId // Update to real section ID
            }));
            await supabase
              .from("exam_sections")
              .update({ task_config: JSON.stringify({ question_groups: groupsData }) })
              .eq("id", sectionId);
          } catch (fallbackErr) {
            warnings.push(`Groups fallback save failed: ${fallbackErr.message}`);
          }
        }
      }
    }

    // 6. Delete removed question groups (non-blocking)
    if (deletedGroupIds && deletedGroupIds.length > 0) {
      try {
        const { error: deleteGroupError } = await supabase
          .from("listening_question_groups")
          .delete()
          .in("id", deletedGroupIds);
        
        if (deleteGroupError && deleteGroupError.code !== '42P01') {
          warnings.push(`Failed to delete question groups: ${deleteGroupError.message}`);
        }
      } catch (e) {
        warnings.push(`Group deletion failed: ${e.message}`);
      }
    }

    // Return success with warnings if any
    const response = { 
      message: "Exam structure saved successfully", 
      idMapping 
    };
    
    if (warnings.length > 0) {
      response.warnings = warnings;
      console.log("Save completed with warnings:", warnings);
    }
    
    res.json(response);
  } catch (err) {
    console.error("Save Structure Error:", err);
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
          
          if (!groupsError && groups?.length > 0) {
            questionGroups = groups;
          } else {
            // Fallback: read from section's task_config
            for (const sec of listeningSections) {
              if (sec.task_config) {
                try {
                  const config = typeof sec.task_config === 'string' ? JSON.parse(sec.task_config) : sec.task_config;
                  if (config.question_groups) {
                    questionGroups.push(...config.question_groups);
                  }
                } catch (e) { /* ignore parse errors */ }
              }
            }
          }
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
      
      if (!groupsError && groups?.length > 0) {
        questionGroups = groups;
      } else {
        // Fallback: read from section's task_config
        for (const sec of listeningSections) {
          if (sec.task_config) {
            try {
              const config = typeof sec.task_config === 'string' ? JSON.parse(sec.task_config) : sec.task_config;
              if (config.question_groups) {
                questionGroups.push(...config.question_groups);
              }
            } catch (e) { /* ignore parse errors */ }
          }
        }
      }
    }

    res.json({ ...exam, sections, questions: sanitizedQuestions, questionGroups });
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
