// =============================================
// 1. ENVIRONMENT SETUP & CONFIGURATION
// =============================================
require('dotenv').config();

console.log('🔧 System Configuration:');
console.log(`- Server Port: ${process.env.PORT || 3000}`);
console.log(`- Database: ${process.env.DB_NAME || 'campus_maintenance'}`);
console.log(`- Twilio: ${process.env.TWILIO_PHONE ? '✅ Configured' : '❌ Not Configured'}`);

// =============================================
// 2. REQUIRE DEPENDENCIES
// =============================================
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const cron = require('node-cron');
const twilio = require('twilio');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

// =============================================
// 3. INITIALIZE APPLICATION
// =============================================
const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware app.use(helmet());
// In server.js, update CORS to match your frontend origin
app.use(cors({
  origin: '*', // For testing only!
  methods: ['GET', 'POST']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// 4. FILE UPLOAD CONFIGURATION
// =============================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed!'), false);
    }
  }
});

// =============================================
// 5. TWILIO INITIALIZATION
// =============================================
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// =============================================
// 6. DATABASE CONNECTION POOL
// =============================================
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'campus_maintenance',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// =============================================
// 7. DEFAULT ADMIN CREATION
// =============================================
async function createDefaultAdmin() {
  try {
    const [admin] = await pool.query(
      "SELECT * FROM users WHERE role = 'admin' LIMIT 1"
    );
    
    if (admin.length === 0) {
      const hashedPassword = await bcrypt.hash(
        process.env.ADMIN_DEFAULT_PASSWORD || 'admin123', 
        10
      );
      
      await pool.query(
        `INSERT INTO users (name, email, phone, password, role) 
         VALUES (?, ?, ?, ?, 'admin')`,
        [
          'System Admin',
          'admin@mit.edu',
          process.env.ADMIN_PHONE || '1234567890',
          hashedPassword
        ]
      );
      console.log('👨‍💻 Default admin user created');
    }
  } catch (err) {
    console.error('❌ Failed to create default admin:', err);
  }
}

// =============================================
// 8. DATABASE SCHEMA VERIFICATION
// =============================================
async function verifyDatabaseSchema() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      phone VARCHAR(20) NOT NULL,
      password VARCHAR(255) NOT NULL,
      role ENUM('teacher', 'admin') DEFAULT 'teacher',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS maintenance_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      building_name VARCHAR(100) NOT NULL,
      room_number VARCHAR(20) NOT NULL,
      priority ENUM('low', 'medium', 'high') DEFAULT 'medium',
      issue_description TEXT NOT NULL,
      photo LONGTEXT,
      status ENUM('pending', 'notified', 'in_progress', 'completed') DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      request_id INT NOT NULL,
      message_sid VARCHAR(50),
      status VARCHAR(20) NOT NULL,
      recipient VARCHAR(20) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (request_id) REFERENCES maintenance_requests(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ];

  try {
    for (const table of tables) {
      await pool.query(table);
    }
    console.log('✅ Database tables verified/created');
    await createDefaultAdmin();
  } catch (err) {
    console.error('❌ Database schema verification failed:', err);
  }
}

// =============================================
// 9. JWT CONFIGURATION
// =============================================
const JWT_SECRET = process.env.JWT_SECRET || 'your-strong-secret-key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

// =============================================
// 10. AUTHENTICATION MIDDLEWARES
// =============================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: `Access restricted to ${role}s only` });
    }
    next();
  };
}

// =============================================
// 11. API ROUTES
// =============================================

// 🔐 AUTHENTICATION ROUTES
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ 
      success: false,
      error: 'Email and password are required' 
    });
  }

  try {
    const [users] = await pool.query(
      'SELECT id, name, email, phone, password, role FROM users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid credentials' 
      });
    }

    const user = users[0];
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid credentials' 
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    delete user.password;
    
    res.json({ 
      success: true,
      token,
      user
    });
    
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ 
      success: false,
      error: 'Server error during authentication' 
    });
  }
});

