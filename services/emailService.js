import nodemailer from "nodemailer";

// Email configuration from environment variables
const EMAIL_HOST = process.env.EMAIL_HOST || "smtp.office365.com";
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || "587", 10);
const EMAIL_USER = process.env.EMAIL_USER || "info@examroomedu.com";
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "";
const EMAIL_SECURE = process.env.EMAIL_SECURE === "true"; // true for 465, false for 587
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const PLATFORM_NAME = process.env.PLATFORM_NAME || "ExamRoom";

// Create reusable transporter
const createTransporter = () => {
  if (!EMAIL_PASSWORD) {
    console.warn("⚠️ EMAIL_PASSWORD not configured. Email sending will be disabled.");
    return null;
  }

  console.log("📧 Creating email transporter with config:", {
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    user: EMAIL_USER,
    secure: EMAIL_SECURE,
    requireTLS: true
  });

  return nodemailer.createTransporter({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_SECURE, // false for port 587 (STARTTLS)
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASSWORD,
    },
    requireTLS: true, // Force STARTTLS for Office 365
    logger: true, // Enable logging
    debug: true, // Detailed SMTP logs for troubleshooting
  });
};

/**
 * Generate professional HTML email template for login credentials
 */
const generateCredentialsEmail = (userData) => {
  const { firstName, lastName, username, password } = userData;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your ${PLATFORM_NAME} Login Credentials</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f7fa;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f7fa; padding: 40px 20px;">
    <tr>
      <td align="center">
        <!-- Main Container -->
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          
          <!-- Header with Logo -->
          <tr>
            <td style="background: linear-gradient(135deg, #123b71 0%, #1e5a9e 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600;">
                ${PLATFORM_NAME}
              </h1>
              <p style="margin: 10px 0 0; color: #e3f2fd; font-size: 14px;">
                Welcome to Your Learning Journey
              </p>
            </td>
          </tr>

          <!-- Welcome Message -->
          <tr>
            <td style="padding: 40px 30px 20px;">
              <h2 style="margin: 0 0 15px; color: #123b71; font-size: 24px; font-weight: 600;">
                Welcome, ${firstName} ${lastName}!
              </h2>
              <p style="margin: 0; color: #555555; font-size: 16px; line-height: 1.6;">
                Your account has been successfully created. Below are your login credentials to access the platform.
              </p>
            </td>
          </tr>

          <!-- Credentials Box -->
          <tr>
            <td style="padding: 0 30px 30px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8f9fa; border: 2px solid #e9ecef; border-radius: 8px;">
                <tr>
                  <td style="padding: 25px;">
                    <table width="100%" cellpadding="8" cellspacing="0">
                      <tr>
                        <td style="color: #6c757d; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; padding-bottom: 10px;">
                          Login Credentials
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 12px 0; border-bottom: 1px solid #dee2e6;">
                          <table width="100%">
                            <tr>
                              <td style="color: #6c757d; font-size: 14px; width: 100px;">Username:</td>
                              <td style="color: #123b71; font-size: 16px; font-weight: 600; font-family: 'Courier New', monospace;">
                                ${username}
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 12px 0;">
                          <table width="100%">
                            <tr>
                              <td style="color: #6c757d; font-size: 14px; width: 100px;">Password:</td>
                              <td style="color: #123b71; font-size: 16px; font-weight: 600; font-family: 'Courier New', monospace;">
                                ${password}
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="padding: 0 30px 30px; text-align: center;">
              <a href="https://examroomedu.com/2/login" 
                 style="display: inline-block; background: linear-gradient(135deg, #123b71 0%, #1e5a9e 100%); color: #ffffff; text-decoration: none; padding: 14px 40px; border-radius: 6px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 8px rgba(18, 59, 113, 0.2);">
                Login to Your Account
              </a>
            </td>
          </tr>

          <!-- Getting Started Section -->
          <tr>
            <td style="padding: 0 30px 30px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #e7f3ff; border-left: 4px solid #123b71; border-radius: 4px;">
                <tr>
                  <td style="padding: 20px;">
                    <h3 style="margin: 0 0 10px; color: #123b71; font-size: 16px; font-weight: 600;">
                      🚀 Getting Started
                    </h3>
                    <ul style="margin: 10px 0; padding-left: 20px; color: #555555; font-size: 14px; line-height: 1.8;">
                      <li>Use your username and password to log in</li>
                      <li>Complete your profile information</li>
                    </ul>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 25px 30px; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 8px; color: #6c757d; font-size: 13px; line-height: 1.5;">
                Need help? Contact your administrator or visit our support center.
              </p>
              <p style="margin: 0; color: #adb5bd; font-size: 12px;">
                © ${new Date().getFullYear()} ${PLATFORM_NAME}. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
};

