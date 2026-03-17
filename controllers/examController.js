// ... existing imports
import { supabase } from "../supabaseClient.js";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import net from "net";
import { Readable } from "stream";

const MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB (project storage cap)
const MAX_AUDIO_UPLOAD_MB = 50;
const JWT_SECRET = process.env.JWT_SECRET || "deniznegro-omgithastobe-verysecure";

const isPrivateOrLocalIp = (hostname) => {
  const normalizedHost = String(hostname || "").toLowerCase();
  if (!normalizedHost) return true;
  if (normalizedHost === "localhost") return true;

  const ipVersion = net.isIP(normalizedHost);
  if (!ipVersion) return false;

  if (ipVersion === 4) {
    if (normalizedHost.startsWith("10.")) return true;
    if (normalizedHost.startsWith("127.")) return true;
    if (normalizedHost.startsWith("192.168.")) return true;
    if (normalizedHost.startsWith("169.254.")) return true;

    if (normalizedHost.startsWith("172.")) {
      const octets = normalizedHost.split('.');
      const secondOctet = Number(octets[1]);
      if (Number.isFinite(secondOctet) && secondOctet >= 16 && secondOctet <= 31) {
        return true;
      }
    }

    return false;
  }

  // IPv6 local/private ranges
  if (normalizedHost === "::1") return true;
  if (normalizedHost.startsWith("fe80:")) return true; // link-local
  if (normalizedHost.startsWith("fc") || normalizedHost.startsWith("fd")) return true; // unique local

  return false;
};

const setProxyResponseHeaders = (sourceHeaders, res) => {
  const passThroughHeaders = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
    "content-disposition"
  ];

  passThroughHeaders.forEach((headerName) => {
    const value = sourceHeaders.get(headerName);
    if (value) {
      res.setHeader(headerName, value);
    }
  });

  res.setHeader("x-audio-proxy", "1");
};

export const proxyListeningAudio = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    const token = bearerToken || queryToken;

    if (!token) {
      return res.status(401).json({ error: "Missing token" });
    }

    try {
      jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }

    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawUrl) {
      return res.status(400).json({ error: "Missing audio URL" });
    }

    let targetUrl;
    try {
      targetUrl = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: "Invalid audio URL" });
    }

    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return res.status(400).json({ error: "Only HTTP(S) audio URLs are supported" });
    }

    if (isPrivateOrLocalIp(targetUrl.hostname)) {
      return res.status(400).json({ error: "Audio URL host is not allowed" });
    }

    const upstreamHeaders = {};
    const requestedRange = req.headers.range;
    if (requestedRange) {
      upstreamHeaders.Range = requestedRange;
    }

    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow"
    });

    if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
      return res.status(502).json({
        error: "Failed to fetch audio from source URL",
        upstreamStatus: upstreamResponse.status
      });
    }

    const contentType = upstreamResponse.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("audio/")) {
      return res.status(400).json({ error: "Provided URL did not return an audio resource" });
    }

    setProxyResponseHeaders(upstreamResponse.headers, res);
    res.status(upstreamResponse.status);

    if (!upstreamResponse.body) {
      return res.end();
    }

    Readable.fromWeb(upstreamResponse.body).pipe(res);
  } catch (err) {
    console.error("[proxyListeningAudio] Error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Audio proxy failed" });
    }
  }
};

// Upload passage image to Supabase Storage
export const uploadPassageImage = async (req, res) => {
  try {
    console.log('[uploadPassageImage] Request received');
    console.log('[uploadPassageImage] File:', req.file ? {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    } : 'NO FILE');
    
    if (!req.file) {
      console.error('[uploadPassageImage] No file in request');
      return res.status(400).json({ error: "No file uploaded" });
    }
    
    // Check if bucket exists, create if it doesn't
    const bucketName = 'uploads';
    const { data: buckets } = await supabase.storage.listBuckets();
    const bucketExists = buckets?.some(b => b.name === bucketName);
    
    if (!bucketExists) {
      console.log('[uploadPassageImage] Creating bucket:', bucketName);
      const { error: createError } = await supabase.storage.createBucket(bucketName, {
        public: true,
        fileSizeLimit: 10485760 // 10MB
      });
      if (createError) {
        console.error('[uploadPassageImage] Failed to create bucket:', createError);
        return res.status(500).json({ error: 'Storage not configured. Please contact administrator.' });
      }
    }
    
    const ext = req.file.originalname.split('.').pop();
    const filename = `reading/passages/${uuidv4()}.${ext}`;
    console.log('[uploadPassageImage] Uploading to:', filename);
    
    // Upload to Supabase Storage (bucket: 'uploads')
    const { data, error } = await supabase.storage.from("uploads").upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });
    
    if (error) {
      console.error('[uploadPassageImage] Supabase upload error:', error);
      throw error;
    }
    
    console.log('[uploadPassageImage] Upload successful:', data);
    
    // Get public URL
    const { data: publicUrlData } = supabase.storage.from("uploads").getPublicUrl(filename);
    console.log('[uploadPassageImage] Public URL:', publicUrlData.publicUrl);
    
    res.json({ url: publicUrlData.publicUrl });
  } catch (err) {
    console.error('[uploadPassageImage] Error:', err);
    res.status(500).json({ error: err.message });
  }
};