// 🏗️ MAINTENANCE REQUEST ROUTES
app.post('/maintenance', authenticateToken, upload.single('photo'), async (req, res) => {
  if (req.file?.size > 1 * 1024 * 1024) {
    return res.status(400).json({ error: "Image must be ≤1MB" });
  }

  try {
    const { buildingName, roomNumber, priority, issueDescription } = req.body;
    
    const [result] = await pool.query(
      `INSERT INTO maintenance_requests 
      (user_id, building_name, room_number, priority, issue_description, photo)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        buildingName, 
        roomNumber,
        priority,
        issueDescription,
        req.file?.buffer.toString('base64') || null
      ]
    );
    
    res.json({ 
      success: true,
      requestId: result.insertId 
    });
  } catch (err) {
    console.error('Maintenance request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

app.get('/my-requests', authenticateToken, async (req, res) => {
  try {
    const [requests] = await pool.query(
      `SELECT * FROM maintenance_requests 
       WHERE user_id = ? 
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/admin/requests', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { status } = req.query;
    let query = `SELECT mr.*, u.name as user_name 
                 FROM maintenance_requests mr
                 JOIN users u ON mr.user_id = u.id`;
    
    if (status && status !== 'all') {
      query += ` WHERE mr.status = '${status}'`;
    }
    
    query += ` ORDER BY mr.created_at DESC`;
    
    const [requests] = await pool.query(query);
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/admin/requests/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query(
      `UPDATE maintenance_requests SET status = ? WHERE id = ?`,
      [status, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// =============================================
// 12. TWILIO NOTIFICATION CRON JOB
// =============================================
cron.schedule('*/10 * * * * *', async () => {
  if (!process.env.TWILIO_PHONE || !process.env.ADMIN_PHONE) {
    console.log('⏰ Twilio notifications disabled - missing configuration');
    return;
  }

  try {
    const [requests] = await pool.query(`
      SELECT mr.*, u.name, u.phone 
      FROM maintenance_requests mr
      JOIN users u ON mr.user_id = u.id
      WHERE mr.status = 'pending'
      ORDER BY mr.created_at DESC
      LIMIT 1
    `);

    if (requests.length > 0) {
      const request = requests[0];
      
      const message = await twilioClient.messages.create({
        body: `🚨 NEW MAINTENANCE REQUEST\n\n` +
              `Submitted by: ${request.name}\n` +
              `Building: ${request.building_name}\n` +
              `Room: ${request.room_number}\n` +
              `Priority: ${request.priority}\n` +
              `Description: ${request.issue_description.substring(0, 100)}...`,
        from: `whatsapp:${process.env.TWILIO_PHONE}`,
        to: `whatsapp:${process.env.ADMIN_PHONE}`
      });
      
      await pool.query(
        `UPDATE maintenance_requests SET status = 'notified' WHERE id = ?`,
        [request.id]
      );
      
      await pool.query(
        `INSERT INTO notifications 
        (request_id, message_sid, status, recipient)
        VALUES (?, ?, 'sent', ?)`,
        [request.id, message.sid, process.env.ADMIN_PHONE]
      );

      console.log(`✅ WhatsApp notification sent for request ID: ${request.id}`);
    }
  } catch (err) {
    console.error('❌ Twilio notification failed:', err.message);
  }
});

// =============================================
// 13. DATABASE INITIALIZATION
// =============================================
(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Successfully connected to MySQL database');
    conn.release();
    await verifyDatabaseSchema();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    process.exit(1);
  }
})();

// =============================================
// 14. SERVER STARTUP
// =============================================
app.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log('\n🔐 Active Endpoints:');
  console.log('- POST /login');
  console.log('- POST /maintenance (authenticated)');
  console.log('- GET /my-requests (authenticated)');
  console.log('- GET /admin/requests (admin only)');
  console.log('- PUT /admin/requests/:id (admin only)');
  console.log('\n⏰ Twilio cron job running every 10 seconds');
});

process.on('SIGTERM', () => {
  pool.end();
  console.log('\n🛑 Server shutting down gracefully');
  process.exit(0);
});