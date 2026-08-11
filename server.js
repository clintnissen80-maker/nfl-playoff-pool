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

// Use Render's persistent disk path if it exists, otherwise use a local file
const dbDir = fs.existsSync('/var/data') ? '/var/data' : __dirname;
const dbPath = path.join(dbDir, 'entries.db');

const db = new Database(dbPath);
console.log(`Database loaded successfully from: ${dbPath}`);

// ==========================================
// NFL FIRST 4-WEEKS CHALLENGE TABLES
// ==========================================
// 1. Table to store team scores for weeks 1-4
db.exec(`CREATE TABLE IF NOT EXISTS challenge_scores (
  team_tri_code TEXT PRIMARY KEY,
  week1_pts INTEGER DEFAULT 0,
  week2_pts INTEGER DEFAULT 0,
  week3_pts INTEGER DEFAULT 0,
  week4_pts INTEGER DEFAULT 0
)`);

// 2. Table to store user entries
db.exec(`CREATE TABLE IF NOT EXISTS challenge_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_name TEXT NOT NULL UNIQUE,
  team1 TEXT NOT NULL,
  team2 TEXT NOT NULL,
  team3 TEXT NOT NULL,
  team4 TEXT NOT NULL,
  team5 TEXT NOT NULL,
  team6 TEXT NOT NULL,
  tiebreaker INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Add paid status column if missing
try {
  db.prepare(`ALTER TABLE challenge_entries ADD COLUMN paid INTEGER DEFAULT 0`).run();
} catch (e) {
  // column already exists
}

// Seed the 32 NFL teams if the scores table is empty
const checkTeams = db.prepare("SELECT COUNT(*) as count FROM challenge_scores").get();
if (checkTeams && checkTeams.count === 0) {
  const teams = [
    'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB',
    'HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG',
    'NYJ','PHI','PIT','SF','SEA','TB','TEN','WAS'
  ];
  
  const insertTeam = db.prepare("INSERT INTO challenge_scores (team_tri_code) VALUES (?)");
  
  // better-sqlite3 uses a transaction for bulk inserts to keep it fast and safe
  const insertMany = db.transaction((teamList) => {
    for (const team of teamList) insertTeam.run(team);
  });
  
  insertMany(teams);
  console.log("Challenge teams seeded successfully.");
}

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
    return { 
      entriesOpen: true,          // Controls the Playoff Pool
      challengeEntriesOpen: true   // Controls the 4-Weeks Challenge
    };
  }
  const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  
  // Ensure default fallbacks if older settings file exists
  if (settings.entriesOpen === undefined) settings.entriesOpen = true;
  if (settings.challengeEntriesOpen === undefined) settings.challengeEntriesOpen = true;
  
  return settings;
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
    // Strip "Bearer " or "Basic " prefixes if present
    const cleanToken = token.replace(/^(Bearer|Basic)\s+/i, '').trim();
    const decoded = Buffer.from(cleanToken, "base64").toString('utf8');
    const adminPass = process.env.ADMIN_PASSWORD || "admin123";

    if (decoded.includes(adminPass) || cleanToken === adminPass) {
      return next();
    }
    throw new Error("Invalid token credential");
  } catch (err) {
    return res.status(403).json({ error: "Invalid token" });
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
  if (!settings.challengeEntriesOpen) {
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
app.get('/api/admin/entry-status', (req, res) => res.json(getSettings()));

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

// ==========================================
// NFL FIRST 4-WEEKS CHALLENGE ROUTES
// ==========================================

// --------------------
// Admin Security Middleware
// --------------------
function requireAdmin(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(403).json({ error: "Admin token missing" });

  try {
    const cleanToken = token.replace(/^(Bearer|Basic)\s+/i, '').trim();
    const decoded = Buffer.from(cleanToken, "base64").toString('utf8');
    const adminPass = process.env.ADMIN_PASSWORD || "admin123";

    if (decoded === adminPass || decoded.includes(adminPass)) {
      return next();
    }
    return res.status(403).json({ error: "Invalid admin password" });
  } catch (err) {
    return res.status(403).json({ error: "Invalid token encoding" });
  }
}

// --------------------
// Admin Entry Lock Status Endpoints
// --------------------
// Check lock status (requires password token)
// Admin Entry Lock Status Endpoints for 4-Weeks Challenge
app.get('/api/admin/challenge-entry-status', requireAdmin, (req, res) => {
    const settings = getSettings();
    res.json({ entriesOpen: settings.challengeEntriesOpen });
});

app.post('/api/admin/challenge-entry-status', requireAdmin, (req, res) => {
    const { entriesOpen } = req.body;
    
    const settings = getSettings();
    settings.challengeEntriesOpen = !!entriesOpen;
    saveSettings(settings);

    res.json({ success: true, entriesOpen: settings.challengeEntriesOpen });
});

// --------------------
// Page Routes
// --------------------

// Entry Page Routes
app.get('/four-weeks-entry', (req, res) => {
    res.sendFile(path.join(__dirname, 'four-weeks-entry.html'));
});
app.get('/four-weeks-entry.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'four-weeks-entry.html'));
});

// Leaderboard Page Routes
app.get('/four-weeks-leaderboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'four-weeks-leaderboard.html'));
});
app.get('/four-weeks-leaderboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'four-weeks-leaderboard.html'));
});

// Hidden Admin Page Routes
app.get('/admin/manage-4w-pool-x97q2', (req, res) => {
    res.sendFile(path.join(__dirname, 'four-weeks-admin.html'));
});
app.get('/admin/manage-4w-pool-x97q2.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'four-weeks-admin.html'));
});

// API Endpoint to process and save a new challenge entry
app.post('/api/challenge-submit', (req, res) => {
    try {
        // 0. Check if entries are open
        const settings = getSettings();
        if (!settings.entriesOpen) {
            return res.status(403).json({ success: false, message: "Entries are currently CLOSED for the 4-Weeks Challenge." });
        }

        const { entryName, teams, tiebreaker } = req.body;

        // 1. Basic Validation
        if (!entryName || !teams || !Array.isArray(teams) || teams.length !== 6 || !tiebreaker) {
            return res.status(400).json({ success: false, message: "Missing fields or invalid team selection." });
        }

        // 2. Server-side Duplicate Check (safety fallback)
        const uniqueTeams = [...new Set(teams)];
        if (uniqueTeams.length !== 6) {
            return res.status(400).json({ success: false, message: "Duplicate teams are not allowed." });
        }

        // 3. Insert into the database using better-sqlite3 syntax
        const stmt = db.prepare(`
            INSERT INTO challenge_entries (entry_name, team1, team2, team3, team4, team5, team6, tiebreaker)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(entryName, teams[0], teams[1], teams[2], teams[3], teams[4], teams[5], tiebreaker);

        // Success response
        return res.json({ success: true, message: "Entry successfully submitted! Good luck!" });

    } catch (error) {
        console.error("Database Error during entry submission:", error);
        
        // Handle unique name constraint violation
        if (error.message && error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ success: false, message: "That Entry Name is already taken. Please choose another!" });
        }
        
        return res.status(500).json({ success: false, message: "Internal server error saving your entry." });
    }
});

