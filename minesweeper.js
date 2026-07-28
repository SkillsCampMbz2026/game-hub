/* Minesweeper: clear every safe cell without detonating a mine. */

(() => {
  const boardEl = document.getElementById('ms-board');
  const screenEl = document.getElementById('ms-game-screen');
  const statusEl = document.getElementById('ms-status');
  const timerEl = document.getElementById('ms-timer');
  const tagEl = document.getElementById('ms-tag');
  const minesEl = document.getElementById('ms-mines');
  const bestEl = document.getElementById('ms-best');
  const flagToggle = document.getElementById('ms-flag-toggle');

  let cols = 9;
  let rows = 9;
  let mineCount = 10;

  let cells = [];       // button elements
  let isMine = [];
  let counts = [];
  let revealed = [];
  let flagged = [];
  let started = false;
  let over = false;
  let revealedCount = 0;
  let flagMode = false;

  const at = (row, col) => row * cols + col;
  const statsKey = () => `ms-${cols}x${rows}`;

  function neighbours(index) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const list = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const r = row + dr;
        const c = col + dc;
        if (r >= 0 && r < rows && c >= 0 && c < cols) list.push(at(r, c));
      }
    }
    return list;
  }

  /* Mines are laid after the first click so it is always safe. */
  function layMines(safeIndex) {
    const forbidden = new Set([safeIndex, ...neighbours(safeIndex)]);
    const pool = [];
    for (let i = 0; i < cols * rows; i++) if (!forbidden.has(i)) pool.push(i);

    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    pool.slice(0, mineCount).forEach((index) => { isMine[index] = true; });
    counts = isMine.map((mine, index) =>
      mine ? -1 : neighbours(index).filter((n) => isMine[n]).length);
  }

  function paint(index) {
    const cell = cells[index];
    cell.className = 'ms-cell';

    if (flagged[index] && !revealed[index]) {
      cell.classList.add('flag');
      cell.textContent = '🚩';
      return;
    }

    if (!revealed[index]) {
      cell.textContent = '';
      return;
    }

    cell.classList.add('open');
    if (isMine[index]) {
      cell.classList.add('mine');
      cell.textContent = '💣';
    } else if (counts[index] > 0) {
      cell.classList.add(`n${counts[index]}`);
      cell.textContent = counts[index];
    } else {
      cell.textContent = '';
    }
  }

  function updateCounter() {
    minesEl.textContent = mineCount - flagged.filter(Boolean).length;
    const best = Stats.get(statsKey()).best;
    bestEl.textContent = best === null ? '--:--' : formatTime(best);
  }

  function revealFrom(index) {
    const stack = [index];
    while (stack.length) {
      const current = stack.pop();
      if (revealed[current] || flagged[current]) continue;
      revealed[current] = true;
      revealedCount += 1;
      paint(current);
      if (counts[current] === 0) neighbours(current).forEach((n) => stack.push(n));
    }
  }

  function lose(index) {
    over = true;
    Clock.pause();
    isMine.forEach((mine, i) => {
      if (mine && !flagged[i]) { revealed[i] = true; paint(i); }
      if (!mine && flagged[i]) { cells[i].classList.add('wrong'); cells[i].textContent = '❌'; }
    });
    cells[index].classList.add('boom');
    statusEl.textContent = '💥 Boom — you hit a mine';
  }

  function win() {
    over = true;
    Clock.pause();
    const time = Clock.value();

    isMine.forEach((mine, i) => {
      if (mine && !flagged[i]) { flagged[i] = true; paint(i); }
    });
    updateCounter();

    if (Stats.recordWin(statsKey(), time)) {
      Clock.markRecord();
      HUD.pop(HUD.bestBadge);
      statusEl.textContent = `🎉 Field cleared in ${formatTime(time)} — new record!`;
    } else {
      statusEl.textContent = `🎉 Field cleared in ${formatTime(time)}`;
    }
    HUD.pop(HUD.winsBadge);
    HUD.show(statsKey(), `wins · ${cols}×${rows}`);
    updateCounter();
  }

  function dig(index) {
    if (over || revealed[index] || flagged[index]) return;

    if (!started) {
      started = true;
      layMines(index);
      Clock.resume();
      statusEl.textContent = 'Good luck';
    }

    if (isMine[index]) {
      revealed[index] = true;
      paint(index);
      lose(index);
      return;
    }

    revealFrom(index);
    if (revealedCount === cols * rows - mineCount) win();
  }

  function toggleFlag(index) {
    if (over || revealed[index]) return;
    flagged[index] = !flagged[index];
    paint(index);
    updateCounter();
  }

  function buildBoard() {
    const wide = Math.max(cols * 34 + 40, 320);
    screenEl.style.maxWidth = `min(96vw, ${wide}px)`;
    boardEl.style.setProperty('--cols', cols);
    boardEl.style.setProperty('--font', cols > 14 ? '0.72rem' : '0.95rem');
    boardEl.textContent = '';
    cells = [];

    for (let i = 0; i < cols * rows; i++) {
      const cell = document.createElement('button');
      cell.className = 'ms-cell';
      cell.type = 'button';
      cell.setAttribute('aria-label', `Cell ${i + 1}`);
      cell.addEventListener('click', () => (flagMode ? toggleFlag(i) : dig(i)));
      cell.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        toggleFlag(i);
      });
      cells.push(cell);
      boardEl.appendChild(cell);
    }
  }

  function startRound() {
    const total = cols * rows;
    isMine = Array(total).fill(false);
    counts = Array(total).fill(0);
    revealed = Array(total).fill(false);
    flagged = Array(total).fill(false);
    revealedCount = 0;
    started = false;
    over = false;

    Clock.attach(timerEl);
    Clock.reset();
    buildBoard();
    updateCounter();
    statusEl.textContent = 'Click any cell to start — first click is always safe';
  }

  function setFlagMode(value) {
    flagMode = value;
    flagToggle.textContent = flagMode ? '🚩 Flag' : '⛏️ Dig';
    flagToggle.classList.toggle('on', flagMode);
  }

  function startGame(c, r, mines) {
    cols = c;
    rows = r;
    mineCount = mines;
    tagEl.textContent = `Minesweeper · ${cols}×${rows} · ${mines} mines`;
    setFlagMode(false);
    HUD.show(statsKey(), `wins · ${cols}×${rows}`);
    Screens.show('ms-game-screen');
    startRound();
  }

  /* ---------- Wiring ---------- */

  document.getElementById('pick-ms').addEventListener('click', () => Screens.show('ms-mode-screen'));

  document.querySelectorAll('#ms-mode-screen .size-card').forEach((card) => {
    card.addEventListener('click', () => startGame(
      Number(card.dataset.cols), Number(card.dataset.rows), Number(card.dataset.mines)));
  });

  document.getElementById('ms-restart').addEventListener('click', startRound);
  flagToggle.addEventListener('click', () => setFlagMode(!flagMode));
})();
