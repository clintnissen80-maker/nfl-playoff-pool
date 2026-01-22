const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = 3000;

// --------------------
// Database
// --------------------
const db = new Database('/var/data/entries.db');

// --------------------
// Middleware
// --------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --------------------
// Admin auth middleware
// --------------------
function requireAdmin(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(403).json({ error: "Admin only" });

  try {
    const decoded = Buffer.from(token, "base64").toString();
    if (!decoded.includes(process.env.ADMIN_PASSWORD)) {
      throw new Error("Invalid token");
    }
    next();
  } catch {
    res.status(403).json({ error: "Invalid token" });
  }
}

// --------------------
// Admin login
// --------------------
app.post("/admin-login", (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const token = Buffer.from(`${password}:${Date.now()}`).toString("base64");
  res.json({ token });
});

// --------------------
// Health
// --------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --------------------
// PUBLIC: load players.csv
// --------------------
app.get('/api/players', (req, res) => {
  const csv = fs.readFileSync(path.join(__dirname, 'players.csv'), 'utf8');
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',');

  const players = lines.slice(1).map(line => {
    const values = line.split(',');
    const p = {};
    headers.forEach((h, i) => p[h.trim()] = values[i].trim());
    return p;
  });

  res.json(players);
});

// --------------------
// Admin: playoff teams
// --------------------
app.get('/api/admin/playoff-teams', requireAdmin, (req, res) => {
  const file = '/var/data/playoff-teams.json';
  if (!fs.existsSync(file)) return res.json({ teams: [] });
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
});

app.post('/api/admin/playoff-teams', requireAdmin, (req, res) => {
  const { teams } = req.body;
  if (!Array.isArray(teams) || teams.length !== 14) {
    return res.status(400).json({ error: 'Exactly 14 teams required' });
  }
  fs.writeFileSync('/var/data/playoff-teams.json', JSON.stringify({ teams }, null, 2));
  res.json({ success: true });
});

// --------------------
// Admin: player pool
// --------------------
app.get('/api/admin/player-pool', requireAdmin, (req, res) => {
  const teamsFile = '/var/data/playoff-teams.json';
  const poolFile = '/var/data/player-pool.json';

  const teams = fs.existsSync(teamsFile)
    ? JSON.parse(fs.readFileSync(teamsFile)).teams
    : [];

  const pool = fs.existsSync(poolFile)
    ? JSON.parse(fs.readFileSync(poolFile))
    : {};

  res.json({ teams, pool });
});

app.post('/api/admin/player-pool', requireAdmin, (req, res) => {
  const { pool } = req.body;
  if (!pool || !pool.QB) {
    return res.status(400).json({ error: 'Invalid player pool' });
  }

  fs.writeFileSync('/var/data/player-pool.json', JSON.stringify(pool, null, 2));
  res.json({ success: true });
});

// --------------------
// 🚀 Phase 3C: Generate players.csv
// --------------------
app.post('/api/admin/generate-players-csv', requireAdmin, (req, res) => {
  const teamsFile = '/var/data/playoff-teams.json';
  const poolFile = '/var/data/player-pool.json';

  if (!fs.existsSync(teamsFile) || !fs.existsSync(poolFile)) {
    return res.status(400).json({ error: 'Missing playoff teams or player pool' });
  }

  const teams = JSON.parse(fs.readFileSync(teamsFile)).teams;
  const pool = JSON.parse(fs.readFileSync(poolFile));

  let rows = [];
  rows.push('PlayerID,PlayerName,Position,TeamID');

  function addPlayer(pos, team, name) {
    const cleanName = name.replace(/[^a-zA-Z0-9]/g, '');
    const playerID = `${pos}_${team}_${cleanName}`;
    rows.push(`${playerID},${name},${pos},${team}`);
  }

  // QB / RB / WR / TE
  ['QB','RB','WR','TE'].forEach(pos => {
    if (!pool[pos]) return;
    Object.keys(pool[pos]).forEach(team => {
      pool[pos][team].forEach(p => addPlayer(pos, team, p.name));
    });
  });

  // Kickers (auto)
  teams.forEach(team => {
    addPlayer('K', team, `${team}K`);
  });

  fs.writeFileSync(
    path.join(__dirname, 'players.csv'),
    rows.join('\n'),
    'utf8'
  );

  res.json({ success: true, count: rows.length - 1 });
});

// --------------------
// Start server
// --------------------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