/**
 * Send welcome email with login credentials
 * @param {string} toEmail - Recipient email address
 * @param {object} userData - User data including firstName, lastName, username, password
 * @returns {Promise<object>} - Email sending result
 */
export const sendWelcomeEmail = async (toEmail, userData) => {
  const transporter = createTransporter();
  
  if (!transporter) {
    console.log("📧 Email disabled (no EMAIL_PASSWORD). Would have sent to:", toEmail);
    return { success: false, message: "Email service not configured" };
  }

  const mailOptions = {
    from: `"${PLATFORM_NAME}" <${EMAIL_USER}>`,
    to: toEmail,
    subject: `Welcome to ${PLATFORM_NAME} - Your Login Credentials`,
    html: generateCredentialsEmail(userData),
    text: `
Welcome to ${PLATFORM_NAME}!

Hello ${userData.firstName} ${userData.lastName},

Your account has been successfully created. Here are your login credentials:

Username: ${userData.username}
Password: ${userData.password}

Login URL: https://examroomedu.com/2/login

Getting Started:
• Use your username and password to log in
• Complete your profile information

If you need any assistance, please contact your administrator.

© ${new Date().getFullYear()} ${PLATFORM_NAME}
    `.trim(),
  };

  try {
    console.log(`📤 Attempting to send welcome email to: ${toEmail}`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Welcome email sent successfully!`);
    console.log(`   → To: ${toEmail}`);
    console.log(`   → Message ID: ${info.messageId}`);
    console.log(`   → Response: ${info.response}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`\n❌ FAILED to send welcome email`);
    console.error(`   → Recipient: ${toEmail}`);
    console.error(`   → Error Type: ${error.name}`);
    console.error(`   → Error Message: ${error.message}`);
    if (error.code) console.error(`   → Error Code: ${error.code}`);
    if (error.response) console.error(`   → SMTP Response: ${error.response}`);
    if (error.responseCode) console.error(`   → Response Code: ${error.responseCode}`);
    if (error.command) console.error(`   → Failed Command: ${error.command}`);
    console.error(`   → Full Error:`, error);
    throw error;
  }
};

/**
 * Test email configuration
 */
export const testEmailConfiguration = async () => {
  const transporter = createTransporter();
  
  if (!transporter) {
    console.log("❌ Email not configured (missing EMAIL_PASSWORD)");
    return false;
  }

  try {
    await transporter.verify();
    console.log("✅ Email server is ready to send messages");
    return true;
  } catch (error) {
    console.error("❌ Email configuration error:", error.message);
    return false;
  }
};

/**
 * Send submission results as PDF attachment
 * @param {string} toEmail - Recipient email address
 * @param {object} submissionData - Submission data for email content
 * @param {string} pdfPath - Path to PDF file
 * @param {string} pdfFilename - Filename for PDF attachment
 * @returns {Promise<object>} - Email sending result
 */
