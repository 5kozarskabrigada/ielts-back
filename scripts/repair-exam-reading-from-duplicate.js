import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

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

const args = process.argv.slice(2);
const getArg = (flag, fallback = null) => {
  const direct = args.find((arg) => arg.startsWith(`${flag}=`));
  if (!direct) return fallback;
  const value = direct.split("=").slice(1).join("=").trim();
  return value || fallback;
};

const sourceExamId = getArg("--source-id", "70c9c956-1358-4069-a053-10b4f8bd3b9d");
const targetExamId = getArg("--target-id", "0aa7d209-3ef6-4b3f-8002-9c4eb4c4d60e");

const run = async () => {
  console.log(`[repair-reading] source=${sourceExamId}`);
  console.log(`[repair-reading] target=${targetExamId}`);

  const { data: sourceExam, error: sourceExamError } = await supabase
    .from("exams")
    .select("id, title, modules_config")
    .eq("id", sourceExamId)
    .single();

  if (sourceExamError || !sourceExam) {
    throw new Error(`Failed to load source exam: ${sourceExamError?.message || "not found"}`);
  }

  const { data: targetExam, error: targetExamError } = await supabase
    .from("exams")
    .select("id, title, modules_config")
    .eq("id", targetExamId)
    .single();

  if (targetExamError || !targetExam) {
    throw new Error(`Failed to load target exam: ${targetExamError?.message || "not found"}`);
  }

  const { data: sourceSections, error: sourceSectionsError } = await supabase
    .from("exam_sections")
    .select("id, module_type, section_order, title, content, instruction, image_url, image_description, letter")
    .eq("exam_id", sourceExamId)
    .eq("module_type", "reading")
    .order("section_order", { ascending: true });

  if (sourceSectionsError) {
    throw new Error(`Failed to load source reading sections: ${sourceSectionsError.message}`);
  }

  const { data: targetSections, error: targetSectionsError } = await supabase
    .from("exam_sections")
    .select("id, module_type, section_order, title, content, instruction, image_url, image_description, letter")
    .eq("exam_id", targetExamId)
    .eq("module_type", "reading")
    .order("section_order", { ascending: true });

  if (targetSectionsError) {
    throw new Error(`Failed to load target reading sections: ${targetSectionsError.message}`);
  }

  const sourceReadingSections = Array.isArray(sourceSections) ? sourceSections : [];
  const targetReadingSections = Array.isArray(targetSections) ? targetSections : [];

  if (sourceReadingSections.length === 0) {
    throw new Error("Source exam has no reading sections to copy");
  }

  if (targetReadingSections.length === 0) {
    throw new Error("Target exam has no reading sections to map into");
  }

  const targetByOrder = new Map(targetReadingSections.map((section) => [Number(section.section_order), section]));
  const sourceToTargetSectionId = new Map();

  for (const sourceSection of sourceReadingSections) {
    const targetSection = targetByOrder.get(Number(sourceSection.section_order));
    if (!targetSection) {
      throw new Error(`Missing target reading section for order ${sourceSection.section_order}`);
    }

    sourceToTargetSectionId.set(sourceSection.id, targetSection.id);

    const { error: updateSectionError } = await supabase
      .from("exam_sections")
      .update({
        title: sourceSection.title,
        content: sourceSection.content,
        instruction: sourceSection.instruction,
        image_url: sourceSection.image_url,
        image_description: sourceSection.image_description,
        letter: sourceSection.letter,
      })
      .eq("id", targetSection.id);

    if (updateSectionError) {
      throw new Error(`Failed to update target reading section ${targetSection.id}: ${updateSectionError.message}`);
    }
  }

  const sourceReadingGroups = Array.isArray(sourceExam.modules_config?.reading_question_groups)
    ? sourceExam.modules_config.reading_question_groups
    : [];

  const groupIdMap = new Map();
  const remappedReadingGroups = sourceReadingGroups.map((group) => {
    const nextGroupId = uuidv4();
    groupIdMap.set(group.id, nextGroupId);
    return {
      ...group,
      id: nextGroupId,
      section_id: sourceToTargetSectionId.get(group.section_id) || group.section_id,
    };
  });

  const targetModulesConfig = targetExam.modules_config && typeof targetExam.modules_config === "object"
    ? { ...targetExam.modules_config }
    : {};

  targetModulesConfig.reading_question_groups = remappedReadingGroups;

  const { error: updateModulesError } = await supabase
    .from("exams")
    .update({ modules_config: targetModulesConfig })
    .eq("id", targetExamId);

  if (updateModulesError) {
    throw new Error(`Failed to update target modules_config: ${updateModulesError.message}`);
  }

  const sourceReadingSectionIds = sourceReadingSections.map((section) => section.id);
  const targetReadingSectionIds = targetReadingSections.map((section) => section.id);

  const { data: sourceQuestions, error: sourceQuestionsError } = await supabase
    .from("questions")
    .select("section_id, question_number, question_text, question_type, correct_answer, points, is_info_row, row_order, label_text, info_text, question_template, answer_alternatives, question_data")
    .eq("exam_id", sourceExamId)
    .in("section_id", sourceReadingSectionIds)
    .or("is_deleted.eq.false,is_deleted.is.null")
    .order("question_number", { ascending: true });

  if (sourceQuestionsError) {
    throw new Error(`Failed to load source reading questions: ${sourceQuestionsError.message}`);
  }

  const { error: clearTargetQuestionsError } = await supabase
    .from("questions")
    .delete()
    .eq("exam_id", targetExamId)
    .in("section_id", targetReadingSectionIds);

  if (clearTargetQuestionsError) {
    throw new Error(`Failed to clear target reading questions: ${clearTargetQuestionsError.message}`);
  }

  const findSourceGroupIdForQuestion = (question, preferredGroupId = null) => {
    if (preferredGroupId && groupIdMap.has(preferredGroupId)) {
      return preferredGroupId;
    }

    const questionNumber = Number(question.question_number);
    if (!Number.isFinite(questionNumber)) {
      return null;
    }

    const candidates = sourceReadingGroups.filter((group) => {
      if (group.section_id !== question.section_id) {
        return false;
      }

      const start = Number(group.question_range_start);
      const end = Number(group.question_range_end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return false;
      }

      return questionNumber >= start && questionNumber <= end;
    });

    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0].id;
    }

    const typeMatch = candidates.find((group) => group.question_type === question.question_type);
    if (typeMatch) {
      return typeMatch.id;
    }

    return candidates[0].id;
  };

  const rowsToInsert = (Array.isArray(sourceQuestions) ? sourceQuestions : []).map((question) => {
    const nextQuestionData = question.question_data && typeof question.question_data === "object"
      ? { ...question.question_data }
      : {};

    const sourceGroupId = findSourceGroupIdForQuestion(question, nextQuestionData.group_id);
    if (sourceGroupId && groupIdMap.has(sourceGroupId)) {
      nextQuestionData.group_id = groupIdMap.get(sourceGroupId);
    }

    return {
      exam_id: targetExamId,
      section_id: sourceToTargetSectionId.get(question.section_id) || question.section_id,
      question_number: question.question_number,
      question_text: question.question_text,
      question_type: question.question_type,
      correct_answer: question.correct_answer,
      points: question.points,
      is_info_row: question.is_info_row,
      row_order: question.row_order,
      label_text: question.label_text,
      info_text: question.info_text,
      question_template: question.question_template,
      answer_alternatives: question.answer_alternatives,
      question_data: nextQuestionData,
      is_deleted: false,
    };
  });

  if (rowsToInsert.length > 0) {
    const { error: insertQuestionsError } = await supabase
      .from("questions")
      .insert(rowsToInsert);

    if (insertQuestionsError) {
      throw new Error(`Failed to insert repaired reading questions: ${insertQuestionsError.message}`);
    }
  }

  console.log(`[repair-reading] Updated reading sections: ${sourceReadingSections.length}`);
  console.log(`[repair-reading] Copied reading groups: ${remappedReadingGroups.length}`);
  console.log(`[repair-reading] Copied reading questions: ${rowsToInsert.length}`);
  console.log("[repair-reading] Done.");
};

run().catch((error) => {
  console.error("[repair-reading] Fatal error:", error.message || error);
  process.exit(1);
});
