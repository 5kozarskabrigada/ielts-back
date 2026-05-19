-- Add speaking_band_score field to exam_submissions table
ALTER TABLE exam_submissions 
ADD COLUMN IF NOT EXISTS speaking_band_score DECIMAL(3,1);

-- Add an index for performance
CREATE INDEX IF NOT EXISTS idx_exam_submissions_speaking_band ON exam_submissions(speaking_band_score);