// API to get all team scores for the admin panel
app.get('/api/challenge-scores', (req, res) => {
    try {
        const scores = db.prepare("SELECT * FROM challenge_scores ORDER BY team_tri_code ASC").all();
        res.json({ success: true, scores });
    } catch (error) {
        console.error("Error fetching challenge scores:", error);
        res.status(500).json({ success: false, message: "Failed to retrieve team scores." });
    }
});

// API to save updated scores for a specific week
app.post('/api/challenge-save-scores', (req, res) => {
    try {
        const { week, scores } = req.body; // week = 'week1_pts', 'week2_pts', etc.
        
        // Validation
        const validWeeks = ['week1_pts', 'week2_pts', 'week3_pts', 'week4_pts'];
        if (!validWeeks.includes(week) || !scores || typeof scores !== 'object') {
            return res.status(400).json({ success: false, message: "Invalid week or scores payload." });
        }

        // Run updates inside a fast transaction
        const updateStmt = db.prepare(`
            UPDATE challenge_scores 
            SET ${week} = ? 
            WHERE team_tri_code = ?
        `);

        const updateTransaction = db.transaction((scoreData) => {
            for (const [team, pts] of Object.entries(scoreData)) {
                // Ensure we save numbers, default to 0 if blank
                const pointsValue = parseInt(pts) || 0;
                updateStmt.run(pointsValue, team);
            }
        });

        updateTransaction(scores);

        res.json({ success: true, message: `Successfully updated scores for ${week.replace('_pts', '').toUpperCase()}!` });

    } catch (error) {
        console.error("Error saving challenge scores:", error);
        res.status(500).json({ success: false, message: "Failed to save team scores." });
    }
});

