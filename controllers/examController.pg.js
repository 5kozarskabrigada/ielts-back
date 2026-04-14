import { pool, queryWithRetry } from "../db.js";
import { supabase } from "../supabaseClient.js"; // kept ONLY for Storage uploads
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import net from "net";
import { Readable } from "stream";

const MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_UPLOAD_MB = 50;
const JWT_SECRET = process.env.JWT_SECRET || "deniznegro-omgithastobe-verysecure";

// ──────────────────────────────────────────────
// Helpers (no DB calls — copied verbatim)
// ──────────────────────────────────────────────

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
      if (Number.isFinite(secondOctet) && secondOctet >= 16 && secondOctet <= 31) return true;
    }
    return false;
  }
  if (normalizedHost === "::1") return true;
  if (normalizedHost.startsWith("fe80:")) return true;
  if (normalizedHost.startsWith("fc") || normalizedHost.startsWith("fd")) return true;
  return false;
};

const setProxyResponseHeaders = (sourceHeaders, res) => {
  ["content-type","content-length","content-range","accept-ranges","etag","last-modified","content-disposition"]
    .forEach((h) => { const v = sourceHeaders.get(h); if (v) res.setHeader(h, v); });
  // Allow range requests for audio seeking
  if (!sourceHeaders.get("accept-ranges")) res.setHeader("accept-ranges", "bytes");
  // Cache audio files for 1 hour to avoid re-proxying on every request
  res.setHeader("cache-control", "private, max-age=3600, immutable");
  res.setHeader("x-audio-proxy", "1");
};

const isUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

// Safely serialize task_config — avoids double-stringifying if already a string
const serializeTaskConfig = (val) => {
  if (!val) return null;
  if (typeof val === 'string') return val;   // already JSON string from frontend
  return JSON.stringify(val);                // object → JSON string
};

const normalizeMatchingStyle = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('letter') ? 'letters' : 'roman';
};

const normalizeModulesConfig = (modulesConfig = {}) => {
  if (!modulesConfig || typeof modulesConfig !== 'object') return {};
  const readingQuestionGroups = Array.isArray(modulesConfig.reading_question_groups)
    ? modulesConfig.reading_question_groups.map((group) => {
        if (!group || typeof group !== 'object') return group;
        return { ...group, matching_style: normalizeMatchingStyle(group.matching_style) };
      })
    : modulesConfig.reading_question_groups;
  return { ...modulesConfig, reading_question_groups: readingQuestionGroups };
};

// ──────────────────────────────────────────────
// Audio proxy — no DB calls
// ──────────────────────────────────────────────

export const proxyListeningAudio = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    const token = bearerToken || queryToken;
    if (!token) return res.status(401).json({ error: "Missing token" });
    try { jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: "Invalid token" }); }

    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawUrl) return res.status(400).json({ error: "Missing audio URL" });
    let targetUrl;
    try { targetUrl = new URL(rawUrl); } catch { return res.status(400).json({ error: "Invalid audio URL" }); }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') return res.status(400).json({ error: "Only HTTP(S) audio URLs are supported" });
    if (isPrivateOrLocalIp(targetUrl.hostname)) return res.status(400).json({ error: "Audio URL host is not allowed" });

    const upstreamHeaders = {};
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;
    const upstreamResponse = await fetch(targetUrl.toString(), { method: "GET", headers: upstreamHeaders, redirect: "follow" });
    if (!upstreamResponse.ok && upstreamResponse.status !== 206) return res.status(502).json({ error: "Failed to fetch audio from source URL", upstreamStatus: upstreamResponse.status });
    const contentType = upstreamResponse.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("audio/")) return res.status(400).json({ error: "Provided URL did not return an audio resource" });

    setProxyResponseHeaders(upstreamResponse.headers, res);
    res.status(upstreamResponse.status);
    if (!upstreamResponse.body) return res.end();
    Readable.fromWeb(upstreamResponse.body).pipe(res);
  } catch (err) {
    console.error("[proxyListeningAudio] Error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Audio proxy failed" });
  }
};

// ──────────────────────────────────────────────
// Uploads — still use Supabase Storage
// ──────────────────────────────────────────────

export const uploadPassageImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const bucketName = 'uploads';
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.some(b => b.name === bucketName)) {
      const { error: createError } = await supabase.storage.createBucket(bucketName, { public: true, fileSizeLimit: 10485760 });
      if (createError) return res.status(500).json({ error: 'Storage not configured.' });
    }
    const ext = req.file.originalname.split('.').pop();
    const filename = `reading/passages/${uuidv4()}.${ext}`;
    const { error } = await supabase.storage.from("uploads").upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) throw error;
    const { data: publicUrlData } = supabase.storage.from("uploads").getPublicUrl(filename);
    res.json({ url: publicUrlData.publicUrl });
  } catch (err) {
    console.error('[uploadPassageImage] Error:', err);
    res.status(500).json({ error: err.message });
  }
};

export const uploadListeningAudio = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });
    if (req.file.size > MAX_AUDIO_UPLOAD_BYTES) return res.status(400).json({ error: `Audio file is too large (max ${MAX_AUDIO_UPLOAD_MB}MB)` });

    const allowedExtensions = ['mp3','wav','ogg','m4a','aac','webm'];
    const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
    const isAudioMime = String(req.file.mimetype || '').toLowerCase().startsWith('audio/');
    const isAllowedExt = allowedExtensions.includes(ext);
    if (!isAudioMime && !isAllowedExt) return res.status(400).json({ error: "Invalid audio format." });

    const bucketName = 'uploads';
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.some(b => b.name === bucketName)) {
      const { error: createError } = await supabase.storage.createBucket(bucketName, { public: true, fileSizeLimit: MAX_AUDIO_UPLOAD_BYTES });
      if (createError) return res.status(500).json({ error: 'Storage not configured.' });
    } else {
      await supabase.storage.updateBucket(bucketName, { public: true, fileSizeLimit: MAX_AUDIO_UPLOAD_BYTES });
    }

    const safeExt = isAllowedExt ? ext : 'mp3';
    const filename = `listening/audio/${uuidv4()}.${safeExt}`;
    const { error } = await supabase.storage.from('uploads').upload(filename, req.file.buffer, { contentType: req.file.mimetype || 'audio/mpeg', upsert: false });
    if (error) throw error;
    const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(filename);
    res.json({ url: publicUrlData.publicUrl });
  } catch (err) {
    console.error('[uploadListeningAudio] Error:', err);
    const message = String(err?.message || 'Upload failed');
    if (message.toLowerCase().includes('exceeded the maximum allowed size')) return res.status(400).json({ error: `Audio file is too large (max ${MAX_AUDIO_UPLOAD_MB}MB)` });
    res.status(500).json({ error: message });
  }
};

// ──────────────────────────────────────────────
// saveExamStructure — the big exam editor save
// ──────────────────────────────────────────────

