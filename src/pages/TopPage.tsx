export function TopPage() {
  return (
    <div class="page top-page">
      <header class="site-header">
        <h1 class="logo">DEBUG<span class="accent">—</span>ZERO</h1>
        <p class="tagline">// bring the variable back to ZERO</p>
      </header>

      <main class="top-main">
        <section class="card panel create-panel">
          <h2 class="panel-title">NEW GAME</h2>
          <form id="create-form" class="form" autocomplete="off">
            <label class="field">
              <span class="field-label">// PLAYER_NAME</span>
              <input
                type="text"
                id="create-name"
                class="input"
                placeholder="Enter your name"
                maxlength={20}
                required
              />
            </label>
            <label class="field">
              <span class="field-label">// RULE_SET</span>
              <select id="ruleset" class="input select">
                <option value="basic">basic v1.0</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">// MAX_PLAYERS</span>
              <select id="max-players" class="input select">
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4" selected>4</option>
              </select>
            </label>
            <button type="submit" class="btn btn-primary">CREATE ROOM</button>
            <p id="create-error" class="error-msg hidden"></p>
          </form>
        </section>

        <div class="divider">OR</div>

        <section class="card panel join-panel">
          <h2 class="panel-title">JOIN GAME</h2>
          <form id="join-form" class="form" autocomplete="off">
            <label class="field">
              <span class="field-label">// PLAYER_NAME</span>
              <input
                type="text"
                id="join-name"
                class="input"
                placeholder="Enter your name"
                maxlength={20}
                required
              />
            </label>
            <label class="field">
              <span class="field-label">// ROOM_CODE</span>
              <input
                type="text"
                id="room-code"
                class="input mono"
                placeholder="XXXXXX"
                maxlength={6}
                style="text-transform: uppercase"
                required
              />
            </label>
            <button type="submit" class="btn btn-secondary">JOIN ROOM</button>
            <p id="join-error" class="error-msg hidden"></p>
          </form>
        </section>
      </main>

      <script
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  document.getElementById('create-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var name = document.getElementById('create-name').value.trim();
    var ruleSetId = document.getElementById('ruleset').value;
    var maxPlayers = parseInt(document.getElementById('max-players').value);
    var errEl = document.getElementById('create-error');
    errEl.classList.add('hidden');

    if (!name) return;

    var playerId = uuid();
    try {
      var res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostName: name, ruleSetId: ruleSetId, maxPlayers: maxPlayers, hostId: playerId })
      });
      if (!res.ok) throw new Error(await res.text());
      var data = await res.json();
      sessionStorage.setItem('playerId', data.playerId);
      sessionStorage.setItem('playerName', name);
      window.location.href = '/room/' + data.roomId;
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  document.getElementById('join-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var name = document.getElementById('join-name').value.trim();
    var code = document.getElementById('room-code').value.trim().toUpperCase();
    var errEl = document.getElementById('join-error');
    errEl.classList.add('hidden');

    if (!name || !code) return;

    var playerId = uuid();
    sessionStorage.setItem('playerId', playerId);
    sessionStorage.setItem('playerName', name);
    window.location.href = '/room/' + code;
  });
})();
          `,
        }}
      />
    </div>
  );
}
