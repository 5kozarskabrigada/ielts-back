-- ============================================================
-- IELTS Platform — Consolidated Neon PostgreSQL Schema
-- Run this ONCE in the Neon SQL Editor to create all tables.
-- ============================================================

-- 1. Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Core tables
-- -------------------------------------------------------

-- Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE,
    username VARCHAR(100) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'student' CHECK (role IN ('admin', 'student')),
    is_active BOOLEAN DEFAULT true,
    is_deleted BOOLEAN DEFAULT false,
    reset_token VARCHAR(255),
    reset_token_expires TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);

-- Classrooms
CREATE TABLE IF NOT EXISTS classrooms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS classroom_students (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    classroom_id UUID REFERENCES classrooms(id) ON DELETE CASCADE,
    student_id UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(classroom_id, student_id)
);

-- Exams
CREATE TABLE IF NOT EXISTS exams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    modules_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    duration_minutes INTEGER NOT NULL,
    access_code VARCHAR(50) UNIQUE NOT NULL,
    created_by UUID REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'archived', 'deleted')),
    type TEXT DEFAULT 'standard',
    is_deleted BOOLEAN DEFAULT false,
    security_level VARCHAR(20) DEFAULT 'standard' CHECK (security_level IN ('standard', 'strict')),
    target_audience VARCHAR(20) DEFAULT 'all' CHECK (target_audience IN ('all', 'classroom')),
    assigned_classroom_id UUID REFERENCES classrooms(id),
    visibility_scope VARCHAR(50) DEFAULT 'all' CHECK (visibility_scope IN ('all', 'classroom')),
    assigned_classrooms JSONB DEFAULT '[]'::jsonb,
    security_mode VARCHAR(50) DEFAULT 'log_only' CHECK (security_mode IN ('log_only', 'disqualify')),
    max_violations INTEGER DEFAULT 3,
    listening_config JSONB DEFAULT NULL,
    starts_at TIMESTAMP WITH TIME ZONE,
    ends_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exams_access_code ON exams(access_code);
CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status);
CREATE INDEX IF NOT EXISTS idx_exams_created_by ON exams(created_by);

-- Exam Sections
CREATE TABLE IF NOT EXISTS exam_sections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
    module_type VARCHAR(20) NOT NULL CHECK (module_type IN ('listening', 'reading', 'writing', 'speaking')),
    section_order INTEGER NOT NULL,
    title VARCHAR(255),
    content TEXT,
    audio_url TEXT,
    duration_minutes INTEGER,
    image_url TEXT,
    image_description TEXT,
    letter VARCHAR(2),
    instruction TEXT,
    task_config TEXT,
    audio_start_time INTEGER DEFAULT 0,
    section_description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(exam_id, module_type, section_order)
);

CREATE UNIQUE INDEX IF NOT EXISTS exam_sections_exam_id_letter_unique
    ON exam_sections (exam_id, letter)
    WHERE module_type = 'reading' AND letter IS NOT NULL;

-- Listening Question Groups
CREATE TABLE IF NOT EXISTS listening_question_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    section_id UUID REFERENCES exam_sections(id) ON DELETE CASCADE,
    group_order INTEGER NOT NULL,
    question_range_start INTEGER NOT NULL,
    question_range_end INTEGER NOT NULL,
    question_type VARCHAR(50) NOT NULL,
    instruction_text TEXT,
    max_words INTEGER DEFAULT NULL,
    max_numbers INTEGER DEFAULT NULL,
    answer_format VARCHAR(30) DEFAULT 'words_and_numbers',
    has_example BOOLEAN DEFAULT false,
    example_data JSONB DEFAULT NULL,
    audio_start_time INTEGER DEFAULT NULL,
    shared_options JSONB DEFAULT NULL,
    image_url TEXT DEFAULT NULL,
    image_description TEXT DEFAULT NULL,
    layout_type VARCHAR(30) DEFAULT NULL,
    points_per_question INTEGER DEFAULT 1,
    case_sensitive BOOLEAN DEFAULT false,
    spelling_tolerance BOOLEAN DEFAULT true,
    table_title TEXT DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(section_id, group_order)
);

CREATE INDEX IF NOT EXISTS idx_question_groups_section ON listening_question_groups(section_id);
CREATE INDEX IF NOT EXISTS idx_question_groups_type ON listening_question_groups(question_type);

