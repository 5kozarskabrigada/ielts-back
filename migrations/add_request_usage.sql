-- Run this in Neon SQL Editor to add per-student usage tracking
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
