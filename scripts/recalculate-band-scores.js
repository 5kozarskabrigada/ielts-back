/**
 * Recalculate module-wise band scores for submissions that were re-graded.
 * 
 * For each submission:
 * 1. Fetch all answers joined with questions → exam_sections to get module_type
 * 2. Group by module, compute correct/total per module
 * 3. Apply band formula: Math.round((correct/total) * 9 * 2) / 2
 * 4. Compute overall band: Math.round((totalCorrect/totalQuestions) * 9 * 2) / 2
 * 5. Update scores_by_module, overall_band_score, band_score
 */

import { supabase } from '../supabaseClient.js';

const SUBMISSION_IDS = [
  '29dfa646-9021-49c3-8e55-2307b5c9d292',
  '460222bd-3683-4875-a196-aeb019ac426e',
  'e0794bff-ffce-458f-8dfc-c8dcfc0004f8',
];

async function recalculate() {
  for (const subId of SUBMISSION_IDS) {
    console.log(`\n--- Submission ${subId} ---`);

    // Fetch all answers for this submission, joined with question → exam_section
    const { data: answers, error } = await supabase
      .from('answers')
      .select('id, question_id, is_correct, score, questions!inner(id, exam_sections!inner(module_type))')
      .eq('submission_id', subId);

    if (error) {
      console.error(`Error fetching answers for ${subId}:`, error.message);
      continue;
    }

    console.log(`  Found ${answers.length} answers`);

    // Group by module
    const moduleScores = {};
    let totalCorrect = 0;
    let totalQuestions = 0;

    for (const ans of answers) {
      const moduleType = ans.questions?.exam_sections?.module_type || 'unknown';
      if (!moduleScores[moduleType]) {
        moduleScores[moduleType] = { correct: 0, total: 0 };
      }
      moduleScores[moduleType].total += 1;
      totalQuestions += 1;
      if (ans.score > 0) {
        moduleScores[moduleType].correct += ans.score;
        totalCorrect += ans.score;
      }
    }

    // Calculate per-module band scores
    const scoresByModule = {};
    for (const [module, data] of Object.entries(moduleScores)) {
      if (data.total > 0) {
        const pct = data.correct / data.total;
        scoresByModule[module] = Math.round(pct * 9 * 2) / 2;
      } else {
        scoresByModule[module] = 0;
      }
      console.log(`  ${module}: ${data.correct}/${data.total} → band ${scoresByModule[module]}`);
    }

    // Overall band
    const overallBand = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 9 : 0;
    const roundedBand = Math.round(overallBand * 2) / 2;
    console.log(`  Overall: ${totalCorrect}/${totalQuestions} → band ${roundedBand}`);

    // Update
    const { error: updateError } = await supabase
      .from('exam_submissions')
      .update({
        scores_by_module: scoresByModule,
        overall_band_score: roundedBand,
        band_score: roundedBand,
        total_correct: totalCorrect,
        total_questions: totalQuestions,
      })
      .eq('id', subId);

    if (updateError) {
      console.error(`  Error updating ${subId}:`, updateError.message);
    } else {
      console.log(`  ✓ Updated successfully`);
    }
  }
}

recalculate().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
