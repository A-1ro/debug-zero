export function RoomPage({ roomId }: { roomId: string }) {
  return (
    <div class="page room-page" id="app" data-room-id={roomId}>
      {/* ── Lobby ──────────────────────────────────────────── */}
      <section id="view-lobby" class="view hidden">
        <div class="room-header">
          <h2 class="room-title">ROOM <span class="accent mono" id="lobby-room-id"></span></h2>
          <p class="room-subtitle">// waiting for debuggers to connect</p>
        </div>

        <div class="lobby-body">
          <div class="card panel player-list-panel">
            <h3 class="panel-title">CONNECTED_ENTITIES</h3>
            <ul id="player-list" class="player-list"></ul>
          </div>

          <div class="card panel lobby-actions">
            <div id="strategy-select-panel" class="hidden">
              <h3 class="panel-title">SELECT_STRATEGY</h3>
              <select id="strategy-select" class="input select"></select>
            </div>

            <div class="lobby-buttons">
              <button id="btn-ready" class="btn btn-secondary">MARK READY</button>
              <button id="btn-start" class="btn btn-primary hidden">BOOT GAME</button>
            </div>
            <p id="lobby-status" class="status-msg"></p>
          </div>
        </div>
      </section>

      {/* ── Game board ────────────────────────────────────── */}
      <section id="view-game" class="view hidden">
        <div class="game-header">
          <div class="set-number-box">
            <span class="set-label">SET_NUMBER</span>
            <span id="set-number" class="set-value">0</span>
          </div>
          <div class="phase-box">
            <span class="phase-label">PHASE</span>
            <span id="phase-name" class="phase-value">NORMAL</span>
          </div>
          <div class="turn-box">
            <span class="turn-label">TURN</span>
            <span id="turn-player" class="turn-value">—</span>
          </div>
        </div>

        <div class="game-body">
          <div class="left-col">
            <div class="card panel field-panel">
              <h3 class="panel-title">FIELD_STACK</h3>
              <div id="field-cards" class="field-cards"></div>
            </div>

            <div class="card panel bugs-panel">
              <h3 class="panel-title">ACTIVE_BUGS</h3>
              <div id="bug-list" class="bug-list"></div>
            </div>
          </div>

          <div class="right-col">
            <div class="card panel hand-panel">
              <h3 class="panel-title">YOUR_HAND</h3>
              <div id="hand-cards" class="hand-cards"></div>
            </div>

            <div class="card panel action-panel" id="action-panel">
              <h3 class="panel-title">EXECUTE_OPERATION</h3>
              <div class="op-row">
                <label class="field">
                  <span class="field-label">// OPERATION</span>
                  <select id="op-select" class="input select">
                    <option value="add">+ ADD</option>
                    <option value="sub">- SUB</option>
                    <option value="mul">× MUL</option>
                    <option value="div">÷ DIV</option>
                  </select>
                </label>
                <label class="field hidden" id="target-field">
                  <span class="field-label">// TARGET</span>
                  <select id="target-select" class="input select"></select>
                </label>
              </div>
              <button id="btn-play" class="btn btn-primary" disabled>PLAY CARD</button>
              <button id="btn-draw" class="btn btn-secondary" style="margin-left:8px">DRAW CARD</button>
            </div>

            <div class="card panel raid-panel hidden" id="raid-panel">
              <h3 class="panel-title">ZERO_CHOICE</h3>
              <p class="raid-desc">A zero card has been played. Choose your action:</p>
              <button id="btn-reset" class="btn btn-secondary">RESET</button>
              <button id="btn-raid" class="btn btn-danger" style="margin-left:8px">RAID BOSS</button>
            </div>
          </div>
        </div>

        <div class="card panel event-log">
          <h3 class="panel-title">EVENT_LOG</h3>
          <ul id="event-list" class="event-list"></ul>
        </div>
      </section>

      {/* ── Result ────────────────────────────────────────── */}
      <section id="view-result" class="view hidden">
        <div class="result-body">
          <h2 class="result-title">SESSION_TERMINATED</h2>
          <p class="result-winner">WINNER: <span id="winner-name" class="accent mono"></span></p>
          <table class="score-table" id="score-table">
            <thead>
              <tr>
                <th>ENTITY</th>
                <th>WINS</th>
                <th>STRATEGY</th>
              </tr>
            </thead>
            <tbody id="score-body"></tbody>
          </table>
          <button id="btn-play-again" class="btn btn-primary" style="margin-top:24px">PLAY AGAIN</button>
        </div>
      </section>

      {/* ── Error overlay ─────────────────────────────────── */}
      <div id="overlay-error" class="overlay hidden">
        <div class="overlay-box">
          <p class="overlay-code">ERROR</p>
          <p id="overlay-msg"></p>
          <button id="overlay-close" class="btn btn-secondary">DISMISS</button>
        </div>
      </div>

      <script
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  var ROOM_ID = document.getElementById('app').dataset.roomId;
  var playerId = sessionStorage.getItem('playerId');
  var playerName = sessionStorage.getItem('playerName');

  if (!playerId || !playerName) {
    window.location.href = '/';
    return;
  }

  // ── State ──────────────────────────────────────────────────
  var state = {
    room: null,
    session: null,
    game: null,
    hand: [],
    readyPlayerIds: [],
    playerStrategies: {},
    selectedCard: null,
    pendingResetOrRaid: false,
    isMyTurn: false,
    phase: 'normal',
  };

  // ── WebSocket ──────────────────────────────────────────────
  var ws;
  var wsUrl = (location.protocol === 'https:' ? 'wss' : 'ws') +
    '://' + location.host + '/ws/' + ROOM_ID +
    '?playerId=' + encodeURIComponent(playerId) +
    '&playerName=' + encodeURIComponent(playerName);

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = function () { console.log('[WS] connected'); };
    ws.onmessage = function (e) {
      try { handleMessage(JSON.parse(e.data)); }
      catch(err) { console.error('[WS] parse error', err); }
    };
    ws.onerror = function (e) { console.error('[WS] error', e); };
    ws.onclose = function () {
      setTimeout(connect, 2000); // auto-reconnect
    };
  }

  function send(type, payload) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({
      id: 'msg-' + Date.now(),
      type: type,
      roomId: ROOM_ID,
      senderId: playerId,
      payload: payload || {}
    }));
  }

  // ── Message handlers ───────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'server:room_updated':
        state.room = msg.payload.room;
        state.readyPlayerIds = msg.payload.readyPlayerIds || [];
        state.playerStrategies = msg.payload.playerStrategies || {};
        renderLobby();
        showView('lobby');
        break;
      case 'server:session_started':
        state.session = msg.payload;
        break;
      case 'server:game_started':
        state.hand = msg.payload.hand;
        state.game = {
          id: msg.payload.gameId,
          gameIndex: msg.payload.gameIndex,
          setNumber: msg.payload.setNumber,
          turnOrder: msg.payload.turnOrder,
          currentTurnIndex: 0,
          deckCount: msg.payload.deckCount,
          residualBugs: msg.payload.residualBugs,
          field: [],
          phase: 'normal',
          handCounts: msg.payload.handCounts,
        };
        state.pendingResetOrRaid = false;
        renderGame();
        showView('game');
        logEvent('Game ' + msg.payload.gameIndex + ' started. SetNumber = ' + msg.payload.setNumber);
        break;
      case 'server:action_result':
        if (msg.payload.events) {
          msg.payload.events.forEach(function(ev) {
            logEvent(formatEvent(ev));
          });
        }
        break;
      case 'server:hand_updated':
        if (msg.payload.hand !== undefined) {
          state.hand = msg.payload.hand;
          renderHand();
        }
        break;
      case 'server:state_sync':
        state.room    = msg.payload.room;
        state.session = msg.payload.session;
        var gv = msg.payload.game;
        state.game = gv;
        state.hand = gv.hand;
        renderGame();
        showView('game');
        break;
      case 'server:game_ended':
        logEvent('// GAME_END — winner: ' + (msg.payload.winResult.winnerId || 'SYSTEM'));
        break;
      case 'server:session_ended':
        renderResult(msg.payload);
        showView('result');
        break;
      case 'server:error':
        showError(msg.payload.code + ': ' + (msg.payload.detail || msg.payload.message));
        break;
    }
  }

  // ── Render lobby ───────────────────────────────────────────
  function renderLobby() {
    if (!state.room) return;
    document.getElementById('lobby-room-id').textContent = state.room.id;

    var list = document.getElementById('player-list');
    list.innerHTML = '';
    state.room.players.forEach(function(p) {
      var li = document.createElement('li');
      li.className = 'player-item';
      var ready = state.readyPlayerIds.includes(p.id);
      var strategy = state.playerStrategies[p.id] || '—';
      var isHost = p.id === state.room.hostPlayerId;
      li.innerHTML =
        '<span class="player-status ' + (ready ? 'ready' : 'waiting') + '">●</span>' +
        '<span class="player-name">' + escHtml(p.name) + (isHost ? ' [HOST]' : '') + '</span>' +
        '<span class="player-strategy mono">' + escHtml(strategy) + '</span>';
      list.appendChild(li);
    });

    // Strategy select (show when room is in strategy-selection)
    var stratPanel = document.getElementById('strategy-select-panel');
    var stratSel = document.getElementById('strategy-select');
    if (state.room.status === 'strategy-selection' && !state.playerStrategies[playerId]) {
      stratPanel.classList.remove('hidden');
      if (stratSel.options.length === 0) {
        // Populate options (hardcoded from basic ruleset for now)
        ['Aggro','Control-Add','Control-Sub','Control-Mul','Control-Div','Hack','TrickStar','Zero'].forEach(function(s) {
          var opt = document.createElement('option');
          opt.value = s; opt.textContent = s;
          stratSel.appendChild(opt);
        });
      }
    } else {
      stratPanel.classList.add('hidden');
    }

    // Start button (host + all have strategies)
    var btnStart = document.getElementById('btn-start');
    var allHaveStrategy = state.room.players.every(function(p) {
      return !!state.playerStrategies[p.id];
    });
    if (state.room.hostPlayerId === playerId && state.room.status === 'strategy-selection' && allHaveStrategy) {
      btnStart.classList.remove('hidden');
    } else {
      btnStart.classList.add('hidden');
    }

    var statusEl = document.getElementById('lobby-status');
    statusEl.textContent = '// status: ' + state.room.status;
  }

  // ── Render game ────────────────────────────────────────────
  function renderGame() {
    if (!state.game) return;

    var g = state.game;
    document.getElementById('set-number').textContent = g.setNumber;
    document.getElementById('phase-name').textContent = (g.phase || 'normal').toUpperCase();

    var turnPid = g.turnOrder ? g.turnOrder[g.currentTurnIndex] : null;
    state.isMyTurn = turnPid === playerId;
    var turnName = turnPid === playerId ? 'YOUR TURN' : (turnPid || '—');
    document.getElementById('turn-player').textContent = turnName;

    renderField(g.field || []);
    renderHand();
    renderBugs(g.residualBugs || []);
    renderActionPanel(g);
  }

  function renderField(field) {
    var el = document.getElementById('field-cards');
    el.innerHTML = '';
    if (!field.length) {
      el.innerHTML = '<span class="empty-hint">// empty</span>';
      return;
    }
    field.forEach(function(fc) {
      var div = document.createElement('div');
      div.className = 'field-card';
      var opSym = { add: '+', sub: '-', mul: '×', div: '÷' }[fc.operation] || '?';
      div.innerHTML = '<span class="op-sym">' + opSym + '</span>' +
        '<span class="card-val">' + fc.effectiveValue + '</span>';
      el.appendChild(div);
    });
  }

  function renderHand() {
    var el = document.getElementById('hand-cards');
    el.innerHTML = '';
    state.hand.forEach(function(cardId) {
      var val = cardId.split('-')[0];
      var btn = document.createElement('button');
      btn.className = 'hand-card' + (state.selectedCard === cardId ? ' selected' : '');
      btn.textContent = val;
      btn.dataset.cardId = cardId;
      btn.addEventListener('click', function() {
        state.selectedCard = state.selectedCard === cardId ? null : cardId;
        renderHand();
        document.getElementById('btn-play').disabled = !state.selectedCard || !state.isMyTurn;
      });
      el.appendChild(btn);
    });
    document.getElementById('btn-play').disabled = !state.selectedCard || !state.isMyTurn;
  }

  function renderBugs(bugs) {
    var el = document.getElementById('bug-list');
    el.innerHTML = '';
    if (!bugs.length) {
      el.innerHTML = '<span class="empty-hint">// none</span>';
      return;
    }
    bugs.forEach(function(bugId) {
      var span = document.createElement('span');
      span.className = 'bug-tag';
      span.textContent = bugId;
      el.appendChild(span);
    });
  }

  function renderActionPanel(g) {
    var actionPanel = document.getElementById('action-panel');
    var raidPanel   = document.getElementById('raid-panel');

    // Show raid-or-reset panel when pending
    if (state.pendingResetOrRaid) {
      actionPanel.classList.add('hidden');
      raidPanel.classList.remove('hidden');
    } else {
      raidPanel.classList.add('hidden');
      actionPanel.classList.remove('hidden');
    }

    // Show target select only in raid phase (non-boss)
    var targetField = document.getElementById('target-field');
    if (g.phase === 'raid' && g.raidState) {
      targetField.classList.remove('hidden');
      var targetSel = document.getElementById('target-select');
      targetSel.innerHTML = '';
      // Boss attacks players, players attack boss
      var isBoss = g.raidState.bossPlayerId === playerId;
      if (isBoss) {
        g.raidState.turnOrder.forEach(function(pid) {
          var opt = document.createElement('option');
          opt.value = pid;
          opt.textContent = pid + ' (HP: ' + (g.raidState.playerHPs[pid] || 0) + ')';
          targetSel.appendChild(opt);
        });
      } else {
        var opt = document.createElement('option');
        opt.value = 'boss';
        opt.textContent = 'BOSS (HP: ' + g.raidState.bossHP + ')';
        targetSel.appendChild(opt);
      }
    } else {
      targetField.classList.add('hidden');
    }
  }

  function renderResult(payload) {
    var winnerId = payload.winnerId;
    var players  = payload.players || [];
    var winnerPlayer = players.find(function(p) { return p.playerId === winnerId; });
    document.getElementById('winner-name').textContent = winnerPlayer ? winnerPlayer.playerId : winnerId;
    var tbody = document.getElementById('score-body');
    tbody.innerHTML = '';
    players.forEach(function(sp) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="mono">' + escHtml(sp.playerId) + '</td>' +
        '<td>' + sp.wins + '</td>' +
        '<td class="mono">' + escHtml(sp.strategyId) + '</td>';
      tbody.appendChild(tr);
    });
  }

  function logEvent(text) {
    var ul = document.getElementById('event-list');
    var li = document.createElement('li');
    li.className = 'event-item';
    li.textContent = '> ' + text;
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 20) ul.removeChild(ul.lastChild);
  }

  function formatEvent(ev) {
    switch (ev.type) {
      case 'card_played': return ev.actorId + ' played ' + ev.payload.cardId + ' [' + ev.payload.operation + '] → setNumber: ' + ev.payload.setNumberAfter;
      case 'card_drawn': return ev.actorId + ' drew a card';
      case 'game_reset': return 'RESET — new setNumber: ' + ev.payload.newSetNumber;
      case 'raid_started': return 'RAID STARTED — bossHP: ' + ev.payload.bossHP;
      case 'game_ended': return 'GAME ENDED — ' + ev.payload.reason;
      default: return ev.type;
    }
  }

  // ── UI helpers ─────────────────────────────────────────────
  function showView(name) {
    ['lobby', 'game', 'result'].forEach(function(v) {
      document.getElementById('view-' + v).classList.toggle('hidden', v !== name);
    });
  }

  function showError(msg) {
    document.getElementById('overlay-msg').textContent = msg;
    document.getElementById('overlay-error').classList.remove('hidden');
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Event listeners ────────────────────────────────────────
  document.getElementById('btn-ready').addEventListener('click', function() {
    send('client:ready', {});
  });

  document.getElementById('strategy-select').addEventListener('change', function(e) {
    send('client:select_strategy', { strategyId: e.target.value });
  });

  document.getElementById('btn-start').addEventListener('click', function() {
    send('client:start_game', {});
  });

  document.getElementById('btn-play').addEventListener('click', function() {
    if (!state.selectedCard) return;
    var op = document.getElementById('op-select').value;
    var targetSel = document.getElementById('target-select');
    var targetId = targetSel.value || undefined;
    var action = { type: 'play_card', cardId: state.selectedCard, operation: op };
    if (targetId) action.targetId = targetId;

    // Check if played a 0-card in normal phase
    var cardVal = state.selectedCard.split('-')[0];
    if (cardVal === '0' && (!state.game || state.game.phase === 'normal')) {
      state.pendingResetOrRaid = true;
      send('client:action', { action: action });
      state.selectedCard = null;
      renderActionPanel(state.game || {});
    } else {
      send('client:action', { action: action });
      state.selectedCard = null;
    }
  });

  document.getElementById('btn-draw').addEventListener('click', function() {
    if (!state.isMyTurn) return;
    send('client:action', { action: { type: 'draw_card' } });
  });

  document.getElementById('btn-reset').addEventListener('click', function() {
    state.pendingResetOrRaid = false;
    send('client:reset_or_raid', { choice: 'reset' });
    if (state.game) renderActionPanel(state.game);
  });

  document.getElementById('btn-raid').addEventListener('click', function() {
    state.pendingResetOrRaid = false;
    send('client:reset_or_raid', { choice: 'raid' });
    if (state.game) renderActionPanel(state.game);
  });

  document.getElementById('btn-play-again').addEventListener('click', function() {
    window.location.href = '/';
  });

  document.getElementById('overlay-close').addEventListener('click', function() {
    document.getElementById('overlay-error').classList.add('hidden');
  });

  // ── Boot ───────────────────────────────────────────────────
  connect();
  showView('lobby');
})();
          `,
        }}
      />
    </div>
  );
}
