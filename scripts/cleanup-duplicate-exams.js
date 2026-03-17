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

const args = process.argv.slice(2);
const isApplyMode = args.includes("--apply");
const includeActive = args.includes("--include-active");
const forceWithSubmissions = args.includes("--force-with-submissions");

const getNumberArg = (flag, fallback) => {
  const direct = args.find((arg) => arg.startsWith(`${flag}=`));
  if (!direct) return fallback;
  const value = Number(direct.split("=")[1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const windowMinutes = getNumberArg("--window-minutes", 90);
const windowMs = windowMinutes * 60 * 1000;

const normalizeTitle = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
const toTimestamp = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const fetchAllExams = async () => {
  const allExams = [];
  const pageSize = 500;
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("exams")
      .select("id, title, description, status, is_deleted, created_by, created_at, updated_at, modules_config")
      .range(from, to)
      .order("created_at", { ascending: true });

    if (error) throw error;
    if (!data || data.length === 0) break;

    allExams.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allExams;
};

const fetchCount = async (table, examId, filterDeletedQuestions = false) => {
  let query = supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("exam_id", examId);

  if (table === "questions" && filterDeletedQuestions) {
    query = query.neq("is_deleted", true);
  }

  const { count, error } = await query;

  if (error && table === "questions" && filterDeletedQuestions && error.code === "42703") {
    const fallback = await supabase
      .from("questions")
      .select("id", { count: "exact", head: true })
      .eq("exam_id", examId);

    if (fallback.error) throw fallback.error;
    return fallback.count || 0;
  }

  if (error) throw error;
  return count || 0;
};

const enrichExam = async (exam) => {
  const [sectionCount, questionCount, submissionCount] = await Promise.all([
    fetchCount("exam_sections", exam.id),
    fetchCount("questions", exam.id, true),
    fetchCount("exam_submissions", exam.id),
  ]);

  const hasModuleConfig = exam.modules_config && typeof exam.modules_config === "object" && Object.keys(exam.modules_config).length > 0;
  const statusScore = exam.status === "active" ? 5 : exam.status === "draft" ? 2 : 1;
  const score = (questionCount * 12) + (sectionCount * 4) + (submissionCount * 25) + statusScore + (hasModuleConfig ? 1 : 0);

  return {
    ...exam,
    sectionCount,
    questionCount,
    submissionCount,
    score,
  };
};

const buildDuplicateClusters = (exams) => {
  const candidates = exams.filter((exam) => {
    const notDeleted = !exam.is_deleted && exam.status !== "deleted";
    return notDeleted && normalizeTitle(exam.title).length > 0;
  });

  const grouped = new Map();
  candidates.forEach((exam) => {
    const key = `${exam.created_by || "unknown"}::${normalizeTitle(exam.title)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(exam);
  });

  const clusters = [];
  for (const [, groupExams] of grouped.entries()) {
    const sorted = [...groupExams].sort((a, b) => toTimestamp(a.created_at) - toTimestamp(b.created_at));
    if (sorted.length < 2) continue;

    let currentCluster = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      const diff = Math.abs(toTimestamp(current.created_at) - toTimestamp(previous.created_at));

      if (diff <= windowMs) {
        currentCluster.push(current);
      } else {
        if (currentCluster.length > 1) clusters.push(currentCluster);
        currentCluster = [current];
      }
    }

    if (currentCluster.length > 1) clusters.push(currentCluster);
  }

  return clusters;
};

const selectKeeperAndDuplicates = (cluster) => {
  const ranked = [...cluster].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const updatedDiff = toTimestamp(b.updated_at) - toTimestamp(a.updated_at);
    if (updatedDiff !== 0) return updatedDiff;
    return toTimestamp(b.created_at) - toTimestamp(a.created_at);
  });

  return {
    keeper: ranked[0],
    duplicates: ranked.slice(1),
  };
};

const markAsDeleted = async (examId) => {
  const payload = {
    status: "deleted",
    is_deleted: true,
  };

  let response = await supabase
    .from("exams")
    .update(payload)
    .eq("id", examId)
    .select("id")
    .maybeSingle();

  if (response.error && response.error.code === "42703") {
    response = await supabase
      .from("exams")
      .update({ status: "deleted" })
      .eq("id", examId)
      .select("id")
      .maybeSingle();
  }

  if (response.error) throw response.error;
};

const run = async () => {
  console.log(`[cleanup-duplicate-exams] Mode: ${isApplyMode ? "APPLY" : "DRY RUN"}`);
  console.log(`[cleanup-duplicate-exams] Window: ${windowMinutes} minutes`);
  console.log(`[cleanup-duplicate-exams] includeActive=${includeActive} forceWithSubmissions=${forceWithSubmissions}`);

  const exams = await fetchAllExams();
  const clusters = buildDuplicateClusters(exams);

  if (clusters.length === 0) {
    console.log("[cleanup-duplicate-exams] No duplicate clusters found.");
    return;
  }

  console.log(`[cleanup-duplicate-exams] Found ${clusters.length} potential duplicate cluster(s).`);

  let totalDuplicateCandidates = 0;
  let totalApplied = 0;
  let totalSkipped = 0;

  for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
    const cluster = clusters[clusterIndex];
    const enrichedCluster = [];

    for (const exam of cluster) {
      const enriched = await enrichExam(exam);
      enrichedCluster.push(enriched);
    }

    const { keeper, duplicates } = selectKeeperAndDuplicates(enrichedCluster);
    totalDuplicateCandidates += duplicates.length;

    console.log(`\n[Cluster ${clusterIndex + 1}] title="${keeper.title}" creator="${keeper.created_by || "unknown"}"`);
    console.log(`  Keep: ${keeper.id} | created=${keeper.created_at} | status=${keeper.status} | sections=${keeper.sectionCount} questions=${keeper.questionCount} submissions=${keeper.submissionCount} score=${keeper.score}`);

    for (const duplicate of duplicates) {
      const shouldSkipForActive = duplicate.status === "active" && !includeActive;
      const shouldSkipForSubmission = duplicate.submissionCount > 0 && !forceWithSubmissions;
      const willSkip = shouldSkipForActive || shouldSkipForSubmission;

      console.log(`  Duplicate: ${duplicate.id} | created=${duplicate.created_at} | status=${duplicate.status} | sections=${duplicate.sectionCount} questions=${duplicate.questionCount} submissions=${duplicate.submissionCount} score=${duplicate.score}${willSkip ? " | SKIP" : " | DELETE"}`);

      if (!isApplyMode) continue;

      if (willSkip) {
        totalSkipped += 1;
        continue;
      }

      await markAsDeleted(duplicate.id);
      totalApplied += 1;
    }
  }

  console.log(`\n[cleanup-duplicate-exams] Duplicate candidates: ${totalDuplicateCandidates}`);
  if (isApplyMode) {
    console.log(`[cleanup-duplicate-exams] Applied deletions: ${totalApplied}`);
    console.log(`[cleanup-duplicate-exams] Skipped: ${totalSkipped}`);
  } else {
    console.log("[cleanup-duplicate-exams] Dry run complete. Re-run with --apply to soft-delete duplicates.");
    console.log("[cleanup-duplicate-exams] Optional flags: --include-active --force-with-submissions --window-minutes=<N>");
  }
};

run().catch((error) => {
  console.error("[cleanup-duplicate-exams] Fatal error:", error);
  process.exit(1);
});
