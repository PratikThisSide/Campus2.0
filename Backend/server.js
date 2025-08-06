const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;

// Middleware to parse form data
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Hardcoded users
const users = {
  admin: { password: 'admin123', role: 'admin' },
  user1: { password: 'user123', role: 'user' },
  user2: { password: 'test456', role: 'user' },
};

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];

  if (user && user.password === password) {
    // Redirect based on role
    if (user.role === 'admin') {
      res.redirect('/admin-home.html');
    } else {
      res.redirect('/user-home.html');
    }
  } else {
    res.send('Invalid credentials!');
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
