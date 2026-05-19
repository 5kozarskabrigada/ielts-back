import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LISTENING_BAND_TABLE = [
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

const ACADEMIC_READING_BAND_TABLE = [
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

const getBandFromCorrect = (correctAnswers, table) => {
  const n = Math.round(Number(correctAnswers) || 0);
  if (n >= 1 && n <= 9) {
    if (n === 1) return 1.0;
    if (n === 2) return 2.0;
    if (n === 3) return 2.5;
    if (n >= 4 && n <= 6) return 3.0;
    return 3.5;
  }
  const matched = table.find((row) => n >= row.min && n <= row.max);
  return matched ? matched.band : null;
};

/**
 * Generate PDF report for a submission
 * @param {object} submissionData - Full submission data including answers, writing responses, etc.
 * @param {string} outputPath - Where to save the PDF file
 * @returns {Promise<string>} - Path to generated PDF
 */
export const generateSubmissionPDF = async (submissionData, outputPath) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const stream = fs.createWriteStream(outputPath);
      
      doc.pipe(stream);

      // Colors
      const primaryColor = '#1e3a8a'; // Blue
      const successColor = '#16a34a'; // Green
      const warningColor = '#eab308'; // Yellow
      const dangerColor = '#dc2626'; // Red
      const grayColor = '#6b7280';

      // Helper functions
      const drawHeader = () => {
        doc.fontSize(24)
           .fillColor(primaryColor)
           .font('Helvetica-Bold')
           .text('ExamRoom', 50, 50);
        
        doc.fontSize(12)
           .fillColor(grayColor)
           .font('Helvetica')
           .text('Exam Results Report', 50, 80);

        doc.moveTo(50, 100)
           .lineTo(doc.page.width - 50, 100)
           .strokeColor(primaryColor)
           .lineWidth(2)
           .stroke();
      };

      const drawStudentInfo = (y) => {
        const userName = submissionData.user_name || 'Unknown Student';
        const examTitle = submissionData.exam_title || 'Exam';
        const submittedDate = submissionData.submitted_at 
          ? new Date(submissionData.submitted_at).toLocaleDateString('en-US', { 
              year: 'numeric', month: 'long', day: 'numeric' 
            })
          : 'N/A';

        doc.fontSize(10)
           .fillColor(grayColor)
           .font('Helvetica')
           .text('Student:', 50, y);
        
        doc.font('Helvetica-Bold')
           .fillColor('#000')
           .text(userName, 120, y);

        doc.font('Helvetica')
           .fillColor(grayColor)
           .text('Exam:', 50, y + 20);
        
        doc.font('Helvetica-Bold')
           .fillColor('#000')
           .text(examTitle, 120, y + 20);

        doc.font('Helvetica')
           .fillColor(grayColor)
           .text('Date:', 50, y + 40);
        
        doc.font('Helvetica-Bold')
           .fillColor('#000')
           .text(submittedDate, 120, y + 40);

        return y + 70;
      };

      const getBandColor = (band) => {
        if (band == null || !Number.isFinite(Number(band))) return grayColor;
        const b = Number(band);
        if (b >= 7) return successColor;
        if (b >= 5) return warningColor;
        return dangerColor;
      };

      const drawScoreCards = (y) => {
        // Calculate module scores
        const answersByModule = submissionData.answers_by_module || {};
        const listeningCorrect = answersByModule.listening?.correct || 0;
        const readingCorrect = answersByModule.reading?.correct || 0;
        
        const listeningBand = getBandFromCorrect(listeningCorrect, LISTENING_BAND_TABLE);
        const readingBand = getBandFromCorrect(readingCorrect, ACADEMIC_READING_BAND_TABLE);
        
        // Writing band from writing_responses
        let writingBand = null;
        const writingResponses = submissionData.writing_responses || [];
        if (writingResponses.length > 0) {
          const bands = writingResponses
            .map(wr => wr.admin_override_band ?? wr.final_band ?? wr.ai_overall_band)
            .filter(b => b != null && Number.isFinite(Number(b)))
            .map(b => Number(b));
          if (bands.length > 0) {
            writingBand = bands.reduce((a, b) => a + b, 0) / bands.length;
          }
        }

        const overallBand = submissionData.writing_checked && writingBand != null
          ? (listeningBand + readingBand + writingBand) / 3
          : null;

        // Draw score boxes
        const cardWidth = 110;
        const cardHeight = 60;
        const gap = 15;
        let xPos = 50;

        const cards = [
          { label: 'Overall Band', value: overallBand, color: getBandColor(overallBand) },
          { label: 'Listening', value: listeningBand, color: getBandColor(listeningBand) },
          { label: 'Reading', value: readingBand, color: getBandColor(readingBand) },
          { label: 'Writing', value: writingBand, color: getBandColor(writingBand) },
        ];

        cards.forEach(card => {
          // Draw card background
          doc.rect(xPos, y, cardWidth, cardHeight)
             .fillAndStroke(card.color, card.color)
             .fillOpacity(0.1)
             .fill();

          doc.fillOpacity(1);

          // Draw label
          doc.fontSize(9)
             .fillColor(grayColor)
             .font('Helvetica-Bold')
             .text(card.label, xPos, y + 10, { width: cardWidth, align: 'center' });

          // Draw score
          const scoreText = card.value != null ? card.value.toFixed(1) : 'N/A';
          doc.fontSize(20)
             .fillColor(card.color)
             .font('Helvetica-Bold')
             .text(scoreText, xPos, y + 28, { width: cardWidth, align: 'center' });

          xPos += cardWidth + gap;
        });

        return y + cardHeight + 30;
      };

      const drawModuleAnswers = (y, moduleType, answers) => {
        if (answers.length === 0) return y;

        // Check if we need a new page
        if (y > doc.page.height - 200) {
          doc.addPage();
          y = 50;
        }

        doc.fontSize(14)
           .fillColor(primaryColor)
           .font('Helvetica-Bold')
           .text(moduleType.charAt(0).toUpperCase() + moduleType.slice(1) + ' Answers', 50, y);

        y += 25;

        // Table header
        const colWidths = [40, 200, 150, 100];
        const tableX = 50;
        
        doc.fontSize(9)
           .fillColor('#fff')
           .font('Helvetica-Bold');

        doc.rect(tableX, y, colWidths[0], 20).fill(primaryColor);
        doc.text('#', tableX + 5, y + 6, { width: colWidths[0] - 10, align: 'center' });

        doc.rect(tableX + colWidths[0], y, colWidths[1], 20).fill(primaryColor);
        doc.text('Student Answer', tableX + colWidths[0] + 5, y + 6, { width: colWidths[1] - 10 });

        doc.rect(tableX + colWidths[0] + colWidths[1], y, colWidths[2], 20).fill(primaryColor);
        doc.text('Correct Answer', tableX + colWidths[0] + colWidths[1] + 5, y + 6, { width: colWidths[2] - 10 });

        doc.rect(tableX + colWidths[0] + colWidths[1] + colWidths[2], y, colWidths[3], 20).fill(primaryColor);
        doc.text('Result', tableX + colWidths[0] + colWidths[1] + colWidths[2] + 5, y + 6, { width: colWidths[3] - 10, align: 'center' });

        y += 20;

        // Table rows
        answers.forEach((answer, index) => {
          if (y > doc.page.height - 100) {
            doc.addPage();
            y = 50;
          }

          const rowHeight = 25;
          const isCorrect = answer.is_correct === true;
          const bgColor = isCorrect ? '#f0fdf4' : '#fef2f2';

          // Draw row background
          doc.rect(tableX, y, colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3], rowHeight)
             .fillAndStroke(bgColor, '#e5e7eb')
             .lineWidth(0.5);

          doc.fillOpacity(1);
          doc.fontSize(8)
             .fillColor('#000')
             .font('Helvetica');

          // Question number
          doc.text(String(answer.question_number || index + 1), tableX + 5, y + 8, { 
            width: colWidths[0] - 10, 
            align: 'center' 
          });

          // Student answer
          const studentAnswer = answer.user_answer || 'Not answered';
          doc.text(studentAnswer, tableX + colWidths[0] + 5, y + 8, { 
            width: colWidths[1] - 10,
            ellipsis: true
          });

          // Correct answer
          const correctAnswer = answer.correct_answer || 'N/A';
          doc.text(correctAnswer, tableX + colWidths[0] + colWidths[1] + 5, y + 8, { 
            width: colWidths[2] - 10,
            ellipsis: true
          });

          // Result
          const resultText = isCorrect ? '✓ Correct' : '✗ Wrong';
          const resultColor = isCorrect ? successColor : dangerColor;
          doc.fillColor(resultColor)
             .font('Helvetica-Bold')
             .text(resultText, tableX + colWidths[0] + colWidths[1] + colWidths[2] + 5, y + 8, { 
               width: colWidths[3] - 10,
               align: 'center'
             });

          y += rowHeight;
        });

        return y + 20;
      };

      const drawWritingResponses = (y) => {
        const writingResponses = submissionData.writing_responses || [];
        if (writingResponses.length === 0) return y;

        writingResponses.forEach((wr, index) => {
          if (y > doc.page.height - 200) {
            doc.addPage();
            y = 50;
          }

          const finalBand = wr.admin_override_band ?? wr.final_band ?? wr.ai_overall_band;
          const taskTitle = wr.section_title || `Writing Task ${wr.task_number || index + 1}`;

          doc.fontSize(14)
             .fillColor(primaryColor)
             .font('Helvetica-Bold')
             .text(taskTitle, 50, y);

          y += 25;

          // Writing scores
          if (finalBand != null) {
            doc.fontSize(10)
               .fillColor(grayColor)
               .font('Helvetica')
               .text('Band Score: ', 50, y);
            
            doc.fillColor(getBandColor(finalBand))
               .font('Helvetica-Bold')
               .text(Number(finalBand).toFixed(1), 130, y);

            y += 20;
          }

          // AI scores if available
          if (wr.ai_overall_band != null) {
            const scores = [
              { label: 'Task Response', value: wr.ai_task_response_score },
              { label: 'Coherence', value: wr.ai_coherence_score },
              { label: 'Lexical', value: wr.ai_lexical_score },
              { label: 'Grammar', value: wr.ai_grammar_score },
            ].filter(s => s.value != null);

            if (scores.length > 0) {
              doc.fontSize(9)
                 .fillColor(grayColor)
                 .font('Helvetica-Bold')
                 .text('AI Scoring:', 50, y);

              y += 15;

              scores.forEach(score => {
                doc.fontSize(8)
                   .fillColor(grayColor)
                   .font('Helvetica')
                   .text(`${score.label}: `, 60, y);
                
                doc.fillColor(getBandColor(score.value))
                   .font('Helvetica-Bold')
                   .text(Number(score.value).toFixed(1), 150, y);

                y += 12;
              });

              y += 10;
            }
          }

          // Word count
          const wordCount = wr.word_count || 0;
          doc.fontSize(9)
             .fillColor(grayColor)
             .font('Helvetica')
             .text(`Word Count: ${wordCount}`, 50, y);

          y += 20;

          // Essay text (first 500 characters)
          const essayText = String(wr.response_text || 'No response submitted').substring(0, 500);
          doc.fontSize(8)
             .fillColor('#000')
             .font('Helvetica')
             .text('Response:', 50, y);

          y += 15;

          doc.fontSize(8)
             .fillColor('#333')
             .text(essayText + (wr.response_text?.length > 500 ? '...' : ''), 50, y, {
               width: doc.page.width - 100,
               align: 'justify'
             });

          y = doc.y + 30;
        });

        return y;
      };

      // Generate PDF
      drawHeader();
      let currentY = 120;
      
      currentY = drawStudentInfo(currentY);
      currentY = drawScoreCards(currentY);

      // Draw answers by module
      const answersByModule = submissionData.answers_by_module || {};
      ['listening', 'reading'].forEach(module => {
        if (answersByModule[module]?.answers?.length > 0) {
          currentY = drawModuleAnswers(currentY, module, answersByModule[module].answers);
        }
      });

      // Draw writing responses
      currentY = drawWritingResponses(currentY);

      // Footer
      doc.fontSize(8)
         .fillColor(grayColor)
         .font('Helvetica')
         .text(
           `Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} • ExamRoom`,
           50,
           doc.page.height - 50,
           { align: 'center', width: doc.page.width - 100 }
         );

      doc.end();

      stream.on('finish', () => {
        console.log(`✅ PDF generated: ${outputPath}`);
        resolve(outputPath);
      });

      stream.on('error', (err) => {
        console.error('❌ PDF generation error:', err);
        reject(err);
      });

    } catch (error) {
      console.error('❌ PDF generation failed:', error);
      reject(error);
    }
  });
};

/**
 * Generate a filename for submission PDF
 */
export const generatePDFFilename = (submission) => {
  const studentName = (submission.user_name || 'Student').replace(/[^a-zA-Z0-9]/g, '_');
  const examTitle = (submission.exam_title || 'Exam').replace(/[^a-zA-Z0-9]/g, '_');
  const timestamp = new Date().getTime();
  return `${studentName}_${examTitle}_${timestamp}.pdf`;
};
