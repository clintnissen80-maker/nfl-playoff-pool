const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = 3000;

// --------------------
// Season config files
// --------------------
const PLAYOFF_TEAMS_FILE = '/var/data/playoff-teams.json';
const PLAYER_POOL_FILE = '/var/data/player-pool.json';

function getPlayoffTeams() {
  if (!fs.existsSync(PLAYOFF_TEAMS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PLAYOFF_TEAMS_FILE, 'utf8')).teams || [];
}

function getPlayerPool() {
  if (!fs.existsSync(PLAYER_POOL_FILE)) return {};
  return JSON.parse(fs.readFileSync(PLAYER_POOL_FILE, 'utf8'));
}

// --------------------
// Database
// --------------------
const db = new Database('/var/data/entries.db');

// Create tables if they don't exist
db.prepare(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_name TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS entry_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    position TEXT NOT NULL,
    team TEXT NOT NULL,
    FOREIGN KEY (entry_id) REFERENCES entries(id)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS player_scores (
    player_id TEXT PRIMARY KEY,
    wildcard INTEGER DEFAULT 0,
    divisional INTEGER DEFAULT 0,
    conference INTEGER DEFAULT 0,
    superbowl INTEGER DEFAULT 0
  )
`).run();

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

  if (!token) {
    return res.status(403).json({ error: "Admin only" });
  }

  try {
    const decoded = Buffer.from(token, "base64").toString();
    if (!decoded.includes(process.env.ADMIN_PASSWORD)) {
      throw new Error("Invalid token");
    }
    next();
  } catch {
    return res.status(403).json({ error: "Invalid token" });
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

  const token = Buffer.from(
    `${password}:${Date.now()}`
  ).toString("base64");

  res.json({ token });
});

// --------------------
// Health check
// --------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --------------------
// Load players from CSV (PUBLIC)
// --------------------
app.get('/api/players', (req, res) => {
  const csv = fs.readFileSync(path.join(__dirname, 'players.csv'), 'utf8');
  const lines = csv.trim().split('\n');

  const headers = lines[0].split(',');
  const players = lines.slice(1).map(line => {
    const values = line.split(',');
    const player = {};
    headers.forEach((h, i) => {
      player[h.trim()] = values[i].trim();
    });
    return player;
  });

  res.json(players);
});

// --------------------
// Admin: get saved playoff teams
// --------------------
app.get('/api/admin/playoff-teams', requireAdmin, (req, res) => {
  if (!fs.existsSync(PLAYOFF_TEAMS_FILE)) {
    return res.json({ teams: [] });
  }
  res.json(JSON.parse(fs.readFileSync(PLAYOFF_TEAMS_FILE, 'utf8')));
});

// --------------------
// Admin: save playoff teams
// --------------------
app.post('/api/admin/playoff-teams', requireAdmin, (req, res) => {
  const { teams } = req.body;

  if (!Array.isArray(teams) || teams.length !== 14) {
    return res.status(400).json({ error: 'Exactly 14 teams required' });
  }

  fs.writeFileSync(
    PLAYOFF_TEAMS_FILE,
    JSON.stringify({ teams }, null, 2),
    'utf8'
  );

  res.json({ success: true });
});

// ====================
// PHASE 3A – PLAYER POOL BACKEND
// ====================

// --------------------
// Admin: get player pool
// --------------------
app.get('/api/admin/player-pool', requireAdmin, (req, res) => {
  const playoffTeams = getPlayoffTeams();
  if (playoffTeams.length !== 14) {
    return res.status(400).json({ error: 'Playoff teams not set' });
  }

  res.json({
    teams: playoffTeams,
    pool: getPlayerPool()
  });
});

// --------------------
// Admin: save player pool
// --------------------
app.post('/api/admin/player-pool', requireAdmin, (req, res) => {
  const { pool } = req.body;
  const playoffTeams = getPlayoffTeams();

  if (!pool || typeof pool !== 'object') {
    return res.status(400).json({ error: 'Invalid pool format' });
  }

  // Validate QB: exactly 1 per team
  if (pool.QB) {
    for (const team of playoffTeams) {
      const qbs = pool.QB[team] || [];
      if (qbs.length !== 1) {
        return res.status(400).json({
          error: `Team ${team} must have exactly 1 QB`
        });
      }
    }
  }

  // Validate all teams are playoff teams
  for (const position of Object.keys(pool)) {
    for (const team of Object.keys(pool[position])) {
      if (!playoffTeams.includes(team)) {
        return res.status(400).json({
          error: `Invalid team ${team} in ${position}`
        });
      }
    }
  }

  fs.writeFileSync(
    PLAYER_POOL_FILE,
    JSON.stringify(pool, null, 2),
    'utf8'
  );

  res.json({ success: true });
});

// ====================
// EXISTING ENTRY + ADMIN ROUTES
// ====================

// --------------------
// Save entry (PUBLIC)
// --------------------
app.post('/api/entries', (req, res) => {
  const { entryName, email, players } = req.body;

  if (!entryName || !email || !Array.isArray(players) || players.length !== 14) {
    return res.status(400).json({ error: 'Invalid entry data' });
  }

  const countStmt = db.prepare(
    'SELECT COUNT(*) as count FROM entries WHERE email = ?'
  );
  const existingCount = countStmt.get(email).count;

  if (existingCount >= 4) {
    return res.status(400).json({
      error: 'Maximum of 4 entries per email reached.'
    });
  }

  let finalEntryName = entryName;
  if (existingCount > 0) {
    finalEntryName = `${entryName}-${existingCount + 1}`;
  }

  const insertEntry = db.prepare(
    'INSERT INTO entries (entry_name, email) VALUES (?, ?)'
  );
  const result = insertEntry.run(finalEntryName, email);
  const entryId = result.lastInsertRowid;

  const insertPlayer = db.prepare(
    `INSERT INTO entry_players
     (entry_id, player_id, player_name, position, team)
     VALUES (?, ?, ?, ?, ?)`
  );

  const insertMany = db.transaction(players => {
    for (const p of players) {
      insertPlayer.run(
        entryId,
        p.id,
        p.name,
        p.position,
        p.team
      );
    }
  });

  insertMany(players);

  res.json({ success: true, entryId });
});

// --------------------
// Start server
// --------------------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
