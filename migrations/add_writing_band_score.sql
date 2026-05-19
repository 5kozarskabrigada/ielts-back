-- Add writing_band_score field to exam_submissions table
-- This allows admins to manually override the writing band score

ALTER TABLE exam_submissions 
ADD COLUMN IF NOT EXISTS writing_band_score DECIMAL(3,1);

-- Add an index for performance
CREATE INDEX IF NOT EXISTS idx_exam_submissions_writing_band ON exam_submissions(writing_band_score);

-- Comment explaining the column
COMMENT ON COLUMN exam_submissions.writing_band_score IS 'Manual writing band score override entered by admins/teachers';