-- Questions
CREATE TABLE IF NOT EXISTS questions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
    section_id UUID REFERENCES exam_sections(id) ON DELETE CASCADE,
    module_type VARCHAR(20) CHECK (module_type IN ('listening', 'reading', 'writing', 'speaking')),
    question_number INTEGER NOT NULL,
    question_text TEXT NOT NULL,
    question_type VARCHAR(50) DEFAULT 'multiple_choice',
    question_data JSONB,
    correct_answer JSONB,
    answer_alternatives TEXT[] DEFAULT NULL,
    points INTEGER DEFAULT 1,
    is_deleted BOOLEAN DEFAULT false,
    difficulty_level VARCHAR(20) DEFAULT 'medium' CHECK (difficulty_level IN ('easy', 'medium', 'hard')),
    group_id UUID REFERENCES listening_question_groups(id) ON DELETE SET NULL,
    blank_position INTEGER DEFAULT NULL,
    question_template TEXT DEFAULT NULL,
    passage_letter VARCHAR(2),
    is_info_row BOOLEAN DEFAULT false,
    row_order INTEGER DEFAULT NULL,
    label_text TEXT DEFAULT NULL,
    info_text TEXT DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT questions_exam_section_qnum_unique UNIQUE(exam_id, section_id, question_number)
);

CREATE INDEX IF NOT EXISTS idx_questions_exam_id ON questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_questions_module_type ON questions(module_type);
CREATE INDEX IF NOT EXISTS idx_questions_is_deleted ON questions(is_deleted);
CREATE INDEX IF NOT EXISTS idx_questions_difficulty ON questions(difficulty_level);

-- 3. Exam lifecycle tables
-- -------------------------------------------------------

