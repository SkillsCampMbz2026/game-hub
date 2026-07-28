/* Connect Four: 7 columns x 6 rows, drop discs, four in a row wins. */

(() => {
  const COLS = 7;
  const ROWS = 6;
  const CONNECT = 4;

  const RED = 1;    // player 1 / you
  const YELLOW = 2; // player 2 / computer

  /* Search depth and how often the computer plays a random legal column. */
  const LEVELS = {
    easy:   { depth: 1, random: 0.6 },
    medium: { depth: 4, random: 0.15 },
    hard:   { depth: 6, random: 0 },
  };

  const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]]; // →, ↑, ↗, ↘

  const boardEl = document.getElementById('c4-board');
  const statusEl = document.getElementById('c4-status');
  const timerEl = document.getElementById('c4-timer');
  const tagEl = document.getElementById('c4-tag');
  const panels = { 1: document.getElementById('c4-panel-1'), 2: document.getElementById('c4-panel-2') };
  const nameEls = { 1: document.getElementById('c4-name-1'), 2: document.getElementById('c4-name-2') };
  const winEls = { 1: document.getElementById('c4-wins-1'), 2: document.getElementById('c4-wins-2') };

  /* grid[col * ROWS + row], row 0 is the bottom of the column. */
  const grid = new Int8Array(COLS * ROWS);
  const heights = new Int8Array(COLS);
  const idx = (col, row) => col * ROWS + row;

  let slots = [];      // slots[col][row] -> element
  let columnEls = [];
  let current = RED;
  let gameOver = false;
  let vsAI = false;
  let difficulty = 'medium';
  let aiTimer = null;
  const wins = { 1: 0, 2: 0 };

  const statsKey = () => `c4-${vsAI ? 'ai' : 'duo'}`;
  const isHumanTurn = () => !vsAI || current === RED;

  /* Every 4-in-a-row window on the board, precomputed once. */
  const WINDOWS = (() => {
    const list = [];
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        for (const [dc, dr] of DIRECTIONS) {
          const endC = col + dc * (CONNECT - 1);
          const endR = row + dr * (CONNECT - 1);
          if (endC < 0 || endC >= COLS || endR < 0 || endR >= ROWS) continue;
          const window = [];
          for (let k = 0; k < CONNECT; k++) window.push(idx(col + dc * k, row + dr * k));
          list.push(window);
        }
      }
    }
    return list;
  })();

  /* Columns nearest the middle first — better alpha-beta pruning. */
  const COLUMN_ORDER = [...Array(COLS).keys()]
    .sort((a, b) => Math.abs(a - (COLS - 1) / 2) - Math.abs(b - (COLS - 1) / 2));

  /* ---------- Rules ---------- */

  /* The run of >=4 through (col,row), or null. */
  function winningRun(col, row) {
    const player = grid[idx(col, row)];
    if (!player) return null;

    for (const [dc, dr] of DIRECTIONS) {
      const run = [[col, row]];
      for (const sign of [1, -1]) {
        let c = col + dc * sign;
        let r = row + dr * sign;
        while (c >= 0 && c < COLS && r >= 0 && r < ROWS && grid[idx(c, r)] === player) {
          run.push([c, r]);
          c += dc * sign;
          r += dr * sign;
        }
      }
      if (run.length >= CONNECT) return run;
    }
    return null;
  }

  function legalColumns() {
    return COLUMN_ORDER.filter((col) => heights[col] < ROWS);
  }

  function drop(col, player) {
    const row = heights[col];
    grid[idx(col, row)] = player;
    heights[col] += 1;
    return row;
  }

  function undrop(col) {
    heights[col] -= 1;
    grid[idx(col, heights[col])] = 0;
  }

  /* ---------- Computer ---------- */

  function evaluate(me, opponent) {
    let score = 0;

    for (const window of WINDOWS) {
      let mine = 0;
      let theirs = 0;
      for (const i of window) {
        const value = grid[i];
        if (value === me) mine += 1;
        else if (value === opponent) theirs += 1;
      }
      if (mine && theirs) continue;              // blocked window, worthless to both
      if (mine === 3) score += 60;
      else if (mine === 2) score += 10;
      else if (mine === 1) score += 1;
      if (theirs === 3) score -= 75;             // slightly defensive
      else if (theirs === 2) score -= 12;
      else if (theirs === 1) score -= 1;
    }

    const middle = (COLS - 1) / 2;
    for (let row = 0; row < ROWS; row++) {
      const value = grid[idx(middle, row)];
      if (value === me) score += 6;
      else if (value === opponent) score -= 6;
    }
    return score;
  }

  function search(depth, alpha, beta, maximizing, me, opponent) {
    const moves = legalColumns();
    if (moves.length === 0) return 0;             // board full
    if (depth === 0) return evaluate(me, opponent);

    let best = maximizing ? -Infinity : Infinity;

    for (const col of moves) {
      const player = maximizing ? me : opponent;
      const row = drop(col, player);
      const won = winningRun(col, row);
      const score = won
        ? (maximizing ? 100000 + depth : -100000 - depth)
        : search(depth - 1, alpha, beta, !maximizing, me, opponent);
      undrop(col);

      if (maximizing) {
        best = Math.max(best, score);
        alpha = Math.max(alpha, score);
      } else {
        best = Math.min(best, score);
        beta = Math.min(beta, score);
      }
      if (alpha >= beta) break;
    }
    return best;
  }

  function chooseColumn() {
    const moves = legalColumns();
    if (moves.length === 0) return null;

    const level = LEVELS[difficulty];
    if (Math.random() < level.random) {
      return moves[Math.floor(Math.random() * moves.length)];
    }

    let best = -Infinity;
    let picks = [];

    for (const col of moves) {
      const row = drop(col, YELLOW);
      const won = winningRun(col, row);
      const score = won
        ? 100000
        : search(level.depth - 1, -Infinity, Infinity, false, YELLOW, RED);
      undrop(col);

      if (score > best) {
        best = score;
        picks = [col];
      } else if (score === best) {
        picks.push(col);
      }
    }

    return picks[Math.floor(Math.random() * picks.length)];
  }

  function scheduleAIMove() {
    Clock.pause();
    boardEl.classList.add('thinking');
    statusEl.textContent = 'Computer is thinking…';
    aiTimer = setTimeout(() => {
      aiTimer = null;
      boardEl.classList.remove('thinking');
      playColumn(chooseColumn());
    }, 400);
  }

  function cancelAIMove() {
    if (aiTimer !== null) {
      clearTimeout(aiTimer);
      aiTimer = null;
    }
    boardEl.classList.remove('thinking');
  }

  /* ---------- Rendering ---------- */

  function buildBoard() {
    boardEl.textContent = '';
    slots = [];
    columnEls = [];

    for (let col = 0; col < COLS; col++) {
      const column = document.createElement('button');
      column.className = 'c4-col';
      column.type = 'button';
      column.setAttribute('aria-label', `Drop in column ${col + 1}`);
      column.addEventListener('click', () => {
        if (!isHumanTurn()) return;
        playColumn(col);
      });

      slots[col] = [];
      for (let row = 0; row < ROWS; row++) {
        const slot = document.createElement('span');
        slot.className = 'c4-slot';
        slots[col][row] = slot;
        column.appendChild(slot); // column-reverse puts row 0 at the bottom
      }

      columnEls.push(column);
      boardEl.appendChild(column);
    }
  }

  function paintTurn() {
    panels[1].classList.toggle('active', !gameOver && current === RED);
    panels[2].classList.toggle('active', !gameOver && current === YELLOW);
    columnEls.forEach((column, col) => {
      column.classList.toggle('c4-col--red', current === RED);
      column.disabled = gameOver || heights[col] >= ROWS;
    });
  }

  function label(player) {
    if (vsAI) return player === RED ? 'You' : 'Computer';
    return player === RED ? 'Red' : 'Yellow';
  }

  /* ---------- Game flow ---------- */

  function endGame(message) {
    gameOver = true;
    Clock.pause();
    statusEl.textContent = message;
    columnEls.forEach((column) => { column.disabled = true; });
    paintTurn();
  }

  function recordWin(winner) {
    wins[winner] += 1;
    winEls[winner].textContent = wins[winner];
    if (vsAI && winner !== RED) return;

    if (Stats.recordWin(statsKey(), Clock.value())) {
      Clock.markRecord();
      HUD.pop(HUD.bestBadge);
    }
    HUD.pop(HUD.winsBadge);
    HUD.show(statsKey(), 'wins · connect 4');
  }

  function announceTurn() {
    if (vsAI && current === YELLOW) {
      scheduleAIMove();
      paintTurn();
      return;
    }
    statusEl.textContent = vsAI ? 'Your turn' : `${label(current)}'s turn`;
    Clock.resume();
    paintTurn();
  }

  function playColumn(col) {
    if (gameOver || col === null || col === undefined || heights[col] >= ROWS) return;

    const row = drop(col, current);
    const slot = slots[col][row];
    slot.classList.add(current === RED ? 'red' : 'yellow', 'drop');
    slot.style.setProperty('--fall', `${(ROWS - row) * 100}%`);

    const run = winningRun(col, row);
    if (run) {
      run.forEach(([c, r]) => slots[c][r].classList.add('win'));
      Clock.pause();
      const time = Clock.value();
      recordWin(current);
      endGame(vsAI
        ? (current === RED ? `You win in ${formatTime(time)}! 🎉` : 'Computer wins!')
        : `${label(current)} wins in ${formatTime(time)}!`);
      return;
    }

    if (heights.every((height) => height >= ROWS)) {
      endGame("Board full — it's a draw!");
      return;
    }

    current = current === RED ? YELLOW : RED;
    announceTurn();
  }

  function startRound() {
    cancelAIMove();
    grid.fill(0);
    heights.fill(0);
    gameOver = false;
    Clock.attach(timerEl);
    Clock.reset();

    slots.flat().forEach((slot) => {
      slot.className = 'c4-slot';
      slot.style.removeProperty('--fall');
    });

    if (vsAI) {
      // Coin flip: 50/50 whether you or the computer opens the round.
      current = Math.random() < 0.5 ? RED : YELLOW;
      if (current === YELLOW) {
        statusEl.textContent = 'Coin flip — computer goes first';
        scheduleAIMove();
        paintTurn();
        return;
      }
      statusEl.textContent = 'Coin flip — you go first';
    } else {
      current = RED;
      statusEl.textContent = "Red's turn";
    }

    Clock.resume();
    paintTurn();
  }

  function startGame(useAI) {
    vsAI = useAI;
    difficulty = document.querySelector('input[name="c4-difficulty"]:checked').value;

    tagEl.textContent = vsAI
      ? `Connect Four · ${difficulty[0].toUpperCase()}${difficulty.slice(1)}`
      : 'Connect Four · 2 Players';
    nameEls[1].textContent = vsAI ? 'You' : 'Player 1';
    nameEls[2].textContent = vsAI ? 'Computer' : 'Player 2';

    wins[1] = 0;
    wins[2] = 0;
    winEls[1].textContent = '0';
    winEls[2].textContent = '0';
    HUD.show(statsKey(), 'wins · connect 4');

    if (!slots.length) buildBoard();
    Screens.show('c4-game-screen');
    startRound();
  }

  /* ---------- Wiring ---------- */

  document.getElementById('pick-c4').addEventListener('click', () => Screens.show('c4-mode-screen'));
  document.getElementById('c4-mode-ai').addEventListener('click', () => startGame(true));
  document.getElementById('c4-mode-duo').addEventListener('click', () => startGame(false));

  document.getElementById('c4-restart').addEventListener('click', startRound);
  document.getElementById('c4-reset').addEventListener('click', () => {
    wins[1] = 0;
    wins[2] = 0;
    winEls[1].textContent = '0';
    winEls[2].textContent = '0';
    startRound();
  });

  document.addEventListener('screen-left', cancelAIMove);

  buildBoard();
})();
