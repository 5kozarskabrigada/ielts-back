import { pool } from "../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

// Ensure upload directories exist
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Created directory: ${dir}`);
  }
};

// Download file from URL
const downloadFile = (url, destPath) => {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {}); // Delete partial file
      reject(err);
    });
  });
};

// Extract filename from Supabase URL
const extractFilename = (url) => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    // URL format: /storage/v1/object/public/uploads/reading/passages/filename.jpg
    const parts = pathname.split('/');
    return parts[parts.length - 1]; // Get last part (filename)
  } catch (err) {
    return null;
  }
};

// Determine file type and destination path
const getFileDestination = (url) => {
  if (url.includes('/reading/passages/')) {
    return 'reading/passages';
  } else if (url.includes('/listening/audio/')) {
    return 'listening/audio';
  }
  return null;
};

// Main migration function
const migrateFiles = async () => {
  console.log('🚀 Starting file migration from Supabase to local storage...\n');
  
  // Create upload directories
  ensureDir(path.join(UPLOAD_DIR, 'reading', 'passages'));
  ensureDir(path.join(UPLOAD_DIR, 'listening', 'audio'));
  
  let totalFiles = 0;
  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;
  const errors = [];
  
  try {
    // 1. Migrate audio files from exam_sections
    console.log('📂 Checking exam_sections for audio files...');
    const { rows: audioRows } = await pool.query(`
      SELECT id, audio_url 
      FROM exam_sections 
      WHERE audio_url IS NOT NULL 
        AND audio_url != '' 
        AND audio_url LIKE '%supabase%'
    `);
    
    console.log(`Found ${audioRows.length} audio files in exam_sections\n`);
    totalFiles += audioRows.length;
    
    for (const row of audioRows) {
      const { id, audio_url } = row;
      const filename = extractFilename(audio_url);
      const destination = getFileDestination(audio_url);
      
      if (!filename || !destination) {
        console.log(`⚠️  Skip: Invalid URL format - ${audio_url}`);
        skipCount++;
        continue;
      }
      
      const localPath = path.join(UPLOAD_DIR, destination, filename);
      
      // Skip if file already exists
      if (fs.existsSync(localPath)) {
        console.log(`⏭️  Skip: File already exists - ${filename}`);
        skipCount++;
        
        // Update URL in database even if file exists
        const newUrl = `${BACKEND_URL}/uploads/${destination}/${filename}`;
        await pool.query(`UPDATE exam_sections SET audio_url = $1 WHERE id = $2`, [newUrl, id]);
        continue;
      }
      
      try {
        console.log(`📥 Downloading: ${filename}...`);
        await downloadFile(audio_url, localPath);
        
        // Update database with new local URL
        const newUrl = `${BACKEND_URL}/uploads/${destination}/${filename}`;
        await pool.query(`UPDATE exam_sections SET audio_url = $1 WHERE id = $2`, [newUrl, id]);
        
        console.log(`✅ Migrated: ${filename} → ${newUrl}\n`);
        successCount++;
      } catch (err) {
        console.error(`❌ Error: Failed to migrate ${filename} - ${err.message}\n`);
        errors.push({ file: filename, url: audio_url, error: err.message });
        errorCount++;
      }
    }
    
    // 2. Migrate image files from exam_sections
    console.log('\n📂 Checking exam_sections for images...');
    const { rows: imageRows } = await pool.query(`
      SELECT id, image_url 
      FROM exam_sections 
      WHERE image_url IS NOT NULL 
        AND image_url != '' 
        AND image_url LIKE '%supabase%'
    `);
    
    console.log(`Found ${imageRows.length} images in exam_sections\n`);
    totalFiles += imageRows.length;
    
    for (const row of imageRows) {
      const { id, image_url } = row;
      const filename = extractFilename(image_url);
      const destination = getFileDestination(image_url);
      
      if (!filename || !destination) {
        console.log(`⚠️  Skip: Invalid URL format - ${image_url}`);
        skipCount++;
        continue;
      }
      
      const localPath = path.join(UPLOAD_DIR, destination, filename);
      
      if (fs.existsSync(localPath)) {
        console.log(`⏭️  Skip: File already exists - ${filename}`);
        skipCount++;
        
        const newUrl = `${BACKEND_URL}/uploads/${destination}/${filename}`;
        await pool.query(`UPDATE exam_sections SET image_url = $1 WHERE id = $2`, [newUrl, id]);
        continue;
      }
      
      try {
        console.log(`📥 Downloading: ${filename}...`);
        await downloadFile(image_url, localPath);
        
        const newUrl = `${BACKEND_URL}/uploads/${destination}/${filename}`;
        await pool.query(`UPDATE exam_sections SET image_url = $1 WHERE id = $2`, [newUrl, id]);
        
        console.log(`✅ Migrated: ${filename} → ${newUrl}\n`);
        successCount++;
      } catch (err) {
        console.error(`❌ Error: Failed to migrate ${filename} - ${err.message}\n`);
        errors.push({ file: filename, url: image_url, error: err.message });
        errorCount++;
      }
    }
    
    // 3. Migrate images from questions table
    console.log('\n📂 Checking questions for images...');
    const { rows: questionImageRows } = await pool.query(`
      SELECT id, image_url 
      FROM questions 
      WHERE image_url IS NOT NULL 
        AND image_url != '' 
        AND image_url LIKE '%supabase%'
    `);
    
    console.log(`Found ${questionImageRows.length} images in questions\n`);
    totalFiles += questionImageRows.length;
    
    for (const row of questionImageRows) {
      const { id, image_url } = row;
      const filename = extractFilename(image_url);
      const destination = getFileDestination(image_url);
      
      if (!filename || !destination) {
        console.log(`⚠️  Skip: Invalid URL format - ${image_url}`);
        skipCount++;
        continue;
      }
      
      const localPath = path.join(UPLOAD_DIR, destination, filename);
      
      if (fs.existsSync(localPath)) {
        console.log(`⏭️  Skip: File already exists - ${filename}`);
        skipCount++;
        
        const newUrl = `${BACKEND_URL}/uploads/${destination}/${filename}`;
        await pool.query(`UPDATE questions SET image_url = $1 WHERE id = $2`, [newUrl, id]);
        continue;
      }
      
      try {
        console.log(`📥 Downloading: ${filename}...`);
        await downloadFile(image_url, localPath);
        
        const newUrl = `${BACKEND_URL}/uploads/${destination}/${filename}`;
        await pool.query(`UPDATE questions SET image_url = $1 WHERE id = $2`, [newUrl, id]);
        
        console.log(`✅ Migrated: ${filename} → ${newUrl}\n`);
        successCount++;
      } catch (err) {
        console.error(`❌ Error: Failed to migrate ${filename} - ${err.message}\n`);
        errors.push({ file: filename, url: image_url, error: err.message });
        errorCount++;
      }
    }
    
  } catch (err) {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 MIGRATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total files found:     ${totalFiles}`);
  console.log(`✅ Successfully migrated: ${successCount}`);
  console.log(`⏭️  Skipped (existing):   ${skipCount}`);
  console.log(`❌ Failed:               ${errorCount}`);
  console.log('='.repeat(60));
  
  if (errors.length > 0) {
    console.log('\n❌ Errors encountered:');
    errors.forEach(({ file, url, error }) => {
      console.log(`  - ${file}: ${error}`);
      console.log(`    URL: ${url}`);
    });
  }
  
  if (errorCount === 0) {
    console.log('\n✅ Migration completed successfully!');
    console.log('All files are now stored locally in backend/uploads/');
    console.log('Database URLs have been updated to point to local server.');
  } else {
    console.log(`\n⚠️  Migration completed with ${errorCount} errors.`);
    console.log('Please review the errors above and retry if needed.');
  }
  
  await pool.end();
  process.exit(errorCount > 0 ? 1 : 0);
};

// Run migration
migrateFiles().catch(console.error);
