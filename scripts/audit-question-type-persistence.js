import { supabase } from "../supabaseClient.js";

const EXPECTED_LISTENING_TYPES = [
  "multiple_choice",
  "multiple_choice_multiple",
  "matching",
  "form_completion",
  "sentence_completion",
  "note_completion",
  "summary_completion",
  "map_labeling",
  "short_answer",
];

const EXPECTED_READING_TYPES = [
  "multiple_choice_single",
  "multiple_choice_multiple",
  "true_false_not_given",
  "yes_no_not_given",
  "matching_headings",
  "matching_information",
  "matching_features",
  "matching_sentence_endings",
  "summary_completion",
  "sentence_completion",
  "table_completion",
  "diagram_labeling",
  "short_answer",
];

const EXPECTED_TYPES = [...new Set([...EXPECTED_LISTENING_TYPES, ...EXPECTED_READING_TYPES])];
const EXPECTED_TYPE_SET = new Set(EXPECTED_TYPES);

const normalizeType = (value) => String(value || "").trim().toLowerCase();

const getGroupsForExam = (modulesConfig = {}) => {
  const listeningGroups = Array.isArray(modulesConfig.listening_question_groups)
    ? modulesConfig.listening_question_groups
    : [];
  const readingGroups = Array.isArray(modulesConfig.reading_question_groups)
    ? modulesConfig.reading_question_groups
    : [];

  return [...listeningGroups, ...readingGroups].filter((group) => group && typeof group === "object");
};

const run = async () => {
  const summary = {
    expected_types: EXPECTED_TYPES,
    exams_scanned: 0,
    group_types_found: {},
    question_types_found: {},
    unknown_group_types: {},
    unknown_question_types: {},
    groups_without_questions: 0,
    questions_with_orphan_group_id: 0,
    question_type_mismatches_against_group: 0,
    mismatch_samples: [],
  };

  const { data: exams, error: examError } = await supabase
    .from("exams")
    .select("id, title, status, is_deleted, modules_config");

  if (examError) {
    throw new Error(`Failed to load exams: ${examError.message}`);
  }

  const activeExams = (exams || []).filter((exam) => exam.status !== "deleted" && exam.is_deleted !== true);
  summary.exams_scanned = activeExams.length;

  for (const exam of activeExams) {
    const { data: questions, error: questionsError } = await supabase
      .from("questions")
      .select("id, section_id, question_number, question_type, question_data")
      .eq("exam_id", exam.id)
      .or("is_deleted.eq.false,is_deleted.is.null");

    if (questionsError) {
      throw new Error(`Failed to load questions for exam ${exam.id}: ${questionsError.message}`);
    }

    const questionRows = Array.isArray(questions) ? questions : [];
    const groups = getGroupsForExam(exam.modules_config || {});

    const groupById = new Map();
    const groupsBySection = new Map();

    for (const group of groups) {
      const normalizedType = normalizeType(group.question_type);
      if (!normalizedType) continue;

      summary.group_types_found[normalizedType] = (summary.group_types_found[normalizedType] || 0) + 1;
      if (!EXPECTED_TYPE_SET.has(normalizedType)) {
        summary.unknown_group_types[normalizedType] = (summary.unknown_group_types[normalizedType] || 0) + 1;
      }

      if (group.id) {
        groupById.set(group.id, group);
      }

      if (!groupsBySection.has(group.section_id)) {
        groupsBySection.set(group.section_id, []);
      }
      groupsBySection.get(group.section_id).push(group);
    }

    for (const sectionGroups of groupsBySection.values()) {
      sectionGroups.sort((a, b) => Number(a.question_range_start || 0) - Number(b.question_range_start || 0));
    }

    for (const question of questionRows) {
      const normalizedQuestionType = normalizeType(question.question_type);
      if (normalizedQuestionType) {
        summary.question_types_found[normalizedQuestionType] = (summary.question_types_found[normalizedQuestionType] || 0) + 1;
        if (!EXPECTED_TYPE_SET.has(normalizedQuestionType)) {
          summary.unknown_question_types[normalizedQuestionType] = (summary.unknown_question_types[normalizedQuestionType] || 0) + 1;
        }
      }

      const questionGroupId = question?.question_data?.group_id || null;
      let matchedGroup = null;

      if (questionGroupId && groupById.has(questionGroupId)) {
        matchedGroup = groupById.get(questionGroupId);
      } else if (questionGroupId && !groupById.has(questionGroupId)) {
        summary.questions_with_orphan_group_id += 1;
      }

      if (!matchedGroup) {
        const sectionGroups = groupsBySection.get(question.section_id) || [];
        const qNum = Number(question.question_number || 0);
        matchedGroup = sectionGroups.find((group) => {
          const start = Number(group.question_range_start);
          const end = Number(group.question_range_end);
          if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
          return qNum >= start && qNum <= end;
        }) || null;
      }

      if (matchedGroup) {
        const groupType = normalizeType(matchedGroup.question_type);
        if (groupType && normalizedQuestionType && groupType !== normalizedQuestionType) {
          summary.question_type_mismatches_against_group += 1;
          if (summary.mismatch_samples.length < 25) {
            summary.mismatch_samples.push({
              exam_id: exam.id,
              exam_title: exam.title,
              question_id: question.id,
              question_number: question.question_number,
              section_id: question.section_id,
              group_id: matchedGroup.id,
              group_type: groupType,
              question_type: normalizedQuestionType,
            });
          }
        }
      }
    }

    for (const group of groups) {
      const start = Number(group.question_range_start);
      const end = Number(group.question_range_end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

      const inRangeQuestions = questionRows.filter((question) => {
        const qNum = Number(question.question_number || 0);
        return question.section_id === group.section_id && qNum >= start && qNum <= end;
      });

      if (inRangeQuestions.length === 0) {
        summary.groups_without_questions += 1;
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
};

run().catch((error) => {
  console.error("[audit-question-type-persistence] Fatal error:", error.message || error);
  process.exit(1);
});