// API to calculate and fetch the dynamic leaderboard rankings
app.get('/api/challenge-leaderboard', (req, res) => {
    try {
        // Check lock status from settings
        const settings = getSettings();
        const isLocked = !settings.challengeEntriesOpen;

        // 1. Fetch all entries
        const entries = db.prepare("SELECT * FROM challenge_entries").all();
        
        // 2. Fetch all team scores and index them into an easy look-up object
        const teamRows = db.prepare("SELECT * FROM challenge_scores").all();
        const teamScoresMap = {};
        teamRows.forEach(row => {
            teamScoresMap[row.team_tri_code] = {
                w1: row.week1_pts,
                w2: row.week2_pts,
                w3: row.week3_pts,
                w4: row.week4_pts
            };
        });

        // 3. Loop through every single user entry and compute their weekly totals
        const leaderboardData = entries.map(entry => {
            const chosenTeams = [entry.team1, entry.team2, entry.team3, entry.team4, entry.team5, entry.team6];
            
            let w1Total = 0;
            let w2Total = 0;
            let w3Total = 0;
            let w4Total = 0;

            // Add up the points scored by each of their 6 locked-in teams
            chosenTeams.forEach(team => {
                if (teamScoresMap[team]) {
                    w1Total += teamScoresMap[team].w1;
                    w2Total += teamScoresMap[team].w2;
                    w3Total += teamScoresMap[team].w3;
                    w4Total += teamScoresMap[team].w4;
                }
            });

            const grandTotal = w1Total + w2Total + w3Total + w4Total;

            return {
                entryName: entry.entry_name,
                // ONLY include team picks if entries are locked/closed!
                teams: isLocked ? chosenTeams.join(', ') : '',
                w1: w1Total,
                w2: w2Total,
                w3: w3Total,
                w4: w4Total,
                totalPoints: grandTotal,
                tiebreaker: entry.tiebreaker
            };
        });

        // 4. Sort from highest points to lowest points
        leaderboardData.sort((a, b) => b.totalPoints - a.totalPoints);

        // Return leaderboard along with entriesOpen state
        res.json({ 
            success: true, 
            entriesOpen: settings.challengeEntriesOpen, 
            leaderboard: leaderboardData 
        });

    } catch (error) {
        console.error("Error generating leaderboard:", error);
        res.status(500).json({ success: false, message: "Failed to generate leaderboard." });
    }
});

// Admin API to completely reset the 4-Weeks Challenge tables
app.post('/api/challenge-master-reset', (req, res) => {
    try {
        // Clear all entries
        db.prepare("DELETE FROM challenge_entries").run();
        
        // Reset all team scores back to 0
        db.prepare(`
            UPDATE challenge_scores 
            SET week1_pts = 0, week2_pts = 0, week3_pts = 0, week4_pts = 0
        `).run();
        
        res.json({ success: true, message: "Master reset successful! All entries deleted and scores reset to 0." });
    } catch (error) {
        console.error("Error executing master reset:", error);
        res.status(500).json({ success: false, message: "Failed to perform master reset." });
    }
});

// Manage Entries Page Route
app.get('/admin/manage-4w-entries', (req, res) => {
    res.sendFile(path.join(__dirname, 'four-weeks-manage.html'));
});

// API: Get all challenge entries for management
app.get('/api/challenge-entries', (req, res) => {
    try {
        const entries = db.prepare("SELECT * FROM challenge_entries ORDER BY id DESC").all();
        res.json({ success: true, entries });
    } catch (error) {
        console.error("Error fetching challenge entries:", error);
        res.status(500).json({ success: false, message: "Failed to fetch entries." });
    }
});

// API: Toggle payment status (1 = paid, 0 = unpaid)
app.post('/api/challenge-toggle-paid', (req, res) => {
    try {
        const { id, paid } = req.body;
        db.prepare("UPDATE challenge_entries SET paid = ? WHERE id = ?").run(paid ? 1 : 0, id);
        res.json({ success: true, message: "Payment status updated." });
    } catch (error) {
        console.error("Error updating payment status:", error);
        res.status(500).json({ success: false, message: "Failed to update payment status." });
    }
});

// API: Manually delete an entry
app.delete('/api/challenge-delete-entry/:id', (req, res) => {
    try {
        const { id } = req.params;
        db.prepare("DELETE FROM challenge_entries WHERE id = ?").run(id);
        res.json({ success: true, message: "Entry successfully deleted." });
    } catch (error) {
        console.error("Error deleting entry:", error);
        res.status(500).json({ success: false, message: "Failed to delete entry." });
    }
});

// --------------------
// Start server
// --------------------
regeneratePlayersCSV();
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });