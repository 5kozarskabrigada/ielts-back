import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const isApplyMode = process.argv.includes("--apply");

const parseQuestionData = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
};

const normalizeMultiCorrectAnswer = (value) => {
  if (value === undefined || value === null) return "";

  const raw = String(value).trim().toUpperCase();
  if (!raw) return "";

  let tokens = [];
  if (raw.includes("/")) {
    tokens = raw.split("/");
  } else if (raw.includes(",")) {
    tokens = raw.split(",");
  } else if (/^[A-Z]+$/.test(raw) && raw.length > 1) {
    tokens = raw.split("");
  } else {
    tokens = raw.split(/\s+/);
  }

  const normalized = [...new Set(tokens.map(token => token.trim()).filter(Boolean))]
    .sort()
    .join("/");

  return normalized;
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const extractQuestionGroups = (modulesConfig) => {
  const config = modulesConfig && typeof modulesConfig === "object" ? modulesConfig : {};
  const listeningGroups = Array.isArray(config.listening_question_groups) ? config.listening_question_groups : [];
  const readingGroups = Array.isArray(config.reading_question_groups) ? config.reading_question_groups : [];
  return [...listeningGroups, ...readingGroups].filter(group => group && typeof group === "object");
};

const getTargetTypeForQuestion = (question, groupsById, rangedGroups) => {
  const questionData = parseQuestionData(question.question_data);
  const groupId = questionData.group_id || questionData.groupId || null;

  if (groupId && groupsById.has(groupId)) {
    return groupsById.get(groupId);
  }

  const qSectionId = question.section_id;
  const qNumber = toNumber(question.question_number);
  if (!qSectionId || qNumber === null) return null;

  const candidates = rangedGroups.filter(group =>
    group.section_id === qSectionId
    && group.start !== null
    && group.end !== null
    && qNumber >= group.start
    && qNumber <= group.end
  );

  if (candidates.length === 1) {
    return candidates[0].question_type;
  }

  return null;
};

const fetchAllExams = async () => {
  const allExams = [];
  const pageSize = 200;
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("exams")
      .select("id, modules_config")
      .range(from, to);

    if (error) throw error;

    if (!data || data.length === 0) break;
    allExams.push(...data);

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allExams;
};

const fetchExamQuestions = async (examId) => {
  let response = await supabase
    .from("questions")
    .select("id, exam_id, section_id, question_number, question_type, correct_answer, question_data")
    .eq("exam_id", examId)
    .neq("is_deleted", true);

  if (response.error && response.error.code === "42703") {
    response = await supabase
      .from("questions")
      .select("id, exam_id, section_id, question_number, question_type, correct_answer, question_data")
      .eq("exam_id", examId);
  }

  if (response.error) throw response.error;
  return response.data || [];
};

const run = async () => {
  console.log(`[normalize-question-types] Mode: ${isApplyMode ? "APPLY" : "DRY RUN"}`);

  const exams = await fetchAllExams();
  console.log(`[normalize-question-types] Found ${exams.length} exams`);

  let scannedQuestions = 0;
  let suggestedUpdates = 0;
  let appliedUpdates = 0;

  for (const exam of exams) {
    const groups = extractQuestionGroups(exam.modules_config);
    if (groups.length === 0) continue;

    const groupsById = new Map();
    const rangedGroups = [];

    groups.forEach(group => {
      if (group.id && group.question_type) {
        groupsById.set(group.id, group.question_type);
      }

      const start = toNumber(group.question_range_start);
      const end = toNumber(group.question_range_end);
      if (group.section_id && group.question_type && start !== null && end !== null) {
        rangedGroups.push({
          section_id: group.section_id,
          question_type: group.question_type,
          start,
          end,
        });
      }
    });

    const questions = await fetchExamQuestions(exam.id);
    scannedQuestions += questions.length;

    const updatesForExam = [];

    questions.forEach(question => {
      const targetType = getTargetTypeForQuestion(question, groupsById, rangedGroups);
      if (!targetType) return;

      const payload = {};

      if (question.question_type !== targetType) {
        payload.question_type = targetType;
      }

      if (targetType === "multiple_choice_multiple") {
        const normalizedAnswer = normalizeMultiCorrectAnswer(question.correct_answer);
        const currentAnswer = String(question.correct_answer || "").trim().toUpperCase();
        if (normalizedAnswer !== currentAnswer) {
          payload.correct_answer = normalizedAnswer;
        }
      }

      if (Object.keys(payload).length > 0) {
        updatesForExam.push({ id: question.id, payload });
      }
    });

    if (updatesForExam.length === 0) continue;

    suggestedUpdates += updatesForExam.length;
    console.log(`[normalize-question-types] Exam ${exam.id}: ${updatesForExam.length} updates`);

    if (isApplyMode) {
      for (const update of updatesForExam) {
        const { error } = await supabase
          .from("questions")
          .update(update.payload)
          .eq("id", update.id);

        if (error) {
          console.error(`[normalize-question-types] Failed to update question ${update.id}:`, error.message);
          continue;
        }

        appliedUpdates += 1;
      }
    }
  }

  console.log(`[normalize-question-types] Scanned questions: ${scannedQuestions}`);
  console.log(`[normalize-question-types] Suggested updates: ${suggestedUpdates}`);

  if (isApplyMode) {
    console.log(`[normalize-question-types] Applied updates: ${appliedUpdates}`);
  } else {
    console.log("[normalize-question-types] Dry run complete. Re-run with --apply to persist changes.");
  }
};

run().catch((error) => {
  console.error("[normalize-question-types] Fatal error:", error);
  process.exit(1);
});
