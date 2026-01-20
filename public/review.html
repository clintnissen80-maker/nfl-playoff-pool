<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Review Entry</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 10px;
      background: #f5f5f5;
    }
    .container {
      max-width: 520px;
      margin: 0 auto;
      background: #ffffff;
      padding: 15px;
      border-radius: 8px;
    }
    h1 {
      text-align: center;
    }
    h2 {
      margin-top: 25px;
      border-bottom: 1px solid #ddd;
      padding-bottom: 5px;
    }
    .player {
      padding: 8px;
      border-bottom: 1px solid #eee;
    }
    button {
      margin-top: 20px;
      width: 100%;
      padding: 12px;
      font-size: 18px;
      background: #28a745;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
  </style>
</head>
<body>

<div class="container">
  <h1>Review Your Entry</h1>

  <div id="review"></div>

  <button id="submitBtn">Submit Entry</button>
</div>

<script>
  const reviewDiv = document.getElementById('review');
  const data = JSON.parse(sessionStorage.getItem('entryPlayers') || '[]');

  if (!data.length) {
    reviewDiv.innerHTML = '<p>No players selected.</p>';
  } else {
    const grouped = {};
    data.forEach(p => {
      if (!grouped[p.position]) grouped[p.position] = [];
      grouped[p.position].push(p);
    });

    ['QB','RB','WR','TE','K'].forEach(pos => {
      if (!grouped[pos]) return;

      const h = document.createElement('h2');
      h.textContent = pos;
      reviewDiv.appendChild(h);

      grouped[pos].forEach(p => {
        const div = document.createElement('div');
        div.className = 'player';
        div.textContent = `${p.name} (${p.team})`;
        reviewDiv.appendChild(div);
      });
    });
  }

  document.getElementById('submitBtn').addEventListener('click', async () => {
  const players = JSON.parse(sessionStorage.getItem('entryPlayers') || '[]');
  const entryName = sessionStorage.getItem('entryName');
  const email = sessionStorage.getItem('email');

  if (!entryName || !email || players.length !== 14) {
    alert('Entry data missing or invalid.');
    return;
  }

  const payload = {
    entryName,
    email,
    players: players.map(p => ({
      id: `${p.position}_${p.team}_${p.name.replace(/\s+/g, '')}`,
      name: p.name,
      position: p.position,
      team: p.team
    }))
  };

const res = await fetch('/api/entries', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});

const data = await res.json();

if (!res.ok) {
  if (data.error && data.error.includes('Maximum of 4')) {
    alert('You have already submitted 4 entries. Proceeding to payment.');
    window.location.href = 'payment.html';
    return;
  } else {
    alert(data.error || 'Failed to save entry');
    return;
  }
}


  sessionStorage.setItem('lastEntryId', data.entryId);
  window.location.href = 'success.html';
});

</script>

</body>
</html>
