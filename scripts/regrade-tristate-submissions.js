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

const PAGE_SIZE = 500;
const IN_QUERY_CHUNK_SIZE = 120;
const TRI_STATE_TYPES = new Set(["true_false_not_given", "yes_no_not_given"]);

const toNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const roundToHalf = (value) => Math.round((Number(value) || 0) * 2) / 2;

const chunkArray = (arr, chunkSize) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
};

const parseMultiAnswerArray = (value) => {
  if (value === undefined || value === null) return [];

  const str = String(value).trim().toUpperCase();
  if (!str) return [];

  if (str.includes("/")) {
    return str.split("/").map((item) => item.trim()).filter(Boolean);
  }

  if (str.includes(",")) {
    return str.split(",").map((item) => item.trim()).filter(Boolean);
  }

  if (/^[A-Z]+$/.test(str)) {
    return str.split("").filter(Boolean);
  }

  return [str];
};

const normalizeStoredToken = (value) => {
  if (value === undefined || value === null) return "";

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase().replace(/\s+/g, "_");
  }

  return String(value).trim().toLowerCase().replace(/\s+/g, "_");
};

const normalizeTriStateAnswer = (value, questionType = "") => {
  const normalizedType = String(questionType || "").trim().toLowerCase();
  const normalized = normalizeStoredToken(value);

  if (!normalized) return "";

  if (normalized === "not_given" || normalized === "notgiven" || normalized === "ng") {
    return "not_given";
  }

  if (normalizedType === "yes_no_not_given") {
    if (normalized === "yes" || normalized === "y" || normalized === "true" || normalized === "t") return "yes";
    if (normalized === "no" || normalized === "n" || normalized === "false" || normalized === "f") return "no";
    return normalized;
  }

  if (normalizedType === "true_false_not_given") {
    if (normalized === "true" || normalized === "t" || normalized === "yes" || normalized === "y") return "true";
    if (normalized === "false" || normalized === "f" || normalized === "no" || normalized === "n") return "false";
    return normalized;
  }

  return normalized;
};

const parseAlternatives = (value) => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[\/|]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const getQuestionMaxPoints = (question) => {
  const questionType = String(question?.question_type || "").trim().toLowerCase();
  if (questionType === "multiple_choice_multiple") {
    const correctAnswers = parseMultiAnswerArray(question?.correct_answer);
    return Math.max(1, correctAnswers.length);
  }

  return Number(question?.points) || 1;
};

const getEffectiveAnswerScore = (answerRow) => {
  const overrideScore = toNumberOrNull(answerRow?.admin_override_score);
  if (overrideScore !== null) return overrideScore;

  const baseScore = toNumberOrNull(answerRow?.score);
  return baseScore !== null ? baseScore : 0;
};