// Upload listening audio to Supabase Storage
export const uploadListeningAudio = async (req, res) => {
  try {
    console.log('[uploadListeningAudio] Request received');
    console.log('[uploadListeningAudio] File:', req.file ? {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    } : 'NO FILE');

    if (!req.file) {
      console.error('[uploadListeningAudio] No file in request');
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    if (req.file.size > MAX_AUDIO_UPLOAD_BYTES) {
      return res.status(400).json({ error: `Audio file is too large (max ${MAX_AUDIO_UPLOAD_MB}MB)` });
    }

    const allowedExtensions = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'webm'];
    const fileNameParts = req.file.originalname.split('.');
    const ext = (fileNameParts.pop() || '').toLowerCase();
    const isAudioMime = String(req.file.mimetype || '').toLowerCase().startsWith('audio/');
    const isAllowedExt = allowedExtensions.includes(ext);

    if (!isAudioMime && !isAllowedExt) {
      return res.status(400).json({ error: "Invalid audio format. Allowed: mp3, wav, ogg, m4a, aac, webm" });
    }

    // Check if bucket exists, create if it doesn't
    const bucketName = 'uploads';
    const { data: buckets } = await supabase.storage.listBuckets();
    const bucketExists = buckets?.some(b => b.name === bucketName);

    if (!bucketExists) {
      console.log('[uploadListeningAudio] Creating bucket:', bucketName);
      const { error: createError } = await supabase.storage.createBucket(bucketName, {
        public: true,
        fileSizeLimit: MAX_AUDIO_UPLOAD_BYTES
      });
      if (createError) {
        console.error('[uploadListeningAudio] Failed to create bucket:', createError);
        return res.status(500).json({ error: 'Storage not configured. Please contact administrator.' });
      }
    } else {
      const { error: updateBucketError } = await supabase.storage.updateBucket(bucketName, {
        public: true,
        fileSizeLimit: MAX_AUDIO_UPLOAD_BYTES,
      });
      if (updateBucketError) {
        console.warn('[uploadListeningAudio] Could not update bucket file size limit:', updateBucketError.message || updateBucketError);
      }
    }

    const safeExt = isAllowedExt ? ext : 'mp3';
    const filename = `listening/audio/${uuidv4()}.${safeExt}`;
    console.log('[uploadListeningAudio] Uploading to:', filename);

    const { data, error } = await supabase.storage.from('uploads').upload(filename, req.file.buffer, {
      contentType: req.file.mimetype || 'audio/mpeg',
      upsert: false
    });

    if (error) {
      console.error('[uploadListeningAudio] Supabase upload error:', error);
      throw error;
    }

    console.log('[uploadListeningAudio] Upload successful:', data);

    const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(filename);
    console.log('[uploadListeningAudio] Public URL:', publicUrlData.publicUrl);

    res.json({ url: publicUrlData.publicUrl });
  } catch (err) {
    console.error('[uploadListeningAudio] Error:', err);
    const message = String(err?.message || 'Upload failed');
    if (message.toLowerCase().includes('exceeded the maximum allowed size')) {
      return res.status(400).json({ error: `Audio file is too large (max ${MAX_AUDIO_UPLOAD_MB}MB)` });
    }
    res.status(500).json({ error: message });
  }
};

// Helper to check if string is a valid UUID
const isUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

// Normalize legacy and current matching style values to canonical values
const normalizeMatchingStyle = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('letter') ? 'letters' : 'roman';
};

const normalizeModulesConfig = (modulesConfig = {}) => {
  if (!modulesConfig || typeof modulesConfig !== 'object') return {};

  const readingQuestionGroups = Array.isArray(modulesConfig.reading_question_groups)
    ? modulesConfig.reading_question_groups.map((group) => {
        if (!group || typeof group !== 'object') return group;
        return {
          ...group,
          matching_style: normalizeMatchingStyle(group.matching_style),
        };
      })
    : modulesConfig.reading_question_groups;

  return {
    ...modulesConfig,
    reading_question_groups: readingQuestionGroups,
  };
};

