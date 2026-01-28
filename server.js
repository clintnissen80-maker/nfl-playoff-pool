const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = 3000;

// --------------------
// Files
// --------------------
const SETTINGS_FILE = '/var/data/settings.json';

// --------------------
// Database
// --------------------
const db = new Database('/var/data/entries.db');

// --------------------
// DB migration: add paid / notes columns if missing
// --------------------
try {
  db.prepare(`ALTER TABLE entries ADD COLUMN paid INTEGER DEFAULT 0`).run();
} catch (e) {
  // column already exists
}

try {
  db.prepare(`ALTER TABLE entries ADD COLUMN notes TEXT DEFAULT ''`).run();
} catch (e) {
  // column already exists
}

db.prepare(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_name TEXT NOT NULL,
    email TEXT NOT NULL,
    paid INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
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
// Settings helpers
// --------------------
function getSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return { entriesOpen: true };
  }
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
}

function saveSettings(settings) {
  fs.writeFileSync(
    SETTINGS_FILE,
    JSON.stringify(settings, null, 2),
    'utf8'
  );
}

// --------------------
// Middleware
// --------------------
app.use(express.json({ limit: "10mb" })); // Increased limit for bulk CSV imports
app.use(express.static(path.join(__dirname, 'public')));

// --------------------
// Admin auth middleware
// --------------------
function requireAdmin(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(403).json({ error: "Admin only" });

  try {
    const decoded = Buffer.from(token, "base64").toString();
    const adminPass = process.env.ADMIN_PASSWORD || "admin123";
    if (!decoded.includes(adminPass)) {
      throw new Error("Invalid token");
    }
    next();
  } catch {
    res.status(403).json({ error: "Invalid token" });
  }
}

// --------------------
// TOOL: Player Debug (Helps check CSV names)
// --------------------
app.get('/api/player-list-debug', (req, res) => {
  try {
    const csvText = fs.readFileSync(path.join(__dirname, 'players.csv'), 'utf8');
    const lines = csvText.trim().split('\n');
    lines.shift();
    let html = "<h1>Valid Player List</h1><table border='1'><tr><th>Name</th><th>Team</th><th>Pos</th><th>CSV Paste Format</th></tr>";
    lines.forEach(line => {
      const [pid, pname, pos, team] = line.split(',');
      html += `<tr><td>${pname}</td><td>${team}</td><td>${pos}</td><td><b>${pname}|${team}</b></td></tr>`;
    });
    res.send(html);
  } catch (err) { res.status(500).send(err.message); }
});

function regeneratePlayersCSV() {
  const teamsFile = '/var/data/playoff-teams.json';
  const poolFile = '/var/data/player-pool.json';

  if (!fs.existsSync(teamsFile) || !fs.existsSync(poolFile)) {
    console.log('⚠️ Skipping players.csv generation (missing data)');
    return;
  }

  const teams = JSON.parse(fs.readFileSync(teamsFile)).teams;
  const pool = JSON.parse(fs.readFileSync(poolFile));

  const rows = ['PlayerID,PlayerName,Position,TeamID'];

  function add(pos, team, name) {
    const clean = name.replace(/[^a-zA-Z0-9]/g, '');
    rows.push(`${pos}_${team}_${clean},${name},${pos},${team}`);
  }

  ['QB','RB','WR','TE'].forEach(pos => {
    if (!pool[pos]) return;
    Object.keys(pool[pos]).forEach(team => {
      pool[pos][team].forEach(p => add(pos, team, p.name));
    });
  });

  teams.forEach(team => add('K', team, `${team}K`));

  fs.writeFileSync(
    path.join(__dirname, 'players.csv'),
    rows.join('\n'),
    'utf8'
  );

  console.log(`✅ players.csv regenerated (${rows.length - 1} players)`);
}

// --------------------
// Admin login
// --------------------
app.post("/admin-login", (req, res) => {
  const { password } = req.body;
  const adminPass = process.env.ADMIN_PASSWORD || "admin123";

  if (password !== adminPass) {
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
// PUBLIC: save entry
// --------------------
app.post('/api/entries', (req, res) => {
  const settings = getSettings();
  if (!settings.entriesOpen) {
    return res.status(403).json({ error: 'Entries are currently closed' });
  }

  const { entryName, email, players } = req.body;

  if (!entryName || !email || !Array.isArray(players) || players.length !== 14) {
    return res.status(400).json({ error: 'Invalid entry data' });
  }

  const count = db
    .prepare('SELECT COUNT(*) AS c FROM entries WHERE email = ?')
    .get(email).c;

  if (count >= 4) {
    return res.status(400).json({ error: 'Maximum of 4 entries per email reached.' });
  }

  const finalName = count > 0 ? `${entryName}-${count + 1}` : entryName;

  const result = db
    .prepare('INSERT INTO entries (entry_name, email) VALUES (?, ?)')
    .run(finalName, email);

  const entryId = result.lastInsertRowid;

  const insertPlayer = db.prepare(`
    INSERT INTO entry_players (entry_id, player_id, player_name, position, team)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(players => {
    players.forEach(p => {
      insertPlayer.run(entryId, p.id, p.name, p.position, p.team);
    });
  });

  insertMany(players);
  res.json({ success: true, entryId });
});

app.get('/api/entries/count', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE email = ?').get(email).c;
  res.json({ count });
});

// --------------------
// PUBLIC: leaderboard
// --------------------
app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT
      e.id,
      e.entry_name,
      SUM(COALESCE(s.wildcard,0) + COALESCE(s.divisional,0) + COALESCE(s.conference,0) + COALESCE(s.superbowl,0)) AS total_score
    FROM entries e
    JOIN entry_players p ON e.id = p.entry_id
    LEFT JOIN player_scores s ON p.player_id = s.player_id
    GROUP BY e.id
    ORDER BY total_score DESC, e.created_at ASC
  `).all();
    // attach players to each entry
// attach players to each entry
for (const entry of rows) {
  const players = db.prepare(`
    SELECT player_name AS name, team
    FROM entry_players
    WHERE entry_id = ?
  `).all(entry.id);

  entry.players = players;
}

  res.json(rows);
});

app.get('/api/entry-status', (req, res) => res.json(getSettings()));

// --------------------
// Admin Endpoints
// --------------------
app.get('/api/admin/entry-status', requireAdmin, (req, res) => res.json(getSettings()));

app.post('/api/admin/entry-status', requireAdmin, (req, res) => {
  const { entriesOpen } = req.body;
  const settings = getSettings();
  settings.entriesOpen = !!entriesOpen;
  saveSettings(settings);
  res.json({ success: true });
});

app.post('/api/admin/entry-payment', requireAdmin, (req, res) => {
  const { entryId, paid } = req.body;
  db.prepare(`UPDATE entries SET paid = ? WHERE id = ?`).run(paid ? 1 : 0, entryId);
  res.json({ success: true });
});

app.post('/api/admin/entry-notes', requireAdmin, (req, res) => {
  const { entryId, notes } = req.body;
  db.prepare(`UPDATE entries SET notes = ? WHERE id = ?`).run(notes || '', entryId);
  res.json({ success: true });
});

app.get('/api/admin/playoff-teams', requireAdmin, (req, res) => {
  const file = '/var/data/playoff-teams.json';
  res.json(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { teams: [] });
});

app.post('/api/admin/playoff-teams', requireAdmin, (req, res) => {
  const { teams } = req.body;
  fs.writeFileSync('/var/data/playoff-teams.json', JSON.stringify({ teams }, null, 2));
  res.json({ success: true });
});

app.post('/api/admin/reset-playoff-setup', requireAdmin, (req, res) => {
  [ '/var/data/playoff-teams.json', '/var/data/player-pool.json' ].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
  regeneratePlayersCSV();
  res.json({ success: true });
});

app.get('/api/admin/player-pool', requireAdmin, (req, res) => {
  const teamsFile = '/var/data/playoff-teams.json';
  const poolFile = '/var/data/player-pool.json';
  const teams = fs.existsSync(teamsFile) ? JSON.parse(fs.readFileSync(teamsFile)).teams : [];
  const pool = fs.existsSync(poolFile) ? JSON.parse(fs.readFileSync(poolFile)) : {};
  res.json({ teams, pool });
});

app.post('/api/admin/player-pool', requireAdmin, (req, res) => {
  fs.writeFileSync('/var/data/player-pool.json', JSON.stringify(req.body.pool, null, 2));
  regeneratePlayersCSV();
  res.json({ success: true, regenerated: true });
});

app.post('/api/admin/generate-players-csv', requireAdmin, (req, res) => {
  regeneratePlayersCSV();
  res.json({ success: true });
});

app.get('/api/admin/entries', requireAdmin, (req, res) => {
  const entries = db.prepare(`
    SELECT e.*, SUM(COALESCE(s.wildcard,0) + COALESCE(s.divisional,0) + COALESCE(s.conference,0) + COALESCE(s.superbowl,0)) AS total_score
    FROM entries e JOIN entry_players p ON e.id = p.entry_id LEFT JOIN player_scores s ON p.player_id = s.player_id
    GROUP BY e.id ORDER BY total_score DESC, e.created_at ASC
  `).all();
  const stmt = db.prepare(`
    SELECT p.*, COALESCE(s.wildcard,0) as wildcard, COALESCE(s.divisional,0) as divisional, COALESCE(s.conference,0) as conference, COALESCE(s.superbowl,0) as superbowl,
    (COALESCE(s.wildcard,0) + COALESCE(s.divisional,0) + COALESCE(s.conference,0) + COALESCE(s.superbowl,0)) as player_total
    FROM entry_players p LEFT JOIN player_scores s ON p.player_id = s.player_id WHERE p.entry_id = ? ORDER BY p.position
  `);
  res.json(entries.map(e => ({ ...e, players: stmt.all(e.id) })));
});

app.get('/api/admin/player-scores', (req, res) => {
  const csv = fs.readFileSync(path.join(__dirname, 'players.csv'), 'utf8');
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',');
  const players = lines.slice(1).map(line => {
    const val = line.split(',');
    const p = {};
    headers.forEach((h, i) => p[h.trim()] = val[i].trim());
    return p;
  });
  const stmt = db.prepare(`SELECT * FROM player_scores WHERE player_id = ?`);
  res.json(players.map(p => ({ player_id: p.PlayerID, player_name: p.PlayerName, position: p.Position, team: p.TeamID, ...(stmt.get(p.PlayerID) || {}) })));
});

app.post('/api/admin/player-scores', requireAdmin, (req, res) => {
  const { player_id, wildcard, divisional, conference, superbowl } = req.body;
  db.prepare(`
    INSERT INTO player_scores (player_id, wildcard, divisional, conference, superbowl) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(player_id) DO UPDATE SET wildcard=excluded.wildcard, divisional=excluded.divisional, conference=excluded.conference, superbowl=excluded.superbowl
  `).run(player_id, wildcard || 0, divisional || 0, conference || 0, superbowl || 0);
  res.json({ success: true });
});

app.post('/api/admin/reset-season', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM entry_players').run();
  db.prepare('DELETE FROM entries').run();
  db.prepare('DELETE FROM player_scores').run();
  res.json({ success: true });
});

// --------------------
// Admin: IMPORT ENTRIES (FIXED FOR KICKERS)
// --------------------
app.post('/api/admin/import-entries', requireAdmin, (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No data' });

    const csvText = fs.readFileSync(path.join(__dirname, 'players.csv'), 'utf8');
    const lines = csvText.trim().split('\n');
    lines.shift();

    const lookup = {};
    lines.forEach(line => {
      const [pid, pname, pos, team] = line.split(',');
      const key = `${pname.toUpperCase()}|${team.toUpperCase()}|${pos.toUpperCase()}`;
      lookup[key] = pid;
    });

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM entry_players').run();
      db.prepare('DELETE FROM entries').run();

      const insEntry = db.prepare(`INSERT INTO entries (entry_name, email, paid, notes) VALUES (?, ?, ?, ?)`);
      const insPlayer = db.prepare(`INSERT INTO entry_players (entry_id, player_id, player_name, position, team) VALUES (?, ?, ?, ?, ?)`);

      rows.forEach(row => {
        const entryId = insEntry.run(row.entry_name, row.email, row.paid ? 1 : 0, row.notes || '').lastInsertRowid;
        row.players.forEach(p => {
          let pName = p.player_name.trim();
          let pTeam = p.team.trim().toUpperCase();
          let pPos = p.position.trim().toUpperCase();

          // 🦶 SPECIAL KICKER LOGIC: Handle "PITK" names where Team might be missing
          if (pPos === 'K' && (!pTeam || pTeam === "UNDEFINED")) {
             pTeam = pName.substring(0, pName.length - 1);
          }

          const searchKey = `${pName.toUpperCase()}|${pTeam}|${pPos}`;
          const realId = lookup[searchKey];

          if (!realId) throw new Error(`Player not found: ${pName}|${pTeam}|${pPos}. Check player list debug.`);
          insPlayer.run(entryId, realId, pName, pPos, pTeam);
        });
      });
    });
    tx();
    res.json({ success: true, imported: rows.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT entry_name, email, paid, notes, created_at FROM entries ORDER BY created_at DESC`).all();
  let csv = 'Entry Name,Email,Paid,Notes,Created At\n';
  rows.forEach(r => { csv += `"${r.entry_name}","${r.email}","${r.paid ? 'YES' : 'NO'}","${r.notes || ''}","${r.created_at}"\n`; });
  res.header('Content-Type', 'text/csv');
  res.header('Content-Disposition', 'attachment; filename="entries_export.csv"');
  res.send(csv);
});

// --------------------
// Start server
// --------------------
regeneratePlayersCSV();
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });