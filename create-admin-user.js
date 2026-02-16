import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load environment variables
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const hashPassword = (password) => {
  return crypto.createHash("sha256").update(password).digest("hex");
};

async function createAdmin() {
  const email = "admin@example.com";
  const password = "password123";
  const username = "admin";
  const firstName = "System";
  const lastName = "Admin";
  
  const passwordHash = hashPassword(password);

  console.log(`Creating admin user: ${username} (${email})`);

  // Check if user exists
  const { data: existingUser } = await supabase
    .from("users")
    .select("*")
    .or(`email.eq.${email},username.eq.${username}`)
    .single();

  if (existingUser) {
    console.log("Admin user already exists. Updating password...");
    const { error } = await supabase
      .from("users")
      .update({
        password_hash: passwordHash,
        role: "admin",
        is_active: true,
        is_deleted: false
      })
      .eq("id", existingUser.id);

    if (error) {
      console.error("Error updating admin:", error.message);
    } else {
      console.log("Admin password updated successfully!");
      console.log("Username: " + username);
      console.log("Password: " + password);
    }
  } else {
    console.log("Creating new admin user...");
    const { error } = await supabase
      .from("users")
      .insert([
        {
          email,
          username,
          password_hash: passwordHash,
          first_name: firstName,
          last_name: lastName,
          role: "admin",
          is_active: true
        }
      ]);

    if (error) {
      console.error("Error creating admin:", error.message);
    } else {
      console.log("Admin user created successfully!");
      console.log("Username: " + username);
      console.log("Password: " + password);
    }
  }
}

createAdmin();
