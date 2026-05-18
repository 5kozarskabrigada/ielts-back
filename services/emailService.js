import nodemailer from "nodemailer";

// Email configuration from environment variables
const EMAIL_HOST = process.env.EMAIL_HOST || "smtp.office365.com";
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || "587", 10);
const EMAIL_USER = process.env.EMAIL_USER || "info@examroomedu.com";
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "";
const EMAIL_SECURE = process.env.EMAIL_SECURE === "true"; // true for 465, false for 587
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const PLATFORM_NAME = process.env.PLATFORM_NAME || "TOEFL Practice Platform";

// Create reusable transporter
const createTransporter = () => {
  if (!EMAIL_PASSWORD) {
    console.warn("⚠️ EMAIL_PASSWORD not configured. Email sending will be disabled.");
    return null;
  }

  return nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_SECURE,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASSWORD,
    },
    tls: {
      ciphers: "SSLv3",
    },
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
              <a href="${FRONTEND_URL}/login" 
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
                      <li>Browse available practice exams</li>
                      <li>Start practicing and track your progress</li>
                    </ul>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Security Notice -->
          <tr>
            <td style="padding: 0 30px 30px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                <tr>
                  <td style="padding: 15px;">
                    <p style="margin: 0; color: #856404; font-size: 13px; line-height: 1.5;">
                      <strong>🔒 Security Tip:</strong> For your security, we recommend changing your password after your first login.
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

Login URL: ${FRONTEND_URL}/login

Getting Started:
• Use your username and password to log in
• Complete your profile information
• Browse available practice exams
• Start practicing and track your progress

Security Tip: For your security, we recommend changing your password after your first login.

If you need any assistance, please contact your administrator.

© ${new Date().getFullYear()} ${PLATFORM_NAME}
    `.trim(),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Welcome email sent to ${toEmail} (Message ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ Failed to send email to ${toEmail}:`, error.message);
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

export default {
  sendWelcomeEmail,
  testEmailConfiguration,
};