const fetchAllTriStateQuestions = async () => {
  const questions = [];
  let from = 0;
  let supportsIsDeletedFilter = true;

  while (true) {
    let query = supabase
      .from("questions")
      .select("id, exam_id, section_id, module_type, question_type, correct_answer, answer_alternatives, points")
      .in("question_type", Array.from(TRI_STATE_TYPES))
      .range(from, from + PAGE_SIZE - 1);

    if (supportsIsDeletedFilter) {
      query = query.neq("is_deleted", true);
    }

    const { data, error } = await query;

    if (error) {
      if (supportsIsDeletedFilter && error.code === "42703") {
        supportsIsDeletedFilter = false;
        from = 0;
        questions.length = 0;
        continue;
      }
      throw error;
    }

    if (!data || data.length === 0) break;

    questions.push(...data);

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return questions;
};

const fetchAnswersByQuestionIds = async (questionIds) => {
  const rows = [];
  const idChunks = chunkArray(questionIds, IN_QUERY_CHUNK_SIZE);

  for (const idChunk of idChunks) {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("answers")
        .select("id, submission_id, question_id, user_answer, is_correct, score, admin_override_correct, admin_override_score")
        .in("question_id", idChunk)
        .range(from, from + PAGE_SIZE - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;

      rows.push(...data);

      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  return rows;
};

const fetchSubmissionsByIds = async (submissionIds) => {
  const submissions = [];
  const idChunks = chunkArray(submissionIds, IN_QUERY_CHUNK_SIZE);

  for (const idChunk of idChunks) {
    const { data, error } = await supabase
      .from("exam_submissions")
      .select("id, exam_id, answers")
      .in("id", idChunk);

    if (error) throw error;
    if (data?.length) submissions.push(...data);
  }

  return submissions;
};

const examQuestionCache = new Map();
const examSectionModuleCache = new Map();

const fetchExamSectionModuleMap = async (examId) => {
  if (examSectionModuleCache.has(examId)) {
    return examSectionModuleCache.get(examId);
  }

  const { data, error } = await supabase
    .from("exam_sections")
    .select("id, module_type")
    .eq("exam_id", examId);

  if (error) throw error;

  const moduleMap = new Map((data || []).map((section) => [section.id, section.module_type]));
  examSectionModuleCache.set(examId, moduleMap);
  return moduleMap;
};

const fetchExamQuestions = async (examId) => {
  if (examQuestionCache.has(examId)) {
    return examQuestionCache.get(examId);
  }

  const fields = "id, section_id, module_type, question_type, correct_answer, points";
  let supportsIsDeletedFilter = true;

  let response = await supabase
    .from("questions")
    .select(fields)
    .eq("exam_id", examId)
    .neq("is_deleted", true);

  if (response.error && response.error.code === "42703") {
    supportsIsDeletedFilter = false;
    response = await supabase
      .from("questions")
      .select(fields)
      .eq("exam_id", examId);
  }

  if (response.error) throw response.error;

  const questions = response.data || [];

  if (!supportsIsDeletedFilter || questions.some((q) => !q.module_type)) {
    const sectionModuleMap = await fetchExamSectionModuleMap(examId);
    questions.forEach((question) => {
      if (!question.module_type && question.section_id && sectionModuleMap.has(question.section_id)) {
        question.module_type = sectionModuleMap.get(question.section_id);
      }
    });
  }

  examQuestionCache.set(examId, questions);
  return questions;
};

const fetchSubmissionAnswers = async (submissionId) => {
  const { data, error } = await supabase
    .from("answers")
    .select("id, question_id, is_correct, score, admin_override_correct, admin_override_score")
    .eq("submission_id", submissionId);

  if (error) throw error;
  return data || [];
};

const buildSubmissionMetrics = (examQuestions, submissionAnswers) => {
  const answerByQuestionId = new Map();

  for (const answerRow of submissionAnswers) {
    if (!answerRow?.question_id) continue;

    const existing = answerByQuestionId.get(answerRow.question_id);
    if (!existing) {
      answerByQuestionId.set(answerRow.question_id, answerRow);
      continue;
    }

    const existingScore = getEffectiveAnswerScore(existing);
    const nextScore = getEffectiveAnswerScore(answerRow);
    if (nextScore > existingScore) {
      answerByQuestionId.set(answerRow.question_id, answerRow);
    }
  }

  const moduleScores = {
    listening: { correct: 0, total: 0 },
    reading: { correct: 0, total: 0 },
    writing: { correct: 0, total: 0 }
  };

  let totalScore = 0;
  let totalPoints = 0;

  for (const question of examQuestions) {
    const moduleType = String(question.module_type || "").toLowerCase();
    const questionPoints = getQuestionMaxPoints(question);

    totalPoints += questionPoints;

    if (moduleScores[moduleType]) {
      moduleScores[moduleType].total += questionPoints;
    }

    const answerRow = answerByQuestionId.get(question.id);
    const effectiveScore = answerRow ? getEffectiveAnswerScore(answerRow) : 0;

    totalScore += effectiveScore;

    if (moduleScores[moduleType]) {
      moduleScores[moduleType].correct += effectiveScore;
    }
  }

  const scoresByModule = {
    listening: moduleScores.listening.total > 0 ? roundToHalf((moduleScores.listening.correct / moduleScores.listening.total) * 9) : 0,
    reading: moduleScores.reading.total > 0 ? roundToHalf((moduleScores.reading.correct / moduleScores.reading.total) * 9) : 0,
    writing: moduleScores.writing.total > 0 ? roundToHalf((moduleScores.writing.correct / moduleScores.writing.total) * 9) : 0,
  };

  const overallBandScore = totalPoints > 0 ? roundToHalf((totalScore / totalPoints) * 9) : 0;

  return {
    totalScore,
    totalQuestions: examQuestions.length,
    scoresByModule,
    overallBandScore,
  };
};

const run = async () => {
  console.log(`[regrade-tristate-submissions] Mode: ${isApplyMode ? "APPLY" : "DRY RUN"}`);

  const triStateQuestions = await fetchAllTriStateQuestions();
  console.log(`[regrade-tristate-submissions] Tri-state questions found: ${triStateQuestions.length}`);

  if (triStateQuestions.length === 0) {
    console.log("[regrade-tristate-submissions] Nothing to regrade.");
    return;
  }

  const triStateQuestionById = new Map(
    triStateQuestions.map((question) => [question.id, question])
  );

  const triStateQuestionIds = triStateQuestions.map((question) => question.id);
  const triStateAnswerRows = await fetchAnswersByQuestionIds(triStateQuestionIds);

  console.log(`[regrade-tristate-submissions] Tri-state answer rows scanned: ${triStateAnswerRows.length}`);

  const updatesBySubmission = new Map();

  let skippedAdminOverrideRows = 0;
  let candidateAnswerUpdates = 0;

  for (const answerRow of triStateAnswerRows) {
    const question = triStateQuestionById.get(answerRow.question_id);
    if (!question) continue;

    const hasAdminOverride = answerRow.admin_override_correct !== null || answerRow.admin_override_score !== null;
    if (hasAdminOverride) {
      skippedAdminOverrideRows += 1;
      continue;
    }

    const normalizedUserAnswer = normalizeTriStateAnswer(answerRow.user_answer, question.question_type);
    if (!normalizedUserAnswer) continue;

    const normalizedCorrectAnswer = normalizeTriStateAnswer(question.correct_answer, question.question_type);
    const normalizedAlternatives = parseAlternatives(question.answer_alternatives)
      .map((alt) => normalizeTriStateAnswer(alt, question.question_type))
      .filter(Boolean);

    const shouldBeCorrect = Boolean(
      (normalizedCorrectAnswer && normalizedUserAnswer === normalizedCorrectAnswer)
      || normalizedAlternatives.includes(normalizedUserAnswer)
    );

    const questionPoints = Number(question.points) || 1;
    const shouldBeScore = shouldBeCorrect ? questionPoints : 0;

    const currentIsCorrect = Boolean(answerRow.is_correct);
    const currentScore = toNumberOrNull(answerRow.score) || 0;
    const currentStoredToken = normalizeStoredToken(answerRow.user_answer);

    const needsUpdate = (
      currentStoredToken !== normalizedUserAnswer
      || currentIsCorrect !== shouldBeCorrect
      || currentScore !== shouldBeScore
    );

    if (!needsUpdate) continue;

    candidateAnswerUpdates += 1;

    const submissionId = answerRow.submission_id;
    if (!updatesBySubmission.has(submissionId)) {
      updatesBySubmission.set(submissionId, {
        submissionId,
        examId: question.exam_id,
        answerUpdates: [],
      });
    }

    updatesBySubmission.get(submissionId).answerUpdates.push({
      answerId: answerRow.id,
      questionId: answerRow.question_id,
      normalizedUserAnswer,
      shouldBeCorrect,
      shouldBeScore,
    });
  }

  const affectedSubmissionIds = Array.from(updatesBySubmission.keys());

  console.log(`[regrade-tristate-submissions] Candidate answer updates: ${candidateAnswerUpdates}`);
  console.log(`[regrade-tristate-submissions] Submissions affected: ${affectedSubmissionIds.length}`);
  console.log(`[regrade-tristate-submissions] Rows skipped due to admin overrides: ${skippedAdminOverrideRows}`);

  if (affectedSubmissionIds.length === 0) {
    console.log("[regrade-tristate-submissions] No affected submissions found.");
    return;
  }

  const submissions = await fetchSubmissionsByIds(affectedSubmissionIds);
  const submissionById = new Map(submissions.map((submission) => [submission.id, submission]));

  let appliedAnswerUpdates = 0;
  let appliedSubmissionUpdates = 0;

  for (const submissionId of affectedSubmissionIds) {
    const submissionEntry = updatesBySubmission.get(submissionId);
    const submission = submissionById.get(submissionId);

    if (!submission || !submissionEntry) continue;

    const answerUpdates = submissionEntry.answerUpdates;

    let normalizedSubmissionAnswers = null;
    let answersJsonChanged = false;

    const rawAnswers = submission.answers;
    if (rawAnswers && typeof rawAnswers === "object" && !Array.isArray(rawAnswers)) {
      normalizedSubmissionAnswers = { ...rawAnswers };

      for (const answerUpdate of answerUpdates) {
        if (!Object.prototype.hasOwnProperty.call(normalizedSubmissionAnswers, answerUpdate.questionId)) continue;

        const currentValue = normalizedSubmissionAnswers[answerUpdate.questionId];
        const currentToken = normalizeStoredToken(currentValue);
        if (currentToken !== answerUpdate.normalizedUserAnswer) {
          normalizedSubmissionAnswers[answerUpdate.questionId] = answerUpdate.normalizedUserAnswer;
          answersJsonChanged = true;
        }
      }
    }

    if (isApplyMode) {
      for (const answerUpdate of answerUpdates) {
        const { error: updateAnswerError } = await supabase
          .from("answers")
          .update({
            user_answer: answerUpdate.normalizedUserAnswer,
            is_correct: answerUpdate.shouldBeCorrect,
            score: answerUpdate.shouldBeScore,
          })
          .eq("id", answerUpdate.answerId);

        if (updateAnswerError) {
          console.error(
            `[regrade-tristate-submissions] Failed to update answer ${answerUpdate.answerId}:`,
            updateAnswerError.message
          );
          continue;
        }

        appliedAnswerUpdates += 1;
      }

      const examQuestions = await fetchExamQuestions(submission.exam_id);
      const submissionAnswers = await fetchSubmissionAnswers(submission.id);

      const metrics = buildSubmissionMetrics(examQuestions, submissionAnswers);

      const submissionPayload = {
        total_correct: metrics.totalScore,
        total_questions: metrics.totalQuestions,
        scores_by_module: metrics.scoresByModule,
        band_score: metrics.overallBandScore,
        overall_band_score: metrics.overallBandScore,
      };

      if (answersJsonChanged && normalizedSubmissionAnswers) {
        submissionPayload.answers = normalizedSubmissionAnswers;
      }

      const { error: updateSubmissionError } = await supabase
        .from("exam_submissions")
        .update(submissionPayload)
        .eq("id", submission.id);

      if (updateSubmissionError) {
        console.error(
          `[regrade-tristate-submissions] Failed to update submission ${submission.id}:`,
          updateSubmissionError.message
        );
      } else {
        appliedSubmissionUpdates += 1;
      }
    }
  }

  if (isApplyMode) {
    console.log(`[regrade-tristate-submissions] Applied answer updates: ${appliedAnswerUpdates}`);
    console.log(`[regrade-tristate-submissions] Applied submission updates: ${appliedSubmissionUpdates}`);
  } else {
    console.log("[regrade-tristate-submissions] Dry run complete. Re-run with --apply to persist updates.");
  }
};

run().catch((error) => {
  console.error("[regrade-tristate-submissions] Fatal error:", error);
  process.exit(1);
});