-- Exam Submissions
CREATE TABLE IF NOT EXISTS exam_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    exam_id UUID REFERENCES exams(id),
    answers JSONB DEFAULT '{}'::jsonb,
    scores_by_module JSONB,
    band_score DECIMAL(3,1),
    overall_band_score DECIMAL(3,1),
    total_correct INTEGER DEFAULT 0,
    total_questions INTEGER DEFAULT 0,
    time_spent INTEGER DEFAULT 0,
    time_spent_by_module JSONB,
    status VARCHAR(20) DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'auto_submitted', 'violation_terminated')),
    writing_grading_status VARCHAR(20) DEFAULT 'pending' CHECK (writing_grading_status IN ('pending', 'ai_graded', 'admin_reviewed', 'complete')),
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    submitted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(exam_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON exam_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_exam_id ON exam_submissions(exam_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON exam_submissions(status);
CREATE INDEX IF NOT EXISTS idx_exam_submissions_submitted_at ON exam_submissions(submitted_at);

-- Answers
CREATE TABLE IF NOT EXISTS answers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    submission_id UUID REFERENCES exam_submissions(id) ON DELETE CASCADE,
    question_id UUID REFERENCES questions(id),
    user_answer JSONB,
    is_correct BOOLEAN,
    score FLOAT,
    admin_override_correct BOOLEAN DEFAULT NULL,
    admin_override_score FLOAT DEFAULT NULL,
    admin_notes TEXT DEFAULT NULL,
    graded_by VARCHAR(20) DEFAULT 'system' CHECK (graded_by IN ('system', 'ai', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_answers_submission_id ON answers(submission_id);
CREATE INDEX IF NOT EXISTS idx_answers_question_id ON answers(question_id);

-- Writing Responses
CREATE TABLE IF NOT EXISTS writing_responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    submission_id UUID REFERENCES exam_submissions(id) ON DELETE CASCADE,
    section_id UUID REFERENCES exam_sections(id),
    task_number INTEGER NOT NULL CHECK (task_number IN (1, 2)),
    response_text TEXT NOT NULL,
    word_count INTEGER,
    ai_overall_band FLOAT,
    ai_task_response_score FLOAT,
    ai_coherence_score FLOAT,
    ai_lexical_score FLOAT,
    ai_grammar_score FLOAT,
    ai_feedback TEXT,
    ai_graded_at TIMESTAMP WITH TIME ZONE,
    admin_override_band FLOAT,
    admin_feedback TEXT,
    admin_graded_by UUID REFERENCES users(id),
    admin_graded_at TIMESTAMP WITH TIME ZONE,
    final_band FLOAT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_writing_responses_submission_id ON writing_responses(submission_id);
CREATE INDEX IF NOT EXISTS idx_writing_responses_section_id ON writing_responses(section_id);

-- Exam Autosaves
CREATE TABLE IF NOT EXISTS exam_autosaves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answers_data JSONB DEFAULT '{}'::jsonb,
    current_module VARCHAR(50),
    current_part INTEGER DEFAULT 1,
    current_writing_task INTEGER DEFAULT 1,
    time_spent JSONB DEFAULT '{}'::jsonb,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(exam_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_autosaves_exam_user ON exam_autosaves(exam_id, user_id);
CREATE INDEX IF NOT EXISTS idx_exam_autosaves_user ON exam_autosaves(user_id);

-- 4. Monitoring & audit tables
-- -------------------------------------------------------

-- Violations
CREATE TABLE IF NOT EXISTS violations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    exam_id UUID REFERENCES exams(id),
    violation_type VARCHAR(50) NOT NULL,
    metadata JSONB,
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_violations_user_id ON violations(user_id);
CREATE INDEX IF NOT EXISTS idx_violations_exam_id ON violations(exam_id);
CREATE INDEX IF NOT EXISTS idx_violations_type ON violations(violation_type);
CREATE INDEX IF NOT EXISTS idx_violations_occurred_at ON violations(occurred_at);

-- Monitoring Logs
CREATE TABLE IF NOT EXISTS monitoring_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitoring_logs_exam ON monitoring_logs(exam_id);
CREATE INDEX IF NOT EXISTS idx_monitoring_logs_user ON monitoring_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_monitoring_logs_event_type ON monitoring_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_monitoring_logs_timestamp ON monitoring_logs(timestamp);

-- 5. Admin tables
-- -------------------------------------------------------

-- Question Banks
CREATE TABLE IF NOT EXISTS question_banks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    module_type VARCHAR(20) NOT NULL CHECK (module_type IN ('listening', 'reading', 'writing', 'speaking')),
    tags TEXT[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Admin Logs
CREATE TABLE IF NOT EXISTS admin_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID REFERENCES users(id),
    action_type VARCHAR(50) NOT NULL,
    target_resource VARCHAR(50),
    target_id UUID,
    details JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Scoring Configs
CREATE TABLE IF NOT EXISTS scoring_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by UUID REFERENCES users(id)
);

-- 6. Triggers for admin score override
-- -------------------------------------------------------

CREATE OR REPLACE FUNCTION calculate_final_answer_score()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.admin_override_correct IS NOT NULL THEN
        NEW.is_correct := NEW.admin_override_correct;
    END IF;
    IF NEW.admin_override_score IS NOT NULL THEN
        NEW.score := NEW.admin_override_score;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS answer_admin_override_trigger ON answers;
CREATE TRIGGER answer_admin_override_trigger
    BEFORE UPDATE ON answers
    FOR EACH ROW
    EXECUTE FUNCTION calculate_final_answer_score();

CREATE OR REPLACE FUNCTION calculate_final_writing_band()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.admin_override_band IS NOT NULL THEN
        NEW.final_band := NEW.admin_override_band;
    ELSE
        NEW.final_band := NEW.ai_overall_band;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS writing_response_band_trigger ON writing_responses;
CREATE TRIGGER writing_response_band_trigger
    BEFORE INSERT OR UPDATE ON writing_responses
    FOR EACH ROW
    EXECUTE FUNCTION calculate_final_writing_band();

-- 7. Seed default scoring config
-- -------------------------------------------------------

-- 8. Usage tracking for per-student cost monitoring
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    user_role VARCHAR(20),
    method VARCHAR(10) NOT NULL,
    path VARCHAR(255) NOT NULL,
    status_code INTEGER,
    response_time_ms INTEGER,
    db_query_count INTEGER DEFAULT 0,
    db_total_ms DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_usage_user_id ON request_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_request_usage_created_at ON request_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_request_usage_path ON request_usage(path);

INSERT INTO scoring_configs (config_key, config_value) VALUES 
('ielts_listening_band', '[
    {"min": 39, "max": 40, "band": 9.0},
    {"min": 37, "max": 38, "band": 8.5},
    {"min": 35, "max": 36, "band": 8.0},
    {"min": 32, "max": 34, "band": 7.5},
    {"min": 30, "max": 31, "band": 7.0},
    {"min": 26, "max": 29, "band": 6.5},
    {"min": 23, "max": 25, "band": 6.0},
    {"min": 18, "max": 22, "band": 5.5},
    {"min": 16, "max": 17, "band": 5.0},
    {"min": 13, "max": 15, "band": 4.5},
    {"min": 10, "max": 12, "band": 4.0}
]'::jsonb)
ON CONFLICT (config_key) DO NOTHING;
