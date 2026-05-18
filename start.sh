#!/bin/sh

echo "🔄 Running file migration from Supabase to local storage..."
node scripts/migrate-files-from-supabase.js || echo "⚠️ Migration script failed or no files to migrate"

echo "🚀 Starting backend server..."
node server.js