export const sendSubmissionPDF = async (toEmail, submissionData, pdfPath, pdfFilename) => {
  const transporter = createTransporter();
  
  if (!transporter) {
    console.log("📧 Email disabled (no EMAIL_PASSWORD). Would have sent to:", toEmail);
    return { success: false, message: "Email service not configured" };
  }

  const studentName = submissionData.user_name || 'Student';
  const examTitle = submissionData.exam_title || 'Exam';
  const overallBand = submissionData.band_score != null 
    ? Number(submissionData.band_score).toFixed(1)
    : 'N/A';

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your ${PLATFORM_NAME} Exam Results</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f7fa;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f7fa; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #123b71 0%, #1e5a9e 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600;">
                ${PLATFORM_NAME}
              </h1>
              <p style="margin: 10px 0 0; color: #e3f2fd; font-size: 14px;">
                Exam Results Report
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <h2 style="margin: 0 0 15px; color: #123b71; font-size: 22px; font-weight: 600;">
                Hello ${studentName}!
              </h2>
              <p style="margin: 0 0 20px; color: #555555; font-size: 16px; line-height: 1.6;">
                Your exam results for <strong>${examTitle}</strong> are now available. Please find your detailed performance report attached as a PDF.
              </p>

              <!-- Score Summary -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8f9fa; border: 2px solid #e9ecef; border-radius: 8px; margin: 20px 0;">
                <tr>
                  <td style="padding: 25px; text-align: center;">
                    <p style="margin: 0 0 10px; color: #6c757d; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">
                      Overall Band Score
                    </p>
                    <p style="margin: 0; color: #123b71; font-size: 36px; font-weight: 700;">
                      ${overallBand}
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin: 20px 0; color: #555555; font-size: 14px; line-height: 1.6;">
                The attached PDF contains:
              </p>
              <ul style="margin: 10px 0; padding-left: 20px; color: #555555; font-size: 14px; line-height: 1.8;">
                <li>Your overall band score and module-wise scores</li>
                <li>Detailed answer breakdown for Listening and Reading</li>
                <li>Writing task scores and feedback (if applicable)</li>
              </ul>
            </td>
          </tr>

          <!-- Attachment Notice -->
          <tr>
            <td style="padding: 0 30px 30px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #e7f3ff; border-left: 4px solid #123b71; border-radius: 4px;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0; color: #123b71; font-size: 14px; line-height: 1.5;">
                      <strong>📎 Attachment:</strong> ${pdfFilename}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 25px 30px; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 8px; color: #6c757d; font-size: 13px; line-height: 1.5;">
                Need help? Contact your administrator or visit our support center.
              </p>
              <p style="margin: 0; color: #adb5bd; font-size: 12px;">
                © ${new Date().getFullYear()} ${PLATFORM_NAME}. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textContent = `
${PLATFORM_NAME} - Exam Results Report

Hello ${studentName},

Your exam results for "${examTitle}" are now available.

Overall Band Score: ${overallBand}

The attached PDF contains your detailed performance report including:
• Your overall band score and module-wise scores
• Detailed answer breakdown for Listening and Reading
• Writing task scores and feedback (if applicable)

If you need any assistance, please contact your administrator.

© ${new Date().getFullYear()} ${PLATFORM_NAME}
  `.trim();

  const mailOptions = {
    from: `"${PLATFORM_NAME}" <${EMAIL_USER}>`,
    to: toEmail,
    subject: `Your ${examTitle} Results - ${PLATFORM_NAME}`,
    html: htmlContent,
    text: textContent,
    attachments: [
      {
        filename: pdfFilename,
        path: pdfPath,
      },
    ],
  };

  try {
    console.log(`📤 Attempting to send submission PDF email to: ${toEmail}`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Submission PDF email sent successfully!`);
    console.log(`   → To: ${toEmail}`);
    console.log(`   → Message ID: ${info.messageId}`);
    console.log(`   → Response: ${info.response}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`\n❌ FAILED to send submission PDF email`);
    console.error(`   → Recipient: ${toEmail}`);
    console.error(`   → Error Type: ${error.name}`);
    console.error(`   → Error Message: ${error.message}`);
    if (error.code) console.error(`   → Error Code: ${error.code}`);
    if (error.response) console.error(`   → SMTP Response: ${error.response}`);
    if (error.responseCode) console.error(`   → Response Code: ${error.responseCode}`);
    if (error.command) console.error(`   → Failed Command: ${error.command}`);
    console.error(`   → Full Error:`, error);
    throw error;
  }
};

export default {
  sendWelcomeEmail,
  sendSubmissionPDF,
  testEmailConfiguration,
};
