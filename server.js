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
// Load players from CSV
// --------------------
app.get('/api/players', (req, res) => {
  const csv = fs.readFileSync('players.csv', 'utf8');
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
// Save entry (max 4 per email)
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

  const insertEntry = db.prepare(
    'INSERT INTO entries (entry_name, email) VALUES (?, ?)'
  );
  const result = insertEntry.run(entryName, email);
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
// Get entry count for payment
// --------------------
app.get('/api/entries/count', (req, res) => {
  const email = req.query.email;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  const stmt = db.prepare(
    'SELECT COUNT(*) as count FROM entries WHERE email = ?'
  );
  const result = stmt.get(email);

  res.json({ count: result.count });
});

// --------------------
// Admin: get all entries + totals + players
// --------------------
app.get('/api/admin/entries', (req, res) => {
  const entries = db.prepare(`
    SELECT
      e.id,
      e.entry_name,
      e.email,
      e.created_at,
      SUM(
        COALESCE(s.wildcard, 0) +
        COALESCE(s.divisional, 0) +
        COALESCE(s.conference, 0) +
        COALESCE(s.superbowl, 0)
      ) AS total_score
    FROM entries e
    JOIN entry_players p ON e.id = p.entry_id
    LEFT JOIN player_scores s ON p.player_id = s.player_id
    GROUP BY e.id
    ORDER BY total_score DESC, e.created_at ASC
  `).all();

  const playersStmt = db.prepare(`
  SELECT
    p.position,
    p.player_name,
    p.team,
    COALESCE(s.wildcard, 0)   AS wildcard,
    COALESCE(s.divisional, 0) AS divisional,
    COALESCE(s.conference, 0) AS conference,
    COALESCE(s.superbowl, 0)  AS superbowl,
    COALESCE(s.wildcard, 0) +
    COALESCE(s.divisional, 0) +
    COALESCE(s.conference, 0) +
    COALESCE(s.superbowl, 0) AS player_total
  FROM entry_players p
  LEFT JOIN player_scores s ON p.player_id = s.player_id
  WHERE p.entry_id = ?
  ORDER BY p.position
`);


  const result = entries.map(e => ({
    ...e,
    players: playersStmt.all(e.id)
  }));

  res.json(result);
});

// --------------------
// Admin: export entries to CSV
// --------------------
app.get('/api/admin/export', (req, res) => {
  const rows = db.prepare(`
    SELECT
      e.entry_name,
      e.email,
      e.created_at,
      p.position,
      p.player_name,
      p.team
    FROM entries e
    JOIN entry_players p ON e.id = p.entry_id
    ORDER BY e.created_at DESC, e.entry_name
  `).all();

  let csv = 'Entry Name,Email,Created At,Position,Player Name,Team\n';

  rows.forEach(r => {
    csv += `"${r.entry_name}","${r.email}","${r.created_at}","${r.position}","${r.player_name}","${r.team}"\n`;
  });

  res.header('Content-Type', 'text/csv');
  res.header('Content-Disposition', 'attachment; filename="entries.csv"');
  res.send(csv);
});
// --------------------
// Admin: get ALL players with scores (from players.csv)
// --------------------
app.get('/api/admin/player-scores', (req, res) => {
  const csv = fs.readFileSync('players.csv', 'utf8');
  const lines = csv.trim().split('\n');

  const headers = lines[0].split(',');
  const players = lines.slice(1).map(line => {
    const values = line.split(',');
    const p = {};
    headers.forEach((h, i) => {
      p[h.trim()] = values[i].trim();
    });
    return p;
  });

  const scoreStmt = db.prepare(`
    SELECT wildcard, divisional, conference, superbowl
    FROM player_scores
    WHERE player_id = ?
  `);

  const result = players.map(p => {
    const scores = scoreStmt.get(p.PlayerID) || {};
    return {
      player_id: p.PlayerID,
      player_name: p.PlayerName,
      position: p.Position,
      team: p.TeamID,
      wildcard: scores.wildcard || 0,
      divisional: scores.divisional || 0,
      conference: scores.conference || 0,
      superbowl: scores.superbowl || 0
    };
  });

  res.json(result);
});


// --------------------
// Admin: save player scores
// --------------------
app.post('/api/admin/player-scores', (req, res) => {
  const { player_id, wildcard, divisional, conference, superbowl } = req.body;

  if (!player_id) {
    return res.status(400).json({ error: 'player_id required' });
  }

  db.prepare(`
    INSERT INTO player_scores
      (player_id, wildcard, divisional, conference, superbowl)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(player_id) DO UPDATE SET
      wildcard   = excluded.wildcard,
      divisional = excluded.divisional,
      conference = excluded.conference,
      superbowl  = excluded.superbowl
  `).run(
    player_id,
    wildcard || 0,
    divisional || 0,
    conference || 0,
    superbowl || 0
  );

  res.json({ success: true });
});

// --------------------
// Start server
// --------------------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