export const saveExamStructure = async (req, res) => {
  const { id: examId } = req.params;
  const { exam, sections, questions, deletedQuestionIds, questionGroups, deletedGroupIds } = req.body;
  const warnings = [];
  const idMapping = { sections: {}, questions: {}, groups: {} };

  try {
    // 1. Update exam metadata
    await pool.query(
      `UPDATE exams SET title=$1, description=$2, status=$3, code=$4, type=$5 WHERE id=$6`,
      [exam.title, exam.description, exam.status, exam.code, exam.type, examId]
    );

    // 2. Soft-delete removed questions
    if (deletedQuestionIds?.length > 0) {
      await pool.query(
        `UPDATE questions SET is_deleted=true WHERE id = ANY($1::uuid[])`,
        [deletedQuestionIds]
      );
    }

    // 3. Resolve sections
    const { rows: persistedSections } = await pool.query(
      `SELECT id, module_type, section_order FROM exam_sections WHERE exam_id=$1`,
      [examId]
    );

    const persistedSectionIdByComposite = new Map(
      persistedSections.map(s => [`${s.module_type}:${Number(s.section_order)}`, s.id])
    );

    const existingSections = [];
    const newSections = [];

    sections.forEach((section) => {
      const compositeKey = `${section.module_type}:${Number(section.section_order)}`;
      const resolvedExistingId = isUUID(section.id) ? section.id : persistedSectionIdByComposite.get(compositeKey);
      if (resolvedExistingId) {
        if (!isUUID(section.id)) idMapping.sections[section.id] = resolvedExistingId;
        existingSections.push({ ...section, resolvedId: resolvedExistingId });
      } else {
        newSections.push(section);
      }
    });

    // Batch-update existing sections in parallel
    if (existingSections.length > 0) {
      await Promise.all(existingSections.map(section =>
        pool.query(
          `UPDATE exam_sections SET exam_id=$1, module_type=$2, section_order=$3, title=$4,
           content=$5, audio_url=$6, image_url=$7, image_description=$8, letter=$9,
           instruction=$10, task_config=$11 WHERE id=$12`,
          [examId, section.module_type, section.section_order, section.title,
           section.content, section.audio_url, section.image_url || null,
           section.image_description || null, section.letter || null,
           section.instruction || null, serializeTaskConfig(section.task_config),
           section.resolvedId]
        )
      ));
    }

    // Insert new sections sequentially to grab IDs
    for (const section of newSections) {
      const { rows } = await pool.query(
        `INSERT INTO exam_sections (exam_id, module_type, section_order, title, content, audio_url,
          image_url, image_description, letter, instruction, task_config)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [examId, section.module_type, section.section_order, section.title,
         section.content, section.audio_url, section.image_url || null,
         section.image_description || null, section.letter || null,
         section.instruction || null, serializeTaskConfig(section.task_config)]
      );
      if (rows[0]) {
        idMapping.sections[section.id] = rows[0].id;
        persistedSectionIdByComposite.set(`${section.module_type}:${Number(section.section_order)}`, rows[0].id);
      }
    }

    // 4. Save question groups into modules_config
    const modulesConfig = normalizeModulesConfig(exam.modules_config || {});
    const deletedGroupIdSet = new Set(Array.isArray(deletedGroupIds) ? deletedGroupIds : []);

    let normalizedQuestionGroups = Array.isArray(questionGroups)
      ? questionGroups.filter(g => g && typeof g === "object")
      : [];

    if (deletedGroupIdSet.size > 0) {
      normalizedQuestionGroups = normalizedQuestionGroups.filter(g => !deletedGroupIdSet.has(g.id));
    }

    normalizedQuestionGroups = normalizedQuestionGroups.map(group => {
      if (group.id && group.id.toString().startsWith("temp_group_")) {
        const realGroupId = uuidv4();
        idMapping.groups[group.id] = realGroupId;
        return { ...group, id: realGroupId };
      }
      return group;
    });

    const listeningSectionIds = sections
      .filter(s => s.module_type === "listening")
      .map(s => idMapping.sections[s.id] || s.id);
    const readingSectionIds = sections
      .filter(s => s.module_type === "reading")
      .map(s => idMapping.sections[s.id] || s.id);

    const buildGroupPayload = (group, extra = {}) => {
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
        shared_options: group.shared_options || null,
        image_url: group.image_url || null,
        image_description: group.image_description || null,
        layout_type: group.layout_type || null,
        points_per_question: group.points_per_question || 1,
        case_sensitive: group.case_sensitive || false,
        spelling_tolerance: group.spelling_tolerance !== false,
        summary_data: group.summary_data || null,
        summary_title: group.summary_title || null,
        ...extra,
      };
    };

    modulesConfig.listening_question_groups = normalizedQuestionGroups
      .filter(g => { const m = idMapping.sections[g.section_id] || g.section_id; return listeningSectionIds.includes(m); })
      .map(g => buildGroupPayload(g, { audio_start_time: g.audio_start_time || null }));

    modulesConfig.reading_question_groups = normalizedQuestionGroups
      .filter(g => { const m = idMapping.sections[g.section_id] || g.section_id; return readingSectionIds.includes(m); })
      .map(g => buildGroupPayload(g, {
        example: g.example || null,
        headings_list: g.headings_list || null,
        people_list: g.people_list || null,
        matching_style: normalizeMatchingStyle(g.matching_style),
      }));

    // Auto-create question rows for summary_completion blanks
    const allGroups = [...(modulesConfig.listening_question_groups || []), ...(modulesConfig.reading_question_groups || [])];
    for (const group of allGroups) {
      if (group.question_type === "summary_completion" && group.summary_data?.text) {
        const blankCount = (group.summary_data.text.match(/\[BLANK\]/g) || []).length;
        const answersArr = group.summary_data.answers || [];
        for (let i = 0; i < blankCount; i++) {
          const qNum = group.question_range_start + i;
          const { rows: existing } = await pool.query(
            `SELECT id FROM questions WHERE exam_id=$1 AND section_id=$2 AND question_number=$3 LIMIT 1`,
            [examId, group.section_id, qNum]
          );
          if (existing.length === 0) {
            let mainAnswer = answersArr[i] || "";
            let alternatives = null;
            if (typeof mainAnswer === "string" && mainAnswer.includes("/")) {
              const parts = mainAnswer.split("/").map(s => s.trim()).filter(Boolean);
              mainAnswer = parts[0];
              alternatives = parts.slice(1);
            }
            await pool.query(
              `INSERT INTO questions (exam_id, section_id, question_number, question_text, question_type,
                correct_answer, answer_alternatives, points, question_data)
               VALUES ($1,$2,$3,$4,'summary_completion',$5,$6,1,$7)`,
              [examId, group.section_id, qNum, `Summary completion blank ${i + 1}`,
               mainAnswer, alternatives ? JSON.stringify(alternatives) : null,
               JSON.stringify({ group_id: group.id })]
            );
          }
        }
      }
    }

    // Persist modules_config
    await pool.query(`UPDATE exams SET modules_config=$1 WHERE id=$2`, [JSON.stringify(modulesConfig), examId]);

    // 5. Process questions
    const mappedActiveGroups = normalizedQuestionGroups.map(g => ({
      ...g,
      id: idMapping.groups[g.id] || g.id,
      section_id: idMapping.sections[g.section_id] || g.section_id,
    }));

    const groupTypeById = new Map();
    const groupsBySection = new Map();
    mappedActiveGroups.forEach(g => {
      if (!g?.id || !g?.question_type) return;
      groupTypeById.set(g.id, g.question_type);
      if (!groupsBySection.has(g.section_id)) groupsBySection.set(g.section_id, []);
      groupsBySection.get(g.section_id).push(g);
    });
    groupsBySection.forEach((sectionGroups, sectionId) => {
      groupsBySection.set(sectionId, [...sectionGroups].sort((a, b) => {
        const d = Number(a.group_order || 0) - Number(b.group_order || 0);
        return d !== 0 ? d : Number(a.question_range_start || 0) - Number(b.question_range_start || 0);
      }));
    });

    const mappedDeletedGroupIds = new Set(Array.from(deletedGroupIdSet).map(gid => idMapping.groups[gid] || gid));

    const mappedQuestions = questions.map(q => {
      const mappedSectionId = idMapping.sections[q.section_id] || q.section_id;
      let resolvedGroupId = idMapping.groups[q.group_id] || q.group_id || null;
      if (!resolvedGroupId || !groupTypeById.has(resolvedGroupId)) {
        const sectionGroups = groupsBySection.get(mappedSectionId) || [];
        const qn = Number(q.question_number || 0);
        const matches = sectionGroups.filter(g => {
          const s = Number(g.question_range_start), e = Number(g.question_range_end);
          return Number.isFinite(s) && Number.isFinite(e) && qn >= s && qn <= e;
        });
        if (matches.length === 1) resolvedGroupId = matches[0].id;
        else if (matches.length > 1) {
          const et = String(q.question_type || q.type || '').toLowerCase();
          const tm = et ? matches.find(g => String(g.question_type || '').toLowerCase() === et) : null;
          resolvedGroupId = (tm || matches[0]).id;
        }
      }

      const {
        id, section_id, question_text, question_type, correct_answer, points, question_number,
        exam_id, created_at, is_deleted,
        is_info_row, row_order, label_text, info_text, question_template, answer_alternatives,
        option_a, option_b, option_c, option_d, option_e, option_f, option_g, option_h,
        group_id, passage_letter, ...extraFields
      } = q;
      const resolvedQuestionType = (resolvedGroupId && groupTypeById.get(resolvedGroupId)) || question_type || q.type || 'multiple_choice';
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
          question_data: {
            ...extraFields,
            group_id: resolvedGroupId,
            option_a: option_a || null, option_b: option_b || null,
            option_c: option_c || null, option_d: option_d || null,
            option_e: option_e || null, option_f: option_f || null,
            option_g: option_g || null, option_h: option_h || null,
          }
        }
      };
    }).filter(q => {
      const gid = q?.payload?.question_data?.group_id;
      return !gid || !mappedDeletedGroupIds.has(gid);
    });

    const existingQuestions = mappedQuestions.filter(q => !q.isNew);
    const newQuestions = mappedQuestions.filter(q => q.isNew);

    // Batch-update existing questions in parallel
    if (existingQuestions.length > 0) {
      const results = await Promise.all(existingQuestions.map(q =>
        pool.query(
          `UPDATE questions SET exam_id=$1, section_id=$2, question_text=$3, question_type=$4,
           correct_answer=$5, points=$6, question_number=$7, is_info_row=$8, row_order=$9,
           label_text=$10, info_text=$11, question_template=$12, answer_alternatives=$13,
           question_data=$14, is_deleted=false WHERE id=$15`,
          [q.payload.exam_id, q.payload.section_id, q.payload.question_text, q.payload.question_type,
           q.payload.correct_answer, q.payload.points, q.payload.question_number,
           q.payload.is_info_row, q.payload.row_order, q.payload.label_text, q.payload.info_text,
           q.payload.question_template,
           q.payload.answer_alternatives ? JSON.stringify(q.payload.answer_alternatives) : null,
           JSON.stringify(q.payload.question_data), q.originalId]
        ).catch(err => { console.error(`Failed to update question ${q.originalId}:`, err); return { error: err }; })
      ));
      const failed = results.filter(r => r.error);
      if (failed.length > 0) warnings.push(`Failed to update ${failed.length} questions`);
    }

    // Insert new questions individually
    if (newQuestions.length > 0) {
      let insertedCount = 0;
      for (const q of newQuestions) {
        const { rows: existing } = await pool.query(
          `SELECT id FROM questions WHERE exam_id=$1 AND section_id=$2 AND question_number=$3 LIMIT 1`,
          [q.payload.exam_id, q.payload.section_id, q.payload.question_number]
        );
        if (existing.length > 0) {
          const { rows: updated } = await pool.query(
            `UPDATE questions SET exam_id=$1, section_id=$2, question_text=$3, question_type=$4,
             correct_answer=$5, points=$6, question_number=$7, is_info_row=$8, row_order=$9,
             label_text=$10, info_text=$11, question_template=$12, answer_alternatives=$13,
             question_data=$14, is_deleted=false WHERE id=$15 RETURNING id`,
            [q.payload.exam_id, q.payload.section_id, q.payload.question_text, q.payload.question_type,
             q.payload.correct_answer, q.payload.points, q.payload.question_number,
             q.payload.is_info_row, q.payload.row_order, q.payload.label_text, q.payload.info_text,
             q.payload.question_template,
             q.payload.answer_alternatives ? JSON.stringify(q.payload.answer_alternatives) : null,
             JSON.stringify(q.payload.question_data), existing[0].id]
          );
          if (updated[0]) { idMapping.questions[q.originalId] = updated[0].id; insertedCount++; }
        } else {
          const { rows: inserted } = await pool.query(
            `INSERT INTO questions (exam_id, section_id, question_text, question_type, correct_answer,
              points, question_number, is_info_row, row_order, label_text, info_text,
              question_template, answer_alternatives, question_data)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
            [q.payload.exam_id, q.payload.section_id, q.payload.question_text, q.payload.question_type,
             q.payload.correct_answer, q.payload.points, q.payload.question_number,
             q.payload.is_info_row, q.payload.row_order, q.payload.label_text, q.payload.info_text,
             q.payload.question_template,
             q.payload.answer_alternatives ? JSON.stringify(q.payload.answer_alternatives) : null,
             JSON.stringify(q.payload.question_data)]
          );
          if (inserted[0]) { idMapping.questions[q.originalId] = inserted[0].id; insertedCount++; }
        }
      }
    }

    // 6. Sync listening sections task_config backup
    const listeningSections = sections.filter(s => s.module_type === 'listening');
    if (listeningSections.length > 0) {
      await Promise.all(listeningSections.map(async section => {
        const realSectionId = idMapping.sections[section.id] || section.id;
        const sectionGroups = normalizedQuestionGroups.filter(g =>
          g.section_id === section.id || g.section_id === realSectionId
        );
        let existingTaskConfig = {};
        if (section.task_config) {
          try { existingTaskConfig = typeof section.task_config === 'string' ? JSON.parse(section.task_config) : section.task_config; } catch {}
        }
        const groupsConfig = { ...existingTaskConfig, question_groups: sectionGroups.map(g => ({ ...g, section_id: realSectionId })) };
        await pool.query(`UPDATE exam_sections SET task_config=$1 WHERE id=$2`, [JSON.stringify(groupsConfig), realSectionId])
          .catch(err => warnings.push(`Failed to sync listening task config for section ${realSectionId}: ${err.message}`));
      }));
    }

    res.json({ message: "Exam saved", idMapping, warnings: warnings.length > 0 ? warnings : undefined });
  } catch (err) {
    console.error("Save error:", err);
    res.status(500).json({ error: err.message, warnings });
  }
};

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

