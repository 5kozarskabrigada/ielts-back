// ⚠️ DEPRECATED: Supabase removed in favor of local file storage
// This file is kept to prevent import errors in legacy code
// All file uploads now use local filesystem (backend/uploads/)

console.error("❌ ERROR: supabaseClient.js is deprecated. Use local file storage instead.");
console.error("  Files are now stored in backend/uploads/ and served via /uploads route");
console.error("  Supabase has been completely removed from this project.");

throw new Error(
  "Supabase dependency removed. This project now uses:\n" +
  "  • Neon PostgreSQL for database\n" +
  "  • Local filesystem for file storage (backend/uploads/)\n" +
  "  • If you see this error, update your imports to remove supabaseClient.js"
);

export const supabase = null;
