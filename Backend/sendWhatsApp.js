require('dotenv').config();
const twilio = require('twilio');
const db = require('./db');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function notifyAdminWithLatestRequest() {
  const query = `
    SELECT building_name, room_number, priority, issue_description 
    FROM maintenance_requests
    WHERE status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return;
    }

    if (results.length > 0) {
      const req = results[0];

      const messageBody = `🚨 New Maintenance Request
Building: ${req.building_name}
Room: ${req.room_number}
Priority: ${req.priority}
Issue: ${req.issue_description}`;

      client.messages
        .create({
          from: `whatsapp:${process.env.TWILIO_PHONE}`,
          to: `whatsapp:${process.env.ADMIN_PHONE}`,
          body: messageBody,
        })
        .then((msg) => {
          console.log('WhatsApp notification sent:', msg.sid);
          // Update status to 'processing'
          db.query(
            `UPDATE maintenance_requests 
             SET status = 'processing' 
             WHERE building_name = ? AND room_number = ? 
             ORDER BY created_at DESC LIMIT 1`,
            [req.building_name, req.room_number]
          );
        })
        .catch((err) => console.error('Twilio Error:', err));
    } else {
      console.log('No pending maintenance requests found.');
    }
  });
}

module.exports = notifyAdminWithLatestRequest;