export const saveExamStructure = async (req, res) => {
  const { id: examId } = req.params;
  const { exam, sections, questions, deletedQuestionIds, questionGroups, deletedGroupIds } = req.body;

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

    // 2. Soft delete removed questions (single batch operation)
    if (deletedQuestionIds?.length > 0) {
      await supabase.from("questions").update({ is_deleted: true }).in("id", deletedQuestionIds);
    }

    // 3. Process Sections - resolve stale temp IDs by module_type + section_order
    const { data: persistedSections, error: persistedSectionsError } = await supabase
      .from("exam_sections")
      .select("id, module_type, section_order")
      .eq("exam_id", examId);

    if (persistedSectionsError) {
      throw new Error(`Failed to load existing sections: ${persistedSectionsError.message}`);
    }

    const persistedSectionIdByComposite = new Map(
      (persistedSections || []).map(section => [
        `${section.module_type}:${Number(section.section_order)}`,
        section.id
      ])
    );

    const existingSections = [];
    const newSections = [];

    sections.forEach((section) => {
      const compositeKey = `${section.module_type}:${Number(section.section_order)}`;
      const resolvedExistingId = isUUID(section.id)
        ? section.id
        : persistedSectionIdByComposite.get(compositeKey);

      if (resolvedExistingId) {
        if (!isUUID(section.id)) {
          idMapping.sections[section.id] = resolvedExistingId;
        }
        existingSections.push({
          ...section,
          resolvedId: resolvedExistingId,
        });
      } else {
        newSections.push(section);
      }
    });

    // Batch update existing sections
    if (existingSections.length > 0) {
      const updatePromises = existingSections.map(async section => {
        const { data, error } = await supabase.from("exam_sections")
          .update({
            exam_id: examId,
            module_type: section.module_type,
            section_order: section.section_order,
            title: section.title,
            content: section.content,
            audio_url: section.audio_url,
            image_url: section.image_url || null,
            image_description: section.image_description || null,
            letter: section.letter || null,
            instruction: section.instruction || null,
            task_config: section.task_config || null
          })
          .eq("id", section.resolvedId)
          .select();
        
        return { data, error };
      });
      
      const updateResults = await Promise.all(updatePromises);
      
      // Check for any errors
      const failedUpdates = updateResults.filter(r => r.error);
      if (failedUpdates.length > 0) {
        console.error(`Failed to update ${failedUpdates.length} sections:`, failedUpdates[0].error);
        throw new Error(`Failed to update ${failedUpdates.length} sections: ${failedUpdates[0].error.message}`);
      }
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
          audio_url: section.audio_url,
          image_url: section.image_url || null,
          image_description: section.image_description || null,
          letter: section.letter || null,
          instruction: section.instruction || null,
          task_config: section.task_config || null
        }])
        .select()
        .single();
      if (error) {
        console.error(`Failed to insert section:`, error);
        throw new Error(`Failed to insert section: ${error.message}`);
      }
      if (newSection) {
        idMapping.sections[section.id] = newSection.id;
        const compositeKey = `${section.module_type}:${Number(section.section_order)}`;
        persistedSectionIdByComposite.set(compositeKey, newSection.id);
      }
    }

    // 4. NOW save question groups to modules_config with MAPPED section IDs and generate UUIDs for temp groups
    const modulesConfig = normalizeModulesConfig(exam.modules_config || {});
    const deletedGroupIdSet = new Set(Array.isArray(deletedGroupIds) ? deletedGroupIds : []);

    let normalizedQuestionGroups = Array.isArray(questionGroups)
      ? questionGroups.filter((group) => group && typeof group === "object")
      : [];

    if (deletedGroupIdSet.size > 0) {
      normalizedQuestionGroups = normalizedQuestionGroups.filter((group) => !deletedGroupIdSet.has(group.id));
    }

    normalizedQuestionGroups = normalizedQuestionGroups.map((group) => {
      if (group.id && group.id.toString().startsWith("temp_group_")) {
        const realGroupId = uuidv4();
        idMapping.groups[group.id] = realGroupId;
        return { ...group, id: realGroupId };
      }
      return group;
    });

    // Separate groups by module type based on their section
    const listeningSectionIds = sections
      .filter((section) => section.module_type === "listening")
      .map((section) => idMapping.sections[section.id] || section.id);
    const readingSectionIds = sections
      .filter((section) => section.module_type === "reading")
      .map((section) => idMapping.sections[section.id] || section.id);

    const listeningGroups = normalizedQuestionGroups.filter((group) => {
      const mappedSectionId = idMapping.sections[group.section_id] || group.section_id;
      return listeningSectionIds.includes(mappedSectionId);
    });

    const readingGroups = normalizedQuestionGroups.filter((group) => {
      const mappedSectionId = idMapping.sections[group.section_id] || group.section_id;
      return readingSectionIds.includes(mappedSectionId);
    });

    modulesConfig.listening_question_groups = listeningGroups.map((group) => {
      const mappedSectionId = idMapping.sections[group.section_id] || group.section_id;
      return {
        id: group.id,
        section_id: mappedSectionId,
        group_order: group.group_order || 1,
        question_type: group.question_type,
        question_range_start: group.question_range_start,
        question_range_end: group.question_range_end,
        instruction_text: group.instruction_text || null,
        table_title: group.table_title || null,
        table_data: group.table_data || null,
        max_words: group.max_words || null,
        max_numbers: group.max_numbers || null,
        answer_format: group.answer_format || "words_and_numbers",
        has_example: group.has_example || false,
        example_data: group.example_data || null,
        audio_start_time: group.audio_start_time || null,
        shared_options: group.shared_options || null,
        image_url: group.image_url || null,
        image_description: group.image_description || null,
        layout_type: group.layout_type || null,
        points_per_question: group.points_per_question || 1,
        case_sensitive: group.case_sensitive || false,
        spelling_tolerance: group.spelling_tolerance !== false,
        summary_data: group.summary_data || null,
        summary_title: group.summary_title || null,
      };
    });

    modulesConfig.reading_question_groups = readingGroups.map((group) => {
      const mappedSectionId = idMapping.sections[group.section_id] || group.section_id;
      return {
        id: group.id,
        section_id: mappedSectionId,
        group_order: group.group_order || 1,
        question_type: group.question_type,
        question_range_start: group.question_range_start,
        question_range_end: group.question_range_end,
        instruction_text: group.instruction_text || null,
        table_title: group.table_title || null,
        table_data: group.table_data || null,
        max_words: group.max_words || null,
        max_numbers: group.max_numbers || null,
        answer_format: group.answer_format || "words_and_numbers",
        has_example: group.has_example || false,
        example_data: group.example_data || null,
        example: group.example || null,
        headings_list: group.headings_list || null,
        people_list: group.people_list || null,
        matching_style: normalizeMatchingStyle(group.matching_style),
        shared_options: group.shared_options || null,
        image_url: group.image_url || null,
        image_description: group.image_description || null,
        layout_type: group.layout_type || null,
        points_per_question: group.points_per_question || 1,
        case_sensitive: group.case_sensitive || false,
        spelling_tolerance: group.spelling_tolerance !== false,
        summary_data: group.summary_data || null,
        summary_title: group.summary_title || null,
      };
    });

    // Auto-create question rows for summary_completion blanks (both listening and reading groups)
    const allGroups = [
      ...(modulesConfig.listening_question_groups || []),
      ...(modulesConfig.reading_question_groups || []),
    ];
    for (const group of allGroups) {
      if (group.question_type === "summary_completion" && group.summary_data?.text) {
        const blankCount = (group.summary_data.text.match(/\[BLANK\]/g) || []).length;
        const answersArr = group.summary_data.answers || [];
        for (let i = 0; i < blankCount; i++) {
          const qNum = group.question_range_start + i;
          // Check if question row already exists for this section + question_number
          const { data: existing } = await supabase
            .from("questions")
            .select("id")
            .eq("exam_id", examId)
            .eq("section_id", group.section_id)
            .eq("question_number", qNum)
            .limit(1);
          if (!existing || existing.length === 0) {
            const correctAnswer = answersArr[i] || "";
            // Parse alternatives if answer contains slash
            let mainAnswer = correctAnswer;
            let alternatives = null;
            if (typeof correctAnswer === "string" && correctAnswer.includes("/")) {
              const parts = correctAnswer.split("/").map((s) => s.trim()).filter(Boolean);
              mainAnswer = parts[0];
              alternatives = parts.slice(1);
            }
            await supabase.from("questions").insert([
              {
                exam_id: examId,
                section_id: group.section_id,
                question_number: qNum,
                question_text: `Summary completion blank ${i + 1}`,
                question_type: "summary_completion",
                correct_answer: mainAnswer,
                answer_alternatives: alternatives,
                points: 1,
                question_data: { group_id: group.id },
              },
            ]);
          }
        }
      }
    }

    // Persist modules_config (including listening audio settings) regardless of group count
    const { error: modulesConfigError } = await supabase
      .from("exams")
      .update({ modules_config: modulesConfig })
      .eq("id", examId);

    if (modulesConfigError) {
      throw new Error(`Failed to update modules config: ${modulesConfigError.message}`);
    }

    // 5. Process Questions - batch by new vs existing
    const mappedActiveGroups = normalizedQuestionGroups.map((group) => ({
      ...group,
      id: idMapping.groups[group.id] || group.id,
      section_id: idMapping.sections[group.section_id] || group.section_id,
    }));

    const groupTypeById = new Map();
    const groupsBySection = new Map();
    mappedActiveGroups.forEach((group) => {
      if (!group?.id || !group?.question_type) return;
      groupTypeById.set(group.id, group.question_type);

      if (!groupsBySection.has(group.section_id)) {
        groupsBySection.set(group.section_id, []);
      }
      groupsBySection.get(group.section_id).push(group);
    });

    groupsBySection.forEach((sectionGroups, sectionId) => {
      groupsBySection.set(
        sectionId,
        [...sectionGroups].sort((a, b) => {
          const orderA = Number(a.group_order || 0);
          const orderB = Number(b.group_order || 0);
          if (orderA !== orderB) return orderA - orderB;
          const startA = Number(a.question_range_start || 0);
          const startB = Number(b.question_range_start || 0);
          return startA - startB;
        })
      );
    });

    const mappedDeletedGroupIds = new Set(
      Array.from(deletedGroupIdSet).map((groupId) => idMapping.groups[groupId] || groupId)
    );

    const mappedQuestions = questions.map(q => {
      const mappedSectionId = idMapping.sections[q.section_id] || q.section_id;
      const mappedGroupId = idMapping.groups[q.group_id] || q.group_id || null;

      let resolvedGroupId = mappedGroupId;
      if (!resolvedGroupId || !groupTypeById.has(resolvedGroupId)) {
        const sectionGroups = groupsBySection.get(mappedSectionId) || [];
        const questionNumber = Number(q.question_number || 0);
        const matchingGroups = sectionGroups.filter((group) => {
          const start = Number(group.question_range_start);
          const end = Number(group.question_range_end);
          if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
          return questionNumber >= start && questionNumber <= end;
        });

        if (matchingGroups.length === 1) {
          resolvedGroupId = matchingGroups[0].id;
        } else if (matchingGroups.length > 1) {
          const explicitType = String(q.question_type || q.type || '').toLowerCase();
          const typeMatch = explicitType
            ? matchingGroups.find((group) => String(group.question_type || '').toLowerCase() === explicitType)
            : null;
          resolvedGroupId = (typeMatch || matchingGroups[0]).id;
        }
      }

      const {
        id, section_id, question_text, question_type, correct_answer, points, question_number,
        exam_id, created_at, is_deleted,
        // Form/table completion fields
        is_info_row, row_order, label_text, info_text, question_template, answer_alternatives,
        // Options for multiple choice (stored in question_data)
        option_a, option_b, option_c, option_d, option_e, option_f, option_g, option_h,
        // Group tracking
        group_id,
        // Reading passage linkage (not used - remove from payload)
        passage_letter,
        ...extraFields
      } = q;
      const resolvedQuestionType = (resolvedGroupId && groupTypeById.get(resolvedGroupId))
        || question_type
        || q.type
        || 'multiple_choice';
      return {
        originalId: id,
        isNew: !isUUID(id),
        payload: {
          exam_id: examId,
          section_id: mappedSectionId,
          question_text: question_text || q.text || '',
          question_type: resolvedQuestionType,
          correct_answer: correct_answer || q.answer || '',
          points: points || 1,
          question_number: question_number || 0,
          // Form/table completion fields
          is_info_row: is_info_row || false,
          row_order: row_order || null,
          label_text: label_text || null,
          info_text: info_text || null,
          question_template: question_template || null,
          answer_alternatives: answer_alternatives 
            ? (typeof answer_alternatives === 'string' 
                ? answer_alternatives.split('/').map(s => s.trim()).filter(Boolean) 
                : answer_alternatives)
            : null,
          // Store options and group_id in question_data (option columns don't exist in DB)
          question_data: { 
            ...extraFields, 
            group_id: resolvedGroupId,
            option_a: option_a || null,
            option_b: option_b || null,
            option_c: option_c || null,
            option_d: option_d || null,
            option_e: option_e || null,
            option_f: option_f || null,
            option_g: option_g || null,
            option_h: option_h || null
          }
        }
      };
    }).filter((question) => {
      const groupId = question?.payload?.question_data?.group_id;
      if (!groupId) return true;
      return !mappedDeletedGroupIds.has(groupId);
    });

    const existingQuestions = mappedQuestions.filter(q => !q.isNew);
    const newQuestions = mappedQuestions.filter(q => q.isNew);

    // Batch update existing questions (parallel)
    if (existingQuestions.length > 0) {
      const updateResults = await Promise.all(existingQuestions.map(async q => {
        const { data, error } = await supabase.from("questions").update(q.payload).eq("id", q.originalId).select();
        if (error) {
          console.error(`Failed to update question ${q.originalId}:`, error);
        }
        return { data, error };
      }));
      
      const failedQuestions = updateResults.filter(r => r.error);
      if (failedQuestions.length > 0) {
        console.error(`${failedQuestions.length} question updates failed`);
        warnings.push(`Failed to update ${failedQuestions.length} questions`);
      }
    }

    // Batch insert new questions
    if (newQuestions.length > 0) {
      const { data: insertedQuestions, error: insertError } = await supabase
        .from("questions")
        .insert(newQuestions.map(q => q.payload))
        .select();
      
      if (insertError) {
        console.error(`Insert error:`, insertError);
        warnings.push(`Failed to insert ${newQuestions.length} questions: ${insertError.message}`);
      }
      
      if (insertedQuestions) {
        // Map old IDs to new IDs (by matching on question_number + section_id)
        insertedQuestions.forEach((inserted, idx) => {
          if (newQuestions[idx]) {
            idMapping.questions[newQuestions[idx].originalId] = inserted.id;
          }
        });
      }
    }

    // 6. Update task_config for listening sections (store groups there too as backup)
    const listeningSections = sections.filter(s => s.module_type === 'listening');
    if (listeningSections.length > 0) {
      await Promise.all(listeningSections.map(async section => {
        const realSectionId = idMapping.sections[section.id] || section.id;
        const sectionGroups = normalizedQuestionGroups.filter(g => 
          g.section_id === section.id || g.section_id === realSectionId
        );

        let existingTaskConfig = {};
        if (section.task_config) {
          try {
            existingTaskConfig = typeof section.task_config === 'string'
              ? JSON.parse(section.task_config)
              : section.task_config;
          } catch {
            existingTaskConfig = {};
          }
        }

        const groupsConfig = {
          ...existingTaskConfig,
          question_groups: sectionGroups.map(g => ({
            ...g,
            section_id: realSectionId
          }))
        };

        const { error: taskConfigError } = await supabase
          .from("exam_sections")
          .update({ task_config: JSON.stringify(groupsConfig) })
          .eq("id", realSectionId);

        if (taskConfigError) {
          warnings.push(`Failed to sync listening task config for section ${realSectionId}: ${taskConfigError.message}`);
        }
      }));
    }

    res.json({ message: "Exam saved", idMapping, warnings: warnings.length > 0 ? warnings : undefined });
  } catch (err) {
    console.error("Save error:", err);
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
          modules_config: normalizeModulesConfig(modules_config || {}),
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

    const normalizedModulesConfig = normalizeModulesConfig(exam.modules_config || {});
    const shouldPersistNormalizedModules = JSON.stringify(normalizedModulesConfig) !== JSON.stringify(exam.modules_config || {});

    if (shouldPersistNormalizedModules) {
      const { error: normalizeError } = await supabase
        .from("exams")
        .update({ modules_config: normalizedModulesConfig })
        .eq("id", id);

      if (normalizeError) {
        console.warn("[getExam] Failed to persist normalized modules_config:", normalizeError.message);
      }
    }

    exam.modules_config = normalizedModulesConfig;

    const normalizeGroupSectionIds = (groups = [], mergedQuestionList = [], sectionList = []) => {
      if (!Array.isArray(groups) || groups.length === 0) return [];

      const validSectionIds = new Set((sectionList || []).map(section => section.id));
      const sectionByGroupIdCounts = new Map();

      (mergedQuestionList || []).forEach((question) => {
        const groupId = question?.group_id;
        const sectionId = question?.section_id;
        if (!groupId || !sectionId || !validSectionIds.has(sectionId)) return;

        if (!sectionByGroupIdCounts.has(groupId)) {
          sectionByGroupIdCounts.set(groupId, new Map());
        }

        const countMap = sectionByGroupIdCounts.get(groupId);
        countMap.set(sectionId, (countMap.get(sectionId) || 0) + 1);
      });

      const normalizedGroups = groups.map((group) => {
        if (!group || typeof group !== 'object') return group;
        if (group.section_id && validSectionIds.has(group.section_id)) return group;

        if (group.id && sectionByGroupIdCounts.has(group.id)) {
          const sectionCounts = sectionByGroupIdCounts.get(group.id);
          const bestMatch = Array.from(sectionCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
          if (bestMatch) {
            return { ...group, section_id: bestMatch };
          }
        }

        return group;
      });

      return normalizedGroups;
    };

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

    // Fetch questions (exclude deleted; NULL is treated as not-deleted)
    const { data: questions, error: questionsError } = await supabase
      .from("questions")
      .select("*")
      .eq("exam_id", id)
      .or("is_deleted.eq.false,is_deleted.is.null")
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

        // Fetch question groups for both listening and reading sections
        let questionGroups = [];
        
        // Listening groups
        const listeningSections = sections?.filter(s => s.module_type === 'listening') || [];
        const listeningSectionIds = listeningSections.map(s => s.id);
        
        if (listeningSectionIds.length > 0) {
          // Source 1: dedicated table
          const { data: tableGroups, error: groupsError } = await supabase
            .from("listening_question_groups")
            .select("*")
            .in("section_id", listeningSectionIds)
            .order("group_order", { ascending: true });

          if (!groupsError && tableGroups?.length > 0) {
            questionGroups.push(...tableGroups);
          }

          // Source 2: section task_config
          for (const sec of listeningSections) {
            if (sec.task_config) {
              try {
                const config = typeof sec.task_config === 'string' ? JSON.parse(sec.task_config) : sec.task_config;
                if (Array.isArray(config.question_groups)) {
                  questionGroups.push(...config.question_groups);
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          }

          // Source 3: exam modules_config
          if (Array.isArray(exam.modules_config?.listening_question_groups)) {
            questionGroups.push(
              ...exam.modules_config.listening_question_groups.filter(g => listeningSectionIds.includes(g.section_id))
            );
          }
        }
        
        // Reading groups
        const readingSections = sections?.filter(s => s.module_type === 'reading') || [];
        const readingSectionIds = readingSections.map(s => s.id);
        
        if (readingSectionIds.length > 0) {
          // Reading groups are stored in modules_config
          if (Array.isArray(exam.modules_config?.reading_question_groups)) {
            questionGroups.push(
              ...exam.modules_config.reading_question_groups.filter(g => readingSectionIds.includes(g.section_id))
            );
          }
        }
        
        // Deduplicate groups by ID (fallback key for legacy groups without id)
        const uniqueGroups = Array.from(
          new Map(
            questionGroups
              .filter(Boolean)
              .map(g => {
                const fallbackKey = `${g.section_id || 'section'}:${g.question_type || 'type'}:${g.question_range_start || 'start'}:${g.question_range_end || 'end'}`;
                return [g.id || fallbackKey, g];
              })
          ).values()
        );

        const normalizedGroups = normalizeGroupSectionIds(uniqueGroups, mergedFallback, sections || []);

        return res.json({ ...exam, sections, questions: sanitizedFallback || [], questionGroups: normalizedGroups });
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

    // Fetch question groups for both listening and reading sections
    let questionGroups = [];
    
    // Listening groups
    const listeningSections = sections?.filter(s => s.module_type === 'listening') || [];
    const listeningSectionIds = listeningSections.map(s => s.id);
    
    if (listeningSectionIds.length > 0) {
      // Source 1: dedicated table
      const { data: tableGroups, error: groupsError } = await supabase
        .from("listening_question_groups")
        .select("*")
        .in("section_id", listeningSectionIds)
        .order("group_order", { ascending: true });

      if (!groupsError && tableGroups?.length > 0) {
        questionGroups.push(...tableGroups);
      }

      // Source 2: section task_config
      for (const sec of listeningSections) {
        if (sec.task_config) {
          try {
            const config = typeof sec.task_config === 'string' ? JSON.parse(sec.task_config) : sec.task_config;
            if (Array.isArray(config.question_groups)) {
              questionGroups.push(...config.question_groups);
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }

      // Source 3: exam modules_config
      if (Array.isArray(exam.modules_config?.listening_question_groups)) {
        questionGroups.push(
          ...exam.modules_config.listening_question_groups.filter(g => listeningSectionIds.includes(g.section_id))
        );
      }
    }
    
    // Reading groups
    const readingSections = sections?.filter(s => s.module_type === 'reading') || [];
    const readingSectionIds = readingSections.map(s => s.id);
    
    if (readingSectionIds.length > 0) {
      // Reading groups are stored in modules_config
      if (Array.isArray(exam.modules_config?.reading_question_groups)) {
        questionGroups.push(
          ...exam.modules_config.reading_question_groups.filter(g => readingSectionIds.includes(g.section_id))
        );
      }
    }

    // Deduplicate groups by ID (fallback key for legacy groups without id)
    const uniqueGroups = Array.from(
      new Map(
        questionGroups
          .filter(Boolean)
          .map(g => {
            const fallbackKey = `${g.section_id || 'section'}:${g.question_type || 'type'}:${g.question_range_start || 'start'}:${g.question_range_end || 'end'}`;
            return [g.id || fallbackKey, g];
          })
      ).values()
    );

    const normalizedGroups = normalizeGroupSectionIds(uniqueGroups, mergedQuestions, sections || []);

    res.json({ ...exam, sections, questions: sanitizedQuestions, questionGroups: normalizedGroups });
  } catch (err) {
    console.error(`Get exam error:`, err);
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
    const submittedAnswers = answers && typeof answers === 'object' ? answers : {};

    // Merge latest autosave into final payload so no recent answers are lost
    const { data: autosaveData, error: autosaveError } = await supabase
      .from("exam_autosaves")
      .select("answers_data, time_spent, last_updated")
      .eq("exam_id", examId)
      .eq("user_id", userId)
      .maybeSingle();

    if (autosaveError && autosaveError.code !== 'PGRST116') {
      throw autosaveError;
    }

    const autosaveAnswers = autosaveData?.answers_data && typeof autosaveData.answers_data === 'object'
      ? autosaveData.answers_data
      : {};

    const mergedFinalAnswers = {
      ...autosaveAnswers,
      ...submittedAnswers
    };

    const submittedTimeSpent = time_spent_by_module && typeof time_spent_by_module === 'object'
      ? time_spent_by_module
      : {};
    const autosaveTimeSpent = autosaveData?.time_spent && typeof autosaveData.time_spent === 'object'
      ? autosaveData.time_spent
      : {};

    const normalizedTimeSpentByModule = {
      listening: Number(submittedTimeSpent.listening ?? autosaveTimeSpent.listening ?? 0) || 0,
      reading: Number(submittedTimeSpent.reading ?? autosaveTimeSpent.reading ?? 0) || 0,
      writing: Number(
        submittedTimeSpent.writing ?? (
          Number(autosaveTimeSpent.writing_task1 || 0) + Number(autosaveTimeSpent.writing_task2 || 0)
        ) ?? 0
      ) || 0
    };

    const totalTimeSpent = Object.values(normalizedTimeSpentByModule)
      .reduce((sum, value) => sum + (Number(value) || 0), 0);

    // Check if already submitted
    const { data: existing, error: existingError } = await supabase
      .from("exam_submissions")
      .select("id")
      .eq("exam_id", examId)
      .eq("user_id", userId)
      .single();
    
    if (existingError && existingError.code !== 'PGRST116') {
      // PGRST116 = not found (expected), other errors are real problems
      console.error('Error checking existing submission:', existingError);
      throw existingError;
    }

    // If already submitted, allow update (for resubmission case)
    const isUpdate = !!existing;

    // Fetch questions with section info to grade - include question_data for group_id
    const { data: questions, error: questionsError } = await supabase
      .from("questions")
      .select(`
        id, 
        correct_answer, 
        answer_alternatives, 
        points,
        question_number,
        question_type,
        question_data,
        exam_sections!inner (
          id,
          module_type,
          title
        )
      `)
      .eq("exam_id", examId)
      .neq("is_deleted", true);
    
    if (questionsError) {
      console.error('Error fetching questions:', questionsError);
      throw questionsError;
    }
    
    if (!questions || questions.length === 0) {
      return res.status(400).json({ error: "No questions found for this exam" });
    }

    // Remap synthetic placeholder IDs to real question IDs
    // Frontend uses keys like "summary_placeholder_<groupId>_<index>" for summary_completion blanks
    const remappedAnswers = { ...mergedFinalAnswers };
    const placeholderKeys = Object.keys(remappedAnswers).filter(k => k.startsWith('summary_placeholder_'));
    if (placeholderKeys.length > 0) {
      // Load question groups to map placeholder index to question_number
      const { data: exam } = await supabase.from("exams").select("modules_config").eq("id", examId).single();
      const allGroups = [
        ...(exam?.modules_config?.listening_question_groups || []),
        ...(exam?.modules_config?.reading_question_groups || [])
      ];
      
      for (const key of placeholderKeys) {
        // Parse "summary_placeholder_<groupId>_<index>"
        const parts = key.replace('summary_placeholder_', '').split('_');
        const blankIndex = parseInt(parts.pop(), 10);
        const groupId = parts.join('_'); // rejoin in case UUID has underscores (it uses hyphens, but be safe)
        
        const group = allGroups.find(g => g.id === groupId);
        if (group) {
          const qNum = group.question_range_start + blankIndex;
          const realQuestion = questions.find(q => 
            q.exam_sections?.id === group.section_id && q.question_number === qNum
          );
          if (realQuestion) {
            remappedAnswers[realQuestion.id] = remappedAnswers[key];
            delete remappedAnswers[key];
          }
        }
      }
    }

    let totalScore = 0;
    let totalPoints = 0;
    const gradedAnswers = [];
    const moduleScores = {
      listening: { correct: 0, total: 0 },
      reading: { correct: 0, total: 0 },
      writing: { correct: 0, total: 0 }
    };

    // Helper: normalize multi-select answers to sorted uppercase letters
    const normalizeMultiAnswer = (val) => {
      if (!val) return '';
      const str = String(val).trim().toUpperCase();
      // If slash-separated (e.g. "A/C/D"), split on slashes
      if (str.includes('/')) {
        return str.split('/').map(s => s.trim()).filter(Boolean).sort().join(',');
      }
      // If just concatenated letters (e.g. "ACD"), split each char
      if (/^[A-Z]+$/.test(str)) {
        return str.split('').sort().join(',');
      }
      return str.toLowerCase();
    };

    // Helper: parse multi-select answer into array of letters
    const parseMultiAnswerArray = (val) => {
      if (!val) return [];
      const str = String(val).trim().toUpperCase();
      if (str.includes('/')) {
        return str.split('/').map(s => s.trim()).filter(Boolean);
      }
      if (str.includes(',')) {
        return str.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (/^[A-Z]+$/.test(str)) {
        return str.split('');
      }
      return [str];
    };

    questions.forEach(q => {
      try {
        const userAns = remappedAnswers[q.id];
        const moduleType = q.exam_sections?.module_type || 'unknown';
        const qType = q.question_type || '';
        let isCorrect = false;
        let score = 0;
        let pointsForQuestion = q.points || 1;

        if (userAns !== undefined && userAns !== null && userAns !== '') {
          // For multiple choice multiple, count each correct answer separately
          if (qType === 'multiple_choice_multiple') {
            const userSelections = parseMultiAnswerArray(userAns);
            const correctAnswers = parseMultiAnswerArray(q.correct_answer);
            
            // Award 1 point per correct selection
            const correctCount = userSelections.filter(sel => correctAnswers.includes(sel)).length;
            score = correctCount;
            
            // Consider fully correct if all user selections are correct AND they got all of them
            isCorrect = (correctCount === correctAnswers.length && userSelections.length === correctAnswers.length);
            
            // The question is worth N points where N = number of correct answers
            pointsForQuestion = correctAnswers.length;
          } else {
            const userAnswerLower = String(userAns).trim().toLowerCase();
            const correctAnswerLower = q.correct_answer ? String(q.correct_answer).trim().toLowerCase() : '';
            
            // Check main correct answer
            if (correctAnswerLower && userAnswerLower === correctAnswerLower) {
              isCorrect = true;
              score = q.points || 1;
            }
            
            // Check alternative answers if provided
            if (!isCorrect && q.answer_alternatives) {
              let alternatives = q.answer_alternatives;
              // Handle both string and array formats
              if (typeof alternatives === 'string') {
                alternatives = alternatives.split('/').map(s => s.trim()).filter(Boolean);
              }
              if (Array.isArray(alternatives)) {
                for (const alt of alternatives) {
                  if (alt && userAnswerLower === String(alt).trim().toLowerCase()) {
                    isCorrect = true;
                    score = q.points || 1;
                    break;
                  }
                }
              }
            }
          }
        }

        totalScore += score;
        totalPoints += pointsForQuestion;

        // Track module-wise scores
        if (moduleType && moduleScores[moduleType]) {
          moduleScores[moduleType].total += pointsForQuestion;
          if (score > 0) {
            moduleScores[moduleType].correct += score;
          }
        }

        gradedAnswers.push({
          question_id: q.id,
          question_number: q.question_number,
          section_id: q.exam_sections?.id || null,
          section_title: q.exam_sections?.title || 'Unknown Section',
          module_type: moduleType,
          user_answer: userAns,
          correct_answer: q.correct_answer,
          is_correct: isCorrect,
          score
        });
      } catch (err) {
        console.error(`Error grading question ${q.id}:`, err);
        // Continue processing other questions
      }
    });

    // Calculate band scores for each module
    const scoresByModule = {};
    Object.keys(moduleScores).forEach(module => {
      if (moduleScores[module].total > 0) {
        const percentage = (moduleScores[module].correct / moduleScores[module].total);
        scoresByModule[module] = Math.round(percentage * 9 * 2) / 2; // Round to nearest 0.5
      } else {
        scoresByModule[module] = 0;
      }
    });

    const overallBand = totalPoints > 0 ? (totalScore / totalPoints) * 9 : 0;
    const roundedBand = Math.round(overallBand * 2) / 2; // Round to nearest 0.5

    // Create or update submission
    let submission;
    if (isUpdate) {
      // Update existing submission
      const { data: updatedSubmission, error: updateError } = await supabase
        .from("exam_submissions")
        .update({
          answers: remappedAnswers,
          scores_by_module: scoresByModule, 
          band_score: roundedBand,
          overall_band_score: roundedBand,
          total_correct: totalScore,
          total_questions: questions.length,
          time_spent: totalTimeSpent,
          time_spent_by_module: normalizedTimeSpentByModule,
          status: "submitted",
          submitted_at: new Date(),
        })
        .eq("id", existing.id)
        .select()
        .single();
      
      if (updateError) {
        console.error('Error updating submission:', updateError);
        throw updateError;
      }
      submission = updatedSubmission;
      
      // Delete old answers
      const { error: deleteError } = await supabase
        .from("answers")
        .delete()
        .eq("submission_id", existing.id);
      
      if (deleteError) {
        console.error('Error deleting old answers:', deleteError);
        // Continue anyway - new answers will be inserted
      }
    } else {
      // Create new submission
      const { data: newSubmission, error: insertError } = await supabase
        .from("exam_submissions")
        .insert([
          {
            user_id: userId,
            exam_id: examId,
            answers: remappedAnswers,
            scores_by_module: scoresByModule, 
            band_score: roundedBand,
            overall_band_score: roundedBand,
            total_correct: totalScore,
            total_questions: questions.length,
            time_spent: totalTimeSpent,
            time_spent_by_module: normalizedTimeSpentByModule,
            status: "submitted",
            submitted_at: new Date(),
          },
        ])
        .select()
        .single();
      
      if (insertError) {
        console.error('Error inserting submission:', insertError);
        throw insertError;
      }
      submission = newSubmission;
    }

    // Store answers with detailed info
    const answerRecords = gradedAnswers.map(a => ({
      submission_id: submission.id,
      question_id: a.question_id,
      user_answer: a.user_answer,
      is_correct: a.is_correct,
      score: a.score
    }));

    if (answerRecords.length > 0) {
      const { error: ansError } = await supabase
        .from("answers")
        .insert(answerRecords);

      if (ansError) {
        console.error('Error inserting answers (attempt 1):', ansError);

        const { error: retryAnsError } = await supabase
          .from("answers")
          .insert(answerRecords);

        if (retryAnsError) {
          console.error('Error inserting answers (attempt 2, non-fatal):', retryAnsError);
        }
      }
    }

    // Save writing essays to writing_responses table
    try {
      // Find writing_task_* keys in submitted answers
      const writingKeys = Object.keys(remappedAnswers).filter(k => k.startsWith('writing_task_'));
      if (writingKeys.length > 0) {
        // Get writing sections for this exam
        const { data: writingSections } = await supabase
          .from('exam_sections')
          .select('id, section_order, task_config, title')
          .eq('exam_id', examId)
          .eq('module_type', 'writing')
          .order('section_order', { ascending: true });

        for (const key of writingKeys) {
          const taskNumber = parseInt(key.replace('writing_task_', ''), 10);
          const essayText = remappedAnswers[key];
          if (!essayText || typeof essayText !== 'string' || essayText.trim().length === 0) continue;

          // Match to writing section by task number (section_order or index)
          const section = writingSections?.find((s, idx) => (idx + 1) === taskNumber) || writingSections?.[taskNumber - 1];
          const sectionId = section?.id || null;
          const wordCount = essayText.trim().split(/\s+/).length;

          // Check if writing_response already exists
          const { data: existing } = await supabase
            .from('writing_responses')
            .select('id')
            .eq('submission_id', submission.id)
            .eq('task_number', taskNumber)
            .single();

          const writeData = {
            submission_id: submission.id,
            section_id: sectionId,
            task_number: taskNumber,
            response_text: essayText,
            word_count: wordCount,
          };

          if (existing) {
            await supabase.from('writing_responses').update(writeData).eq('id', existing.id);
          } else {
            await supabase.from('writing_responses').insert([writeData]);
          }
        }
      }
    } catch (writingErr) {
      console.error('Error saving writing responses (non-fatal):', writingErr);
      // Non-fatal - don't fail submission for this
    }

    // Clean up autosave draft after successful submission
    try {
      await supabase
        .from("exam_autosaves")
        .delete()
        .eq("exam_id", examId)
        .eq("user_id", userId);
    } catch (autosaveCleanupErr) {
      console.error('Error cleaning autosave draft (non-fatal):', autosaveCleanupErr);
    }

    res.json({ 
      message: "Exam submitted successfully", 
      score: roundedBand,
      scores_by_module: scoresByModule,
      submission_id: submission.id
    });

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
    console.error("Update access code error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Verify exam code for student join
export const verifyExamCode = async (req, res) => {
  const { code } = req.body;
  const userId = req.user.id;

  if (!code || code.length < 4) {
    return res.status(400).json({ error: "Invalid exam code" });
  }

  try {
    // Find exam by access code
    const { data: exam, error: examError } = await supabase
      .from("exams")
      .select("id, title, status, duration_minutes")
      .eq("access_code", code.toUpperCase())
      .single();

    if (examError || !exam) {
      return res.status(404).json({ error: "Invalid exam code or exam not found" });
    }

    if (exam.status !== "active") {
      return res.status(403).json({ error: "This exam is not currently active" });
    }

    // Log student joining
    await supabase
      .from("monitoring_logs")
      .insert([{
        exam_id: exam.id,
        user_id: userId,
        event_type: "joined",
        metadata: { code_used: code.toUpperCase() }
      }]);

    res.json({ 
      examId: exam.id, 
      title: exam.title,
      duration: exam.duration_minutes 
    });
  } catch (err) {
    console.error("Verify exam code error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Auto-save student answers during exam
export const autosaveAnswers = async (req, res) => {
  const { id: examId } = req.params;
  const userId = req.user.id;
  const { answers, module, timestamp, currentPart, currentWritingTask, timeSpent } = req.body;
  const parsedIncomingTimestamp = new Date(timestamp || new Date().toISOString());
  const incomingTimestamp = Number.isNaN(parsedIncomingTimestamp.getTime())
    ? new Date().toISOString()
    : parsedIncomingTimestamp.toISOString();

  try {
    const { data: existingSubmission, error: submissionCheckError } = await supabase
      .from("exam_submissions")
      .select("id, status")
      .eq("exam_id", examId)
      .eq("user_id", userId)
      .maybeSingle();

    if (submissionCheckError && submissionCheckError.code !== 'PGRST116') {
      throw submissionCheckError;
    }

    if (existingSubmission?.status === "submitted" || existingSubmission?.status === "auto_submitted") {
      return res.status(409).json({ error: "Exam already submitted. Autosave is locked." });
    }

    const { data: existingAutosave, error: existingAutosaveError } = await supabase
      .from("exam_autosaves")
      .select("id, last_updated")
      .eq("exam_id", examId)
      .eq("user_id", userId)
      .maybeSingle();

    if (existingAutosaveError && existingAutosaveError.code !== 'PGRST116') {
      throw existingAutosaveError;
    }

    if (existingAutosave?.last_updated) {
      const existingTimestamp = new Date(existingAutosave.last_updated).getTime();
      const candidateTimestamp = new Date(incomingTimestamp).getTime();
      if (!Number.isNaN(existingTimestamp) && candidateTimestamp <= existingTimestamp) {
        return res.json({
          message: "Ignored stale autosave",
          timestamp: existingAutosave.last_updated,
          ignored: true
        });
      }
    }

    const autosavePayload = {
      exam_id: examId,
      user_id: userId,
      answers_data: answers,
      current_module: module,
      current_part: currentPart,
      current_writing_task: currentWritingTask,
      time_spent: timeSpent,
      last_updated: incomingTimestamp
    };

    if (existingAutosave?.id) {
      const { data: updatedAutosave, error: updateError } = await supabase
        .from("exam_autosaves")
        .update(autosavePayload)
        .eq("id", existingAutosave.id)
        .lte("last_updated", incomingTimestamp)
        .select("id, last_updated")
        .maybeSingle();

      if (updateError && updateError.code !== 'PGRST116') throw updateError;

      if (!updatedAutosave) {
        return res.json({
          message: "Ignored stale autosave",
          timestamp: incomingTimestamp,
          ignored: true
        });
      }
    } else {
      const { error: insertError } = await supabase
        .from("exam_autosaves")
        .insert([autosavePayload]);

      if (insertError) {
        if (insertError.code === '23505') {
          const { data: retriedAutosave, error: retryUpdateError } = await supabase
            .from("exam_autosaves")
            .update(autosavePayload)
            .eq("exam_id", examId)
            .eq("user_id", userId)
            .lte("last_updated", incomingTimestamp)
            .select("id, last_updated")
            .maybeSingle();

          if (retryUpdateError && retryUpdateError.code !== 'PGRST116') throw retryUpdateError;

          if (!retriedAutosave) {
            return res.json({
              message: "Ignored stale autosave",
              timestamp: incomingTimestamp,
              ignored: true
            });
          }
        } else {
          throw insertError;
        }
      }
    }

    res.json({ message: "Autosaved", timestamp: incomingTimestamp });
  } catch (err) {
    console.error("Autosave error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Log exam events (start, module completion, etc.)
export const logExamEvent = async (req, res) => {
  const { id: examId } = req.params;
  const userId = req.user.id;
  const { event_type, metadata } = req.body;

  try {
    await supabase
      .from("monitoring_logs")
      .insert([{
        exam_id: examId,
        user_id: userId,
        event_type,
        metadata: metadata || {},
        timestamp: new Date().toISOString()
      }]);

    res.json({ message: "Logged" });
  } catch (err) {
    console.error("Log event error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Check if user has already submitted this exam
export const checkExamStatus = async (req, res) => {
  const { id: examId } = req.params;
  const userId = req.user.id;

  try {
    // Check for existing submission
    const { data: submission, error: submissionError } = await supabase
      .from("exam_submissions")
      .select('id, submitted_at')
      .eq('exam_id', examId)
      .eq('user_id', userId)
      .maybeSingle();

    if (submissionError) throw submissionError;

    // Check for autosave data
    const { data: autosave, error: autosaveError } = await supabase
      .from("exam_autosaves")
      .select('*')
      .eq('exam_id', examId)
      .eq('user_id', userId)
      .maybeSingle();

    if (autosaveError && autosaveError.code !== 'PGRST116') throw autosaveError;

    res.json({
      submitted: !!submission,
      submission_id: submission?.id,
      submitted_at: submission?.submitted_at,
      has_autosave: !!autosave,
      autosave: autosave || null
    });
  } catch (err) {
    console.error("Check exam status error:", err);
    res.status(500).json({ error: err.message });
  }
};
