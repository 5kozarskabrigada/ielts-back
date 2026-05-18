#!/bin/sh
set -e

echo "======================================"
echo "🔄 Running file migration from Supabase to local storage..."
echo "======================================"

node scripts/migrate-files-from-supabase.js || echo "⚠️ Migration script failed or no files to migrate"

echo "======================================"
echo "🚀 Starting backend server..."
echo "======================================"

exec node server.js