export const listExams = async (req, res) => {
  try {
    const userRole = req.user?.role;
    let query, params = [];
    if (userRole === "student") {
      query = `SELECT * FROM exams WHERE (is_deleted IS NOT TRUE) AND status='active' ORDER BY created_at DESC`;
    } else {
      query = `SELECT * FROM exams WHERE (is_deleted IS NOT TRUE) AND status != 'deleted' ORDER BY created_at DESC`;
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("List Exams Error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const deleteExam = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE exams SET status='deleted', is_deleted=true WHERE id=$1 RETURNING *`, [id]
    );
    res.json({ message: "Exam deleted successfully", exam: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const restoreExam = async (req, res) => {
  const { id } = req.params;
  try {
    const newAccessCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const { rows } = await pool.query(
      `UPDATE exams SET status='draft', is_deleted=false, access_code=$1 WHERE id=$2 RETURNING *`,
      [newAccessCode, id]
    );
    res.json({ message: "Exam restored successfully", exam: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const permanentlyDeleteExam = async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`DELETE FROM questions WHERE exam_id=$1`, [id]);
    await pool.query(`DELETE FROM exam_sections WHERE exam_id=$1`, [id]);
    const { rows: subs } = await pool.query(`SELECT id FROM exam_submissions WHERE exam_id=$1`, [id]);
    if (subs.length > 0) {
      const subIds = subs.map(s => s.id);
      await pool.query(`DELETE FROM answers WHERE submission_id = ANY($1::uuid[])`, [subIds]);
      await pool.query(`DELETE FROM exam_submissions WHERE exam_id=$1`, [id]);
    }
    await pool.query(`DELETE FROM exams WHERE id=$1`, [id]);
    res.json({ message: "Exam permanently deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const regenerateExamCode = async (req, res) => {
  const { id } = req.params;
  try {
    const newAccessCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const { rows } = await pool.query(
      `UPDATE exams SET access_code=$1 WHERE id=$2 RETURNING *`, [newAccessCode, id]
    );
    res.json({ message: "Exam code regenerated", exam: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteQuestion = async (req, res) => {
  const { questionId } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE questions SET is_deleted=true WHERE id=$1 RETURNING *`, [questionId]
    );
    res.json({ message: "Question deleted successfully", question: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const restoreQuestion = async (req, res) => {
  const { questionId } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE questions SET is_deleted=false WHERE id=$1 RETURNING *`, [questionId]
    );
    res.json({ message: "Question restored successfully", question: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const listDeletedQuestions = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT q.*, json_build_object('title', e.title) AS exam
       FROM questions q LEFT JOIN exams e ON e.id = q.exam_id
       WHERE q.is_deleted = true ORDER BY q.updated_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const permanentlyDeleteQuestion = async (req, res) => {
  const { questionId } = req.params;
  try {
    await pool.query(`DELETE FROM answers WHERE question_id=$1`, [questionId]);
    await pool.query(`DELETE FROM questions WHERE id=$1`, [questionId]);
    res.json({ message: "Question permanently deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const listDeletedExams = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM exams WHERE is_deleted=true OR status='deleted' ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("List Deleted Exams Error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const createExam = async (req, res) => {
  const { title, description, duration_minutes, modules_config, access_code, security_level, target_audience, assigned_classroom_id } = req.body;
  const createdBy = req.user.id;
  if (!title || !duration_minutes) return res.status(400).json({ error: "Missing required fields" });

  try {
    const { rows } = await pool.query(
      `INSERT INTO exams (title, description, duration_minutes, modules_config, access_code, created_by,
        status, security_level, target_audience, assigned_classroom_id)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9) RETURNING *`,
      [title, description, duration_minutes,
       JSON.stringify(normalizeModulesConfig(modules_config || {})),
       access_code || Math.random().toString(36).substring(2, 8).toUpperCase(),
       createdBy, security_level || "standard", target_audience || "all",
       assigned_classroom_id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateExamStatus = async (req, res) => {
  const { id } = req.params;
  const { status, security_level, target_audience, assigned_classroom_id } = req.body;

  try {
    const sets = []; const params = []; let idx = 1;
    if (status) {
      sets.push(`status = $${idx++}`); params.push(status);
      if (status === 'active') {
        const { rows: existing } = await pool.query(`SELECT access_code FROM exams WHERE id=$1`, [id]);
        if (!existing[0]?.access_code) {
          sets.push(`access_code = $${idx++}`);
          params.push(Math.random().toString(36).substring(2, 8).toUpperCase());
        }
      }
    }
    if (security_level) { sets.push(`security_level = $${idx++}`); params.push(security_level); }
    if (target_audience) { sets.push(`target_audience = $${idx++}`); params.push(target_audience); }
    if (assigned_classroom_id !== undefined) { sets.push(`assigned_classroom_id = $${idx++}`); params.push(assigned_classroom_id); }

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE exams SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`, params
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getExamLogs = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT v.*,
              json_build_object('first_name', u.first_name, 'last_name', u.last_name, 'email', u.email, 'username', u.username) AS "user"
       FROM violations v LEFT JOIN users u ON u.id = v.user_id
       WHERE v.exam_id=$1 ORDER BY v.occurred_at DESC`, [id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────
// getExam — the big exam loader
// ──────────────────────────────────────────────

export const getExam = async (req, res) => {
  const { id } = req.params;
  const { role } = req.user;

  try {
    const { rows: examRows } = await pool.query(`SELECT * FROM exams WHERE id=$1`, [id]);
    if (examRows.length === 0) return res.status(404).json({ error: "Exam not found" });
    const exam = examRows[0];

    const normalizedModulesConfig = normalizeModulesConfig(exam.modules_config || {});
    if (JSON.stringify(normalizedModulesConfig) !== JSON.stringify(exam.modules_config || {})) {
      pool.query(`UPDATE exams SET modules_config=$1 WHERE id=$2`, [JSON.stringify(normalizedModulesConfig), id]).catch(() => {});
    }
    exam.modules_config = normalizedModulesConfig;

    if (role === "student" && exam.status !== "active") {
      return res.status(403).json({ error: "Exam is not active" });
    }

    const { rows: sections } = await pool.query(
      `SELECT * FROM exam_sections WHERE exam_id=$1 ORDER BY section_order ASC`, [id]
    );

    // Normalize task_config: unwrap any double-encoded strings so frontend always gets a clean JSON string
    for (const sec of sections) {
      if (sec.task_config) {
        try {
          let val = sec.task_config;
          while (typeof val === 'string') {
            const parsed = JSON.parse(val);
            if (typeof parsed === 'string') { val = parsed; continue; }
            // It's an object — re-serialize to a clean single-layer JSON string
            sec.task_config = JSON.stringify(parsed);
            break;
          }
        } catch { /* leave as-is if unparseable */ }
      }
    }

    const { rows: rawQuestions } = await pool.query(
      `SELECT * FROM questions WHERE exam_id=$1 AND (is_deleted=false OR is_deleted IS NULL) ORDER BY module_type, question_number`, [id]
    );

    // Merge question_data fields
    const mergedQuestions = rawQuestions.map(q => {
      const { question_data, ...rest } = q;
      return { ...rest, ...(question_data || {}) };
    });

    const sanitizedQuestions = role === "student"
      ? mergedQuestions.map(({ correct_answer, ...rest }) => rest)
      : mergedQuestions;

    // Build question groups from modules_config (preferred) with fallbacks
    const normalizeGroupSectionIds = (groups, mergedList, sectionList) => {
      if (!Array.isArray(groups) || groups.length === 0) return [];
      const validSectionIds = new Set((sectionList || []).map(s => s.id));
      const sectionByGroupIdCounts = new Map();
      (mergedList || []).forEach(q => {
        const gid = q?.group_id, sid = q?.section_id;
        if (!gid || !sid || !validSectionIds.has(sid)) return;
        if (!sectionByGroupIdCounts.has(gid)) sectionByGroupIdCounts.set(gid, new Map());
        const cm = sectionByGroupIdCounts.get(gid);
        cm.set(sid, (cm.get(sid) || 0) + 1);
      });
      return groups.map(g => {
        if (!g || typeof g !== 'object') return g;
        if (g.section_id && validSectionIds.has(g.section_id)) return g;
        if (g.id && sectionByGroupIdCounts.has(g.id)) {
          const best = Array.from(sectionByGroupIdCounts.get(g.id).entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
          if (best) return { ...g, section_id: best };
        }
        return g;
      });
    };

    let questionGroups = [];

    // Listening groups
    const lSections = sections.filter(s => s.module_type === 'listening');
    const lSectionIds = lSections.map(s => s.id);
    if (lSectionIds.length > 0) {
      const mcGroups = Array.isArray(exam.modules_config?.listening_question_groups)
        ? exam.modules_config.listening_question_groups.filter(g => lSectionIds.includes(g.section_id))
        : [];
      if (mcGroups.length > 0) {
        questionGroups.push(...mcGroups);
      } else {
        // Fallback: listening_question_groups table
        const { rows: tableGroups } = await pool.query(
          `SELECT * FROM listening_question_groups WHERE section_id = ANY($1::uuid[]) ORDER BY group_order ASC`,
          [lSectionIds]
        );
        if (tableGroups.length > 0) questionGroups.push(...tableGroups);

        // Fallback: section task_config
        for (const sec of lSections) {
          if (sec.task_config) {
            try {
              const config = typeof sec.task_config === 'string' ? JSON.parse(sec.task_config) : sec.task_config;
              if (Array.isArray(config.question_groups)) questionGroups.push(...config.question_groups);
            } catch {}
          }
        }
      }
    }

    // Reading groups
    const rSections = sections.filter(s => s.module_type === 'reading');
    const rSectionIds = rSections.map(s => s.id);
    if (rSectionIds.length > 0 && Array.isArray(exam.modules_config?.reading_question_groups)) {
      questionGroups.push(...exam.modules_config.reading_question_groups.filter(g => rSectionIds.includes(g.section_id)));
    }

    // Deduplicate
    const uniqueGroups = Array.from(
      new Map(questionGroups.filter(Boolean).map(g => {
        const fk = `${g.section_id || 'section'}:${g.question_type || 'type'}:${g.question_range_start || 's'}:${g.question_range_end || 'e'}`;
        return [g.id || fk, g];
      })).values()
    );

    const normalizedGroups = normalizeGroupSectionIds(uniqueGroups, mergedQuestions, sections);

    res.json({ ...exam, sections, questions: sanitizedQuestions, questionGroups: normalizedGroups });
  } catch (err) {
    console.error(`Get exam error:`, err);
    res.status(500).json({ error: err.message });
  }
};

export const createSection = async (req, res) => {
  const { id: examId } = req.params;
  const { module_type, section_order, title, content, audio_url, duration_minutes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO exam_sections (exam_id, module_type, section_order, title, content, audio_url, duration_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [examId, module_type, section_order, title, content, audio_url, duration_minutes]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const addQuestions = async (req, res) => {
  const { id: examId } = req.params;
  const { questions } = req.body;
  if (!Array.isArray(questions)) return res.status(400).json({ error: "Questions must be an array" });

  try {
    const inserted = [];
    for (const q of questions) {
      const { rows } = await pool.query(
        `INSERT INTO questions (exam_id, section_id, question_text, question_type, correct_answer, points, question_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [examId, q.section_id, q.question_text, q.question_type, q.correct_answer, q.points, q.question_number]
      );
      if (rows[0]) inserted.push(rows[0]);
    }
    res.status(201).json(inserted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────
// submitExam — grading + submission
// ──────────────────────────────────────────────

export const submitExam = async (req, res) => {
  const { id: examId } = req.params;
  const userId = req.user.id;
  const { answers, time_spent_by_module } = req.body;

  try {
    const submittedAnswers = answers && typeof answers === 'object' ? answers : {};

    // Merge latest autosave
    const { rows: autosaveRows } = await pool.query(
      `SELECT answers_data, time_spent, last_updated FROM exam_autosaves WHERE exam_id=$1 AND user_id=$2 LIMIT 1`,
      [examId, userId]
    );
    const autosaveData = autosaveRows[0] || null;
    const autosaveAnswers = autosaveData?.answers_data && typeof autosaveData.answers_data === 'object'
      ? autosaveData.answers_data : {};

    const mergedFinalAnswers = { ...autosaveAnswers, ...submittedAnswers };

    const submittedTimeSpent = time_spent_by_module && typeof time_spent_by_module === 'object' ? time_spent_by_module : {};
    const autosaveTimeSpent = autosaveData?.time_spent && typeof autosaveData.time_spent === 'object' ? autosaveData.time_spent : {};

    const normalizedTimeSpentByModule = {
      listening: Number(submittedTimeSpent.listening ?? autosaveTimeSpent.listening ?? 0) || 0,
      reading: Number(submittedTimeSpent.reading ?? autosaveTimeSpent.reading ?? 0) || 0,
      writing: Number(submittedTimeSpent.writing ?? (Number(autosaveTimeSpent.writing_task1 || 0) + Number(autosaveTimeSpent.writing_task2 || 0)) ?? 0) || 0
    };
    const totalTimeSpent = Object.values(normalizedTimeSpentByModule).reduce((s, v) => s + (Number(v) || 0), 0);

    // Check existing submission
    const { rows: existingRows } = await pool.query(
      `SELECT id FROM exam_submissions WHERE exam_id=$1 AND user_id=$2 LIMIT 1`,
      [examId, userId]
    );
    const existing = existingRows[0] || null;
    const isUpdate = !!existing;

    // Fetch questions with section info
    const { rows: questions } = await pool.query(
      `SELECT q.id, q.correct_answer, q.answer_alternatives, q.points, q.question_number,
              q.question_type, q.question_data,
              json_build_object('id', s.id, 'module_type', s.module_type, 'title', s.title) AS exam_sections
       FROM questions q
       INNER JOIN exam_sections s ON s.id = q.section_id
       WHERE q.exam_id=$1 AND (q.is_deleted IS NOT TRUE)`, [examId]
    );

    if (!questions || questions.length === 0) {
      return res.status(400).json({ error: "No questions found for this exam" });
    }

    // Remap summary_placeholder IDs → real question IDs
    const remappedAnswers = { ...mergedFinalAnswers };
    const placeholderKeys = Object.keys(remappedAnswers).filter(k => k.startsWith('summary_placeholder_'));
    if (placeholderKeys.length > 0) {
      const { rows: examRows } = await pool.query(`SELECT modules_config FROM exams WHERE id=$1`, [examId]);
      const mc = examRows[0]?.modules_config || {};
      const allGroups = [...(mc.listening_question_groups || []), ...(mc.reading_question_groups || [])];
      for (const key of placeholderKeys) {
        const parts = key.replace('summary_placeholder_', '').split('_');
        const blankIndex = parseInt(parts.pop(), 10);
        const groupId = parts.join('_');
        const group = allGroups.find(g => g.id === groupId);
        if (group) {
          const qNum = group.question_range_start + blankIndex;
          const realQ = questions.find(q => q.exam_sections?.id === group.section_id && q.question_number === qNum);
          if (realQ) { remappedAnswers[realQ.id] = remappedAnswers[key]; delete remappedAnswers[key]; }
        }
      }
    }

    // ── Grading logic (identical to original) ──

    let totalScore = 0, totalPoints = 0;
    const gradedAnswers = [];
    const moduleScores = { listening: { correct: 0, total: 0 }, reading: { correct: 0, total: 0 }, writing: { correct: 0, total: 0 } };

    const DEFAULT_LISTENING_BAND_TABLE = [
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

    const DEFAULT_READING_ACADEMIC_BAND_TABLE = [
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

    const normalizeBandTable = (rawTable, fallbackTable) => {
      let parsed = rawTable;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          parsed = null;
        }
      }

      if (!Array.isArray(parsed)) {
        return [...fallbackTable];
      }

      const normalized = parsed
        .map((row) => {
          const min = Number(row?.min);
          const max = Number(row?.max);
          const band = Number(row?.band);
          if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(band)) {
            return null;
          }
          return { min, max, band };
        })
        .filter(Boolean)
        .sort((a, b) => b.max - a.max);

      return normalized.length > 0 ? normalized : [...fallbackTable];
    };

    const getBandFromTable = (correctAnswers, bandTable) => {
      const numericCorrect = Math.round(Number(correctAnswers) || 0);
      if (numericCorrect >= 1 && numericCorrect <= 9) {
        if (numericCorrect === 1) return 1.0;
        if (numericCorrect === 2) return 2.0;
        if (numericCorrect === 3) return 2.5;
        if (numericCorrect >= 4 && numericCorrect <= 6) return 3.0;
        return 3.5; // 7-9
      }
      const matched = bandTable.find((row) => numericCorrect >= row.min && numericCorrect <= row.max);
      return matched ? matched.band : 0;
    };

    let listeningBandTable = [...DEFAULT_LISTENING_BAND_TABLE];
    let readingAcademicBandTable = [...DEFAULT_READING_ACADEMIC_BAND_TABLE];

    try {
      const { rows: scoringConfigRows } = await pool.query(
        `SELECT config_key, config_value FROM scoring_configs WHERE config_key = ANY($1::text[])`,
        [['ielts_listening_band', 'ielts_reading_academic_band']]
      );

      const configMap = {};
      (scoringConfigRows || []).forEach((row) => {
        configMap[row.config_key] = row.config_value;
      });

      listeningBandTable = normalizeBandTable(configMap.ielts_listening_band, DEFAULT_LISTENING_BAND_TABLE);
      readingAcademicBandTable = normalizeBandTable(configMap.ielts_reading_academic_band, DEFAULT_READING_ACADEMIC_BAND_TABLE);
    } catch (configErr) {
      console.warn('[submitExam.pg] Failed to fetch scoring configs, using defaults:', configErr.message);
    }

    const normalizeMultiAnswer = (val) => {
      if (!val) return '';
      const str = String(val).trim().toUpperCase();
      if (str.includes('/')) return str.split('/').map(s => s.trim()).filter(Boolean).sort().join(',');
      if (/^[A-Z]+$/.test(str)) return str.split('').sort().join(',');
      return str.toLowerCase();
    };
    const parseMultiAnswerArray = (val) => {
      if (!val) return [];
      const str = String(val).trim().toUpperCase();
      if (str.includes('/')) return str.split('/').map(s => s.trim()).filter(Boolean);
      if (str.includes(',')) return str.split(',').map(s => s.trim()).filter(Boolean);
      if (/^[A-Z]+$/.test(str)) return str.split('');
      return [str];
    };
    const normalizeTriStateAnswer = (value, questionType = '') => {
      const normalizedType = String(questionType || '').trim().toLowerCase();
      const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
      if (!normalized) return '';
      if (normalized === 'not_given' || normalized === 'notgiven' || normalized === 'ng') return 'not_given';
      if (normalizedType === 'yes_no_not_given') {
        if (['yes','y','true','t'].includes(normalized)) return 'yes';
        if (['no','n','false','f'].includes(normalized)) return 'no';
        return normalized;
      }
      if (normalizedType === 'true_false_not_given') {
        if (['true','t','yes','y'].includes(normalized)) return 'true';
        if (['false','f','no','n'].includes(normalized)) return 'false';
        return normalized;
      }
      return normalized;
    };

    questions.forEach(q => {
      try {
        const userAns = remappedAnswers[q.id];
        const moduleType = q.exam_sections?.module_type || 'unknown';
        const qType = q.question_type || '';
        const normalizedQuestionType = String(qType).trim().toLowerCase();
        const isTriState = normalizedQuestionType === 'true_false_not_given' || normalizedQuestionType === 'yes_no_not_given';
        let isCorrect = false, score = 0;
        let pointsForQuestion = q.points || 1;
        const normUserTri = isTriState ? normalizeTriStateAnswer(userAns, normalizedQuestionType) : '';
        const normCorrectTri = isTriState ? normalizeTriStateAnswer(q.correct_answer, normalizedQuestionType) : '';
        const userAnswerForRecord = isTriState && normUserTri ? normUserTri : userAns;
        const correctAnswerForRecord = isTriState && normCorrectTri ? normCorrectTri : q.correct_answer;

        if (userAns !== undefined && userAns !== null && userAns !== '') {
          if (qType === 'multiple_choice_multiple') {
            const userSelections = parseMultiAnswerArray(userAns);
            const correctAnswers = parseMultiAnswerArray(q.correct_answer);
            const correctCount = userSelections.filter(s => correctAnswers.includes(s)).length;
            score = correctCount;
            isCorrect = (correctCount === correctAnswers.length && userSelections.length === correctAnswers.length);
            pointsForQuestion = correctAnswers.length;
          } else {
            const normalizeOpenAnswer = (val) => String(val || '').trim().toLowerCase().replace(/\s+/g, ' ');
            const userAnswerLower = isTriState ? normUserTri : normalizeOpenAnswer(userAns);
            const isOpenEndedType = ['short_answer','sentence_completion','note_completion','form_completion','table_completion','summary_completion','map_labeling','diagram_labeling'].includes(normalizedQuestionType);
            const acceptableAnswers = [];
            const rawCorrect = q.correct_answer ? String(q.correct_answer) : '';
            if (isOpenEndedType && !isTriState && rawCorrect.includes('/')) {
              rawCorrect.split('/').forEach(p => { const n = normalizeOpenAnswer(p); if (n) acceptableAnswers.push(n); });
            } else {
              const n = isTriState ? normCorrectTri : normalizeOpenAnswer(rawCorrect);
              if (n) acceptableAnswers.push(n);
            }
            if (q.answer_alternatives) {
              let alts = q.answer_alternatives;
              if (typeof alts === 'string') alts = alts.split('/').map(s => s.trim()).filter(Boolean);
              if (Array.isArray(alts)) {
                for (const alt of alts) {
                  const n = isTriState ? normalizeTriStateAnswer(alt, normalizedQuestionType) : normalizeOpenAnswer(alt);
                  if (n) acceptableAnswers.push(n);
                }
              }
            }
            if (acceptableAnswers.some(a => a === userAnswerLower)) { isCorrect = true; score = q.points || 1; }
          }
        }

        totalScore += score;
        totalPoints += pointsForQuestion;
        if (moduleType && moduleScores[moduleType]) {
          moduleScores[moduleType].total += pointsForQuestion;
          if (score > 0) moduleScores[moduleType].correct += score;
        }
        gradedAnswers.push({
          question_id: q.id, question_number: q.question_number,
          section_id: q.exam_sections?.id || null,
          section_title: q.exam_sections?.title || 'Unknown Section',
          module_type: moduleType,
          user_answer: userAnswerForRecord, correct_answer: correctAnswerForRecord,
          is_correct: isCorrect, score
        });
      } catch (err) {
        console.error(`Error grading question ${q.id}:`, err);
      }
    });

    const scoresByModule = {};
    Object.keys(moduleScores).forEach(m => {
      if (moduleScores[m].total <= 0) {
        scoresByModule[m] = 0;
        return;
      }

      if (m === 'listening') {
        scoresByModule[m] = getBandFromTable(moduleScores[m].correct, listeningBandTable);
      } else if (m === 'reading') {
        scoresByModule[m] = getBandFromTable(moduleScores[m].correct, readingAcademicBandTable);
      } else {
        scoresByModule[m] = Math.round((moduleScores[m].correct / moduleScores[m].total) * 9 * 2) / 2;
      }
    });
    const overallBand = totalPoints > 0 ? (totalScore / totalPoints) * 9 : 0;
    const roundedBand = Math.round(overallBand * 2) / 2;

    // ── Save submission ──
    let submission;
    if (isUpdate) {
      const { rows } = await pool.query(
        `UPDATE exam_submissions SET answers=$1, scores_by_module=$2, band_score=$3, overall_band_score=$3,
         total_correct=$4, total_questions=$5, time_spent=$6, time_spent_by_module=$7,
         status='submitted', submitted_at=NOW()
         WHERE id=$8 RETURNING *`,
        [JSON.stringify(remappedAnswers), JSON.stringify(scoresByModule), roundedBand,
         totalScore, questions.length, totalTimeSpent, JSON.stringify(normalizedTimeSpentByModule),
         existing.id]
      );
      submission = rows[0];
      await pool.query(`DELETE FROM answers WHERE submission_id=$1`, [existing.id]);
    } else {
      const { rows } = await pool.query(
        `INSERT INTO exam_submissions (user_id, exam_id, answers, scores_by_module, band_score,
          overall_band_score, total_correct, total_questions, time_spent, time_spent_by_module,
          status, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,'submitted',NOW()) RETURNING *`,
        [userId, examId, JSON.stringify(remappedAnswers), JSON.stringify(scoresByModule),
         roundedBand, totalScore, questions.length, totalTimeSpent,
         JSON.stringify(normalizedTimeSpentByModule)]
      );
      submission = rows[0];
    }

    // Store graded answers
    if (gradedAnswers.length > 0) {
      const vals = []; const params = []; let idx = 1;
      gradedAnswers.forEach(a => {
        vals.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
        params.push(submission.id, a.question_id, a.user_answer, a.is_correct, a.score);
      });
      await pool.query(
        `INSERT INTO answers (submission_id, question_id, user_answer, is_correct, score) VALUES ${vals.join(",")}`,
        params
      ).catch(async (err) => {
        console.error('Error inserting answers (attempt 1):', err);
        // Retry once
        await pool.query(
          `INSERT INTO answers (submission_id, question_id, user_answer, is_correct, score) VALUES ${vals.join(",")}`,
          params
        ).catch(err2 => console.error('Error inserting answers (attempt 2, non-fatal):', err2));
      });
    }

    // Save writing essays
    try {
      const writingKeys = Object.keys(remappedAnswers).filter(k => k.startsWith('writing_task_'));
      if (writingKeys.length > 0) {
        const { rows: writingSections } = await pool.query(
          `SELECT id, section_order, task_config, title FROM exam_sections
           WHERE exam_id=$1 AND module_type='writing' ORDER BY section_order ASC`, [examId]
        );
        for (const key of writingKeys) {
          const taskNumber = parseInt(key.replace('writing_task_', ''), 10);
          const essayText = remappedAnswers[key];
          if (!essayText || typeof essayText !== 'string' || essayText.trim().length === 0) continue;
          const section = writingSections?.find((_, idx) => (idx + 1) === taskNumber) || writingSections?.[taskNumber - 1];
          const sectionId = section?.id || null;
          const wordCount = essayText.trim().split(/\s+/).length;

          const { rows: existWr } = await pool.query(
            `SELECT id FROM writing_responses WHERE submission_id=$1 AND task_number=$2 LIMIT 1`,
            [submission.id, taskNumber]
          );
          if (existWr[0]) {
            await pool.query(
              `UPDATE writing_responses SET section_id=$1, response_text=$2, word_count=$3 WHERE id=$4`,
              [sectionId, essayText, wordCount, existWr[0].id]
            );
          } else {
            await pool.query(
              `INSERT INTO writing_responses (submission_id, section_id, task_number, response_text, word_count)
               VALUES ($1,$2,$3,$4,$5)`,
              [submission.id, sectionId, taskNumber, essayText, wordCount]
            );
          }
        }
      }
    } catch (writingErr) {
      console.error('Error saving writing responses (non-fatal):', writingErr);
    }

    // Clean up autosave
    try {
      await pool.query(`DELETE FROM exam_autosaves WHERE exam_id=$1 AND user_id=$2`, [examId, userId]);
    } catch {}

    res.json({ message: "Exam submitted successfully", score: roundedBand, scores_by_module: scoresByModule, submission_id: submission.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────
// getExamStats
// ──────────────────────────────────────────────

export const getExamStats = async (req, res) => {
  const { id } = req.params;
  try {
    const [active, total, completed] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM exam_submissions WHERE exam_id=$1 AND status='in_progress'`, [id]),
      pool.query(`SELECT COUNT(*) FROM exam_submissions WHERE exam_id=$1`, [id]),
      pool.query(`SELECT COUNT(*) FROM exam_submissions WHERE exam_id=$1 AND status IN ('submitted','auto_submitted')`, [id]),
    ]);
    res.json({
      active_participants: parseInt(active.rows[0].count) || 0,
      total_participants: parseInt(total.rows[0].count) || 0,
      completed_count: parseInt(completed.rows[0].count) || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────
// Access codes
// ──────────────────────────────────────────────

export const updateAccessCode = async (req, res) => {
  const { id } = req.params;
  const { access_code } = req.body;
  if (!access_code || access_code.length < 4 || access_code.length > 12) {
    return res.status(400).json({ error: "Access code must be between 4 and 12 characters" });
  }
  try {
    const { rows: dup } = await pool.query(
      `SELECT id FROM exams WHERE access_code=$1 AND id != $2 LIMIT 1`,
      [access_code.toUpperCase(), id]
    );
    if (dup.length > 0) return res.status(400).json({ error: "This access code is already in use by another exam" });

    const { rows } = await pool.query(
      `UPDATE exams SET access_code=$1 WHERE id=$2 RETURNING *`,
      [access_code.toUpperCase(), id]
    );
    res.json({ message: "Access code updated", exam: rows[0] });
  } catch (err) {
    console.error("Update access code error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const verifyExamCode = async (req, res) => {
  const { code } = req.body;
  const userId = req.user.id;
  if (!code || code.length < 4) return res.status(400).json({ error: "Invalid exam code" });

  try {
    const { rows } = await pool.query(
      `SELECT id, title, status, duration_minutes FROM exams WHERE access_code=$1 LIMIT 1`,
      [code.toUpperCase()]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Invalid exam code or exam not found" });
    const exam = rows[0];
    if (exam.status !== "active") return res.status(403).json({ error: "This exam is not currently active" });

    await pool.query(
      `INSERT INTO monitoring_logs (exam_id, user_id, event_type, metadata) VALUES ($1,$2,'joined',$3)`,
      [exam.id, userId, JSON.stringify({ code_used: code.toUpperCase() })]
    );

    res.json({ examId: exam.id, title: exam.title, duration: exam.duration_minutes });
  } catch (err) {
    console.error("Verify exam code error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────
// autosaveAnswers — CRITICAL: uses queryWithRetry
// ──────────────────────────────────────────────

export const autosaveAnswers = async (req, res) => {
  const { id: examId } = req.params;
  const userId = req.user.id;
  const { answers, module, timestamp, currentPart, currentWritingTask, timeSpent } = req.body;
  const parsedTs = new Date(timestamp || new Date().toISOString());
  const incomingTimestamp = Number.isNaN(parsedTs.getTime()) ? new Date().toISOString() : parsedTs.toISOString();

  try {
    // Single-query upsert: insert or update autosave, checking submission status
    // and stale timestamp all in one round trip.
    const { rows } = await queryWithRetry(
      `WITH submission_check AS (
        SELECT status FROM exam_submissions
        WHERE exam_id = $1 AND user_id = $2 LIMIT 1
      )
      INSERT INTO exam_autosaves (exam_id, user_id, answers_data, current_module, current_part,
        current_writing_task, time_spent, last_updated)
      SELECT $1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8::timestamptz
      WHERE NOT EXISTS (
        SELECT 1 FROM submission_check WHERE status IN ('submitted', 'auto_submitted')
      )
      ON CONFLICT (exam_id, user_id) DO UPDATE SET
        answers_data = EXCLUDED.answers_data,
        current_module = EXCLUDED.current_module,
        current_part = EXCLUDED.current_part,
        current_writing_task = EXCLUDED.current_writing_task,
        time_spent = EXCLUDED.time_spent,
        last_updated = EXCLUDED.last_updated
      WHERE exam_autosaves.last_updated <= EXCLUDED.last_updated
      RETURNING id, last_updated`,
      [examId, userId, JSON.stringify(answers), module, currentPart, currentWritingTask,
       timeSpent ? JSON.stringify(timeSpent) : '{}', incomingTimestamp]
    );

    if (rows.length === 0) {
      // Either exam was already submitted or timestamp was stale
      const { rows: subRows } = await pool.query(
        `SELECT status FROM exam_submissions WHERE exam_id=$1 AND user_id=$2 LIMIT 1`,
        [examId, userId]
      );
      if (subRows[0]?.status === "submitted" || subRows[0]?.status === "auto_submitted") {
        return res.status(409).json({ error: "Exam already submitted. Autosave is locked." });
      }
      return res.json({ message: "Ignored stale autosave", timestamp: incomingTimestamp, ignored: true });
    }

    res.json({ message: "Autosaved", timestamp: rows[0].last_updated });
  } catch (err) {
    console.error("Autosave error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────
// Misc
// ──────────────────────────────────────────────

export const logExamEvent = async (req, res) => {
  const { id: examId } = req.params;
  const userId = req.user.id;
  const { event_type, metadata } = req.body;
  try {
    await pool.query(
      `INSERT INTO monitoring_logs (exam_id, user_id, event_type, metadata, timestamp)
       VALUES ($1,$2,$3,$4,NOW())`,
      [examId, userId, event_type, JSON.stringify(metadata || {})]
    );
    res.json({ message: "Logged" });
  } catch (err) {
    console.error("Log event error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const checkExamStatus = async (req, res) => {
  const { id: examId } = req.params;
  const userId = req.user.id;
  try {
    const { rows: subRows } = await pool.query(
      `SELECT id, submitted_at FROM exam_submissions WHERE exam_id=$1 AND user_id=$2 LIMIT 1`,
      [examId, userId]
    );
    const submission = subRows[0] || null;

    const { rows: autoRows } = await pool.query(
      `SELECT * FROM exam_autosaves WHERE exam_id=$1 AND user_id=$2 LIMIT 1`,
      [examId, userId]
    );
    const autosave = autoRows[0] || null;

    res.json({
      submitted: !!submission,
      submission_id: submission?.id || null,
      submitted_at: submission?.submitted_at || null,
      has_autosave: !!autosave,
      autosave: autosave || null,
    });
  } catch (err) {
    console.error("Check exam status error:", err);
    res.status(500).json({ error: err.message });
  }
};
