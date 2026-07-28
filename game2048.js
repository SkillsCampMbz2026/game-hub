/* 2048: slide tiles, merge equal pairs, reach 2048. */

(() => {
  const SIZE = 4;
  const KEY = 'g2048';

  const boardEl = document.getElementById('g2048-board');
  const statusEl = document.getElementById('g2048-status');
  const scoreEl = document.getElementById('g2048-score');
  const bestEl = document.getElementById('g2048-best');
  const topEl = document.getElementById('g2048-top');

  let grid = [];
  let tiles = [];
  let score = 0;
  let over = false;
  let reached2048 = false;

  const at = (row, col) => row * SIZE + col;

  function buildBoard() {
    boardEl.textContent = '';
    tiles = [];
    for (let i = 0; i < SIZE * SIZE; i++) {
      const tile = document.createElement('div');
      tile.className = 'g2048-tile';
      tiles.push(tile);
      boardEl.appendChild(tile);
    }
  }

  function topTile() {
    return Math.max(...grid);
  }

  function render(spawned = -1, merged = []) {
    grid.forEach((value, i) => {
      const tile = tiles[i];
      tile.textContent = value ? value : '';
      tile.className = 'g2048-tile';
      if (value) {
        tile.classList.add(`v${value <= 2048 ? value : 'big'}`);
        if (i === spawned) tile.classList.add('spawn');
        if (merged.includes(i)) tile.classList.add('merge');
      }
    });

    scoreEl.textContent = score;
    topEl.textContent = topTile();
    const record = Stats.get(KEY);
    bestEl.textContent = record.bestScore || 0;
  }

  function emptyIndices() {
    return grid.reduce((acc, value, i) => (value ? acc : acc.concat(i)), []);
  }

  function spawn() {
    const open = emptyIndices();
    if (!open.length) return -1;
    const index = open[Math.floor(Math.random() * open.length)];
    grid[index] = Math.random() < 0.9 ? 2 : 4;
    return index;
  }

  /* Collapse one line toward index 0. Returns [values, gained, mergedOffsets]. */
  function collapse(values) {
    const kept = values.filter(Boolean);
    const out = [];
    const mergedOffsets = [];
    let gained = 0;

    for (let i = 0; i < kept.length; i++) {
      if (kept[i] === kept[i + 1]) {
        const value = kept[i] * 2;
        out.push(value);
        mergedOffsets.push(out.length - 1);
        gained += value;
        i += 1;
      } else {
        out.push(kept[i]);
      }
    }
    while (out.length < SIZE) out.push(0);
    return [out, gained, mergedOffsets];
  }

  /* Indices of one line, ordered so index 0 is the side we push toward. */
  function lineIndices(direction, n) {
    const line = [];
    for (let k = 0; k < SIZE; k++) {
      if (direction === 'left') line.push(at(n, k));
      else if (direction === 'right') line.push(at(n, SIZE - 1 - k));
      else if (direction === 'up') line.push(at(k, n));
      else line.push(at(SIZE - 1 - k, n));
    }
    return line;
  }

  function move(direction) {
    if (over) return;

    let changed = false;
    let gainedTotal = 0;
    const mergedCells = [];

    for (let n = 0; n < SIZE; n++) {
      const indices = lineIndices(direction, n);
      const before = indices.map((i) => grid[i]);
      const [after, gained, mergedOffsets] = collapse(before);

      indices.forEach((cellIndex, k) => {
        if (grid[cellIndex] !== after[k]) changed = true;
        grid[cellIndex] = after[k];
      });

      gainedTotal += gained;
      mergedOffsets.forEach((offset) => mergedCells.push(indices[offset]));
    }

    if (!changed) return;

    score += gainedTotal;
    const spawned = spawn();
    render(spawned, mergedCells);

    Stats.recordMax(KEY, 'bestScore', score);
    Stats.recordMax(KEY, 'topTile', topTile());
    updateHUD();

    if (!reached2048 && topTile() >= 2048) {
      reached2048 = true;
      Clock.pause();
      const time = Clock.value();
      if (Stats.recordWin(KEY, time)) HUD.pop(HUD.bestBadge);
      HUD.pop(HUD.winsBadge);
      updateHUD();
      statusEl.textContent = `🎉 You made 2048 in ${formatTime(time)} — keep going!`;
      Clock.resume();
      return;
    }

    if (!canMove()) {
      over = true;
      Clock.pause();
      statusEl.textContent = `No moves left — final score ${score}`;
      boardEl.classList.add('over');
      return;
    }

    statusEl.textContent = gainedTotal > 0 ? `+${gainedTotal}` : 'Keep merging';
  }

  function canMove() {
    if (emptyIndices().length) return true;
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        const value = grid[at(row, col)];
        if (col + 1 < SIZE && grid[at(row, col + 1)] === value) return true;
        if (row + 1 < SIZE && grid[at(row + 1, col)] === value) return true;
      }
    }
    return false;
  }

  function updateHUD() {
    const record = Stats.get(KEY);
    HUD.set({
      leftIcon: '🔢',
      left: record.bestScore || 0,
      leftLabel: 'best score',
      rightIcon: '🧱',
      right: record.topTile || 0,
      rightLabel: 'top tile',
    });
  }

  function startRound() {
    grid = Array(SIZE * SIZE).fill(0);
    score = 0;
    over = false;
    reached2048 = false;
    boardEl.classList.remove('over');

    Clock.attach(null); // 2048 is scored, not timed on screen — the clock only dates a 2048 run
    Clock.reset();
    Clock.resume();

    spawn();
    const second = spawn();
    render(second);
    updateHUD();
    statusEl.textContent = 'Arrow keys, WASD or swipe';
  }

  function startGame() {
    if (!tiles.length) buildBoard();
    Screens.show('g2048-game-screen');
    startRound();
  }

  /* ---------- Wiring ---------- */

  document.getElementById('pick-2048').addEventListener('click', startGame);
  document.getElementById('g2048-restart').addEventListener('click', startRound);

  document.querySelectorAll('#g2048-pad .dpad__btn').forEach((button) => {
    button.addEventListener('click', () => move(button.dataset.dir));
  });

  document.addEventListener('keydown', (event) => {
    if (!Screens.isActive('g2048-game-screen')) return;
    const direction = directionFromKey(event);
    if (!direction) return;
    event.preventDefault();
    move(direction);
  });

  onSwipe(boardEl, move);
})();
