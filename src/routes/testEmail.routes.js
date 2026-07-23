// Create a new file: routes/testEmail.routes.js
const express = require('express');
const nodemailer = require('nodemailer');
const { auth, isAdmin } = require('../middlewares/auth.middleware');
const router = express.Router();

// Configuration 1: Gmail with service (original)
const config1 = {
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_STETH,
    pass: process.env.EMAIL_STETH_PASS
  }
};

// Configuration 2: Gmail SMTP port 587
const config2 = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_STETH,
    pass: process.env.EMAIL_STETH_PASS
  }
};

// Configuration 3: Gmail SMTP port 465 (SSL)
const config3 = {
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_STETH,
    pass: process.env.EMAIL_STETH_PASS
  }
};

// Configuration 4: Gmail with TLS options
const config4 = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_STETH,
    pass: process.env.EMAIL_STETH_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
};

// Configuration 5: Gmail with all timeouts increased
const config5 = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_STETH,
    pass: process.env.EMAIL_STETH_PASS
  },
  connectionTimeout: 60000,
  greetingTimeout: 30000,
  socketTimeout: 60000
};

// Configuration 6: Gmail with connection pooling
const config6 = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  pool: true,
  maxConnections: 5,
  auth: {
    user: process.env.EMAIL_STETH,
    pass: process.env.EMAIL_STETH_PASS
  }
};

const configs = {
  config1,
  config2,
  config3,
  config4,
  config5,
  config6
};

// Test endpoint - pass config number as parameter
router.post('/test/:configNumber', auth, isAdmin, async (req, res) => {
  const configNumber = req.params.configNumber;
  const configKey = `config${configNumber}`;
  
  if (!configs[configKey]) {
    return res.status(400).json({
      success: false,
      message: `Invalid config number. Use 1-6`
    });
  }

  console.log(`\n🧪 Testing Configuration ${configNumber}...`);
  console.log('Config:', JSON.stringify(configs[configKey], null, 2));

  try {
    const transporter = nodemailer.createTransport(configs[configKey]);

    // First verify connection
    console.log('Verifying SMTP connection...');
    await transporter.verify();
    console.log('✅ SMTP connection verified');

    // Send test email
    console.log('Sending test email...');
    const info = await transporter.sendMail({
      from: process.env.EMAIL_STETH,
      to: 'ihusnain417@gmail.com',
      subject: `Test Email - Config ${configNumber} - ${new Date().toISOString()}`,
      text: `This is a test email sent using configuration ${configNumber}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color: #28a745;">✅ Email Test Successful!</h2>
            <p><strong>Configuration:</strong> ${configNumber}</p>
            <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
            <p><strong>From:</strong> ${process.env.EMAIL_STETH}</p>
            <p><strong>To:</strong> ihusnain417@gmail.com</p>
            <hr style="margin: 20px 0;">
            <p style="color: #666;">If you received this email, configuration ${configNumber} is working correctly!</p>
          </div>
        </div>
      `
    });

    console.log('✅ Email sent successfully!');
    console.log('Message ID:', info.messageId);

    return res.status(200).json({
      success: true,
      message: `Email sent successfully using config ${configNumber}`,
      messageId: info.messageId,
      configUsed: configKey,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error:', error);
    
    return res.status(500).json({
      success: false,
      message: `Failed to send email using config ${configNumber}`,
      error: error.message,
      errorCode: error.code,
      configUsed: configKey,
      timestamp: new Date().toISOString()
    });
  }
});

// Test all configs at once
router.post('/test-all', auth, isAdmin, async (req, res) => {
  const results = [];

  for (let i = 1; i <= 6; i++) {
    const configKey = `config${i}`;
    console.log(`\n🧪 Testing Configuration ${i}...`);

    try {
      const transporter = nodemailer.createTransport(configs[configKey]);
      await transporter.verify();
      
      const info = await transporter.sendMail({
        from: process.env.EMAIL_STETH,
        to: 'ihusnain417@gmail.com',
        subject: `Bulk Test - Config ${i} - ${new Date().toISOString()}`,
        text: `This is test email ${i} from bulk testing`,
        html: `<p>Test email from configuration ${i}</p>`
      });

      results.push({
        config: i,
        success: true,
        messageId: info.messageId
      });
      
      console.log(`✅ Config ${i} - SUCCESS`);
      
      // Wait 2 seconds between emails to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
      results.push({
        config: i,
        success: false,
        error: error.message,
        errorCode: error.code
      });
      console.log(`❌ Config ${i} - FAILED: ${error.message}`);
    }
  }

  const successCount = results.filter(r => r.success).length;
  
  return res.status(200).json({
    success: successCount > 0,
    message: `Tested all configurations. ${successCount}/6 successful`,
    results,
    timestamp: new Date().toISOString()
  });
});

// Simple verify endpoint - just checks connection without sending
router.get('/verify/:configNumber', auth, isAdmin, async (req, res) => {
  const configNumber = req.params.configNumber;
  const configKey = `config${configNumber}`;
  
  if (!configs[configKey]) {
    return res.status(400).json({
      success: false,
      message: `Invalid config number. Use 1-6`
    });
  }

  try {
    const transporter = nodemailer.createTransport(configs[configKey]);
    await transporter.verify();

    return res.status(200).json({
      success: true,
      message: `Config ${configNumber} connection verified successfully`,
      configUsed: configKey
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `Config ${configNumber} connection failed`,
      error: error.message,
      errorCode: error.code,
      configUsed: configKey
    });
  }
});

module.exports = router;