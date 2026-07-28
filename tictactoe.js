/* Tic-Tac-Toe: 3x3 up to 10x10, vs AI or two players. */

(() => {
  const HUMAN = 'X';
  const AI = 'O';

  /* Chance the AI plays a random move instead of the best one. */
  const MISTAKE_RATE = { easy: 0.75, medium: 0.3, hard: 0 };

  /* Per-board-size presentation: page width, grid gap, corner radius, mark size. */
  const LAYOUT = {
    3:  { width: 380, gap: 10, radius: 12, font: '3rem' },
    4:  { width: 420, gap: 8,  radius: 10, font: '2.2rem' },
    5:  { width: 470, gap: 7,  radius: 9,  font: '1.8rem' },
    10: { width: 640, gap: 4,  radius: 6,  font: '1.05rem' },
  };

  /* The four line directions to scan: →, ↓, ↘, ↙ */
  const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  const gameScreen = document.getElementById('ttt-game-screen');
  const boardEl = document.getElementById('ttt-board');
  const statusEl = document.getElementById('ttt-status');
  const timerEl = document.getElementById('ttt-timer');
  const tagEl = document.getElementById('ttt-tag');
  const sizeTagEl = document.getElementById('ttt-size-tag');
  const labelEls = { X: document.getElementById('ttt-label-x'), O: document.getElementById('ttt-label-o') };
  const scoreEls = {
    X: document.getElementById('ttt-score-x'),
    O: document.getElementById('ttt-score-o'),
    draw: document.getElementById('ttt-score-draw'),
  };

  let cells = [];
  let board = [];
  let size = 3;
  let winLength = 3;
  let currentPlayer = HUMAN;
  let gameOver = false;
  let vsAI = false;
  let difficulty = 'medium';
  let aiTimer = null;
  let lastMove = null;
  const scores = { X: 0, O: 0, draw: 0 };

  /* ---------- Grid helpers ---------- */

  const rowOf = (index) => Math.floor(index / size);
  const colOf = (index) => index % size;
  const at = (row, col) => row * size + col;
  const inBounds = (row, col) => row >= 0 && row < size && col >= 0 && col < size;
  const statsKey = () => `ttt-${vsAI ? 'ai' : 'duo'}-${size}`;

  function emptyCells(state) {
    return state.reduce((acc, value, i) => (value ? acc : acc.concat(i)), []);
  }

  /* The full run through `index` if it reaches winLength, otherwise null. */
  function winningLineAt(state, index) {
    const mark = state[index];
    if (!mark) return null;

    const row = rowOf(index);
    const col = colOf(index);

    for (const [dr, dc] of DIRECTIONS) {
      const line = [index];
      for (const sign of [1, -1]) {
        let r = row + dr * sign;
        let c = col + dc * sign;
        while (inBounds(r, c) && state[at(r, c)] === mark) {
          line.push(at(r, c));
          r += dr * sign;
          c += dc * sign;
        }
      }
      if (line.length >= winLength) return line;
    }
    return null;
  }

  /* Every winLength-long window that passes through `index`. */
  function windowsThrough(index) {
    const row = rowOf(index);
    const col = colOf(index);
    const windows = [];

    for (const [dr, dc] of DIRECTIONS) {
      for (let offset = 0; offset < winLength; offset++) {
        const startR = row - dr * offset;
        const startC = col - dc * offset;
        const endR = startR + dr * (winLength - 1);
        const endC = startC + dc * (winLength - 1);
        if (!inBounds(startR, startC) || !inBounds(endR, endC)) continue;

        const window = [];
        for (let k = 0; k < winLength; k++) window.push(at(startR + dr * k, startC + dc * k));
        windows.push(window);
      }
    }
    return windows;
  }

  /* ---------- AI ---------- */

  /* Exact solver, only affordable on 3x3. */
  function minimax(state, player, depth) {
    const open = emptyCells(state);
    if (open.length === 0) return 0;

    const values = open.map((index) => {
      state[index] = player;
      const won = winningLineAt(state, index);
      const value = won
        ? (player === AI ? 10 - depth : depth - 10)
        : minimax(state, player === AI ? HUMAN : AI, depth + 1);
      state[index] = '';
      return value;
    });

    return player === AI ? Math.max(...values) : Math.min(...values);
  }

  function solve3x3() {
    const state = board.slice();
    let best = -Infinity;
    let move = null;

    emptyCells(state).forEach((index) => {
      state[index] = AI;
      const won = winningLineAt(state, index);
      const value = won ? 10 : minimax(state, HUMAN, 1);
      state[index] = '';
      if (value > best) {
        best = value;
        move = index;
      }
    });

    return move;
  }

  /* On big boards, only consider cells near existing marks. */
  function candidateMoves() {
    const open = emptyCells(board);
    if (size <= 5) return open;
    if (board.every((value) => !value)) return [at(Math.floor(size / 2), Math.floor(size / 2))];

    const near = open.filter((index) => {
      const row = rowOf(index);
      const col = colOf(index);
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (inBounds(row + dr, col + dc) && board[at(row + dr, col + dc)]) return true;
        }
      }
      return false;
    });

    return near.length ? near : open;
  }

  /* A move that completes a line for `mark`, or null. */
  function winningMoveFor(mark, moves) {
    for (const index of moves) {
      board[index] = mark;
      const won = winningLineAt(board, index);
      board[index] = '';
      if (won) return index;
    }
    return null;
  }

  /* Heuristic: value each window this move touches, for offence and for denial. */
  function scoreMove(index, me, opponent) {
    let score = 0;

    for (const window of windowsThrough(index)) {
      let mine = 0;
      let theirs = 0;
      for (const i of window) {
        if (board[i] === me) mine += 1;
        else if (board[i] === opponent) theirs += 1;
      }
      if (theirs === 0) score += Math.pow(8, mine + 1);      // my line grows
      if (mine === 0) score += Math.pow(8, theirs) * 0.85;   // their line gets blocked
    }

    // nudge toward the middle so early moves aren't stuck on an edge
    const centre = (size - 1) / 2;
    const distance = Math.max(Math.abs(rowOf(index) - centre), Math.abs(colOf(index) - centre));
    return score + (size - distance) * 0.5;
  }

  function chooseAIMove() {
    const moves = candidateMoves();
    if (moves.length === 0) return null;

    if (Math.random() < MISTAKE_RATE[difficulty]) {
      return moves[Math.floor(Math.random() * moves.length)];
    }

    // Always take a win, and always deny one.
    const win = winningMoveFor(AI, moves);
    if (win !== null) return win;
    const block = winningMoveFor(HUMAN, moves);
    if (block !== null) return block;

    if (size === 3) return solve3x3();

    let best = -Infinity;
    let choice = moves[0];
    for (const index of moves) {
      const value = scoreMove(index, AI, HUMAN);
      if (value > best) {
        best = value;
        choice = index;
      }
    }
    return choice;
  }

  function scheduleAIMove() {
    Clock.pause();
    boardEl.classList.add('thinking');
    statusEl.textContent = 'Computer is thinking…';
    aiTimer = setTimeout(() => {
      aiTimer = null;
      boardEl.classList.remove('thinking');
      playMove(chooseAIMove());
    }, 350);
  }

  function cancelAIMove() {
    if (aiTimer !== null) {
      clearTimeout(aiTimer);
      aiTimer = null;
    }
    boardEl.classList.remove('thinking');
  }

  /* ---------- Board rendering ---------- */

  function buildBoard() {
    const layout = LAYOUT[size];
    gameScreen.style.maxWidth = `min(94vw, ${layout.width}px)`;
    boardEl.style.setProperty('--cols', size);
    boardEl.style.setProperty('--gap', `${layout.gap}px`);
    boardEl.style.setProperty('--radius', `${layout.radius}px`);
    boardEl.style.setProperty('--font', layout.font);

    boardEl.textContent = '';
    cells = [];

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < size * size; i++) {
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.type = 'button';
      cell.setAttribute('aria-label', `Row ${rowOf(i) + 1}, column ${colOf(i) + 1}`);
      cell.addEventListener('click', () => {
        if (vsAI && currentPlayer !== HUMAN) return;
        playMove(i);
      });
      cells.push(cell);
      fragment.appendChild(cell);
    }
    boardEl.appendChild(fragment);
  }

  /* ---------- Game flow ---------- */

  function updateScores() {
    scoreEls.X.textContent = scores.X;
    scoreEls.O.textContent = scores.O;
    scoreEls.draw.textContent = scores.draw;
  }

  function endGame(message) {
    gameOver = true;
    Clock.pause();
    statusEl.textContent = message;
    cells.forEach((cell) => { cell.disabled = true; });
  }

  /* A win counts toward the HUD when you beat the AI, or on any win in 2-player. */
  function recordWin(winner) {
    if (vsAI && winner !== HUMAN) return;
    if (Stats.recordWin(statsKey(), Clock.value())) {
      Clock.markRecord();
      HUD.pop(HUD.bestBadge);
    }
    HUD.pop(HUD.winsBadge);
    HUD.show(statsKey(), `wins · ${size}×${size}`);
  }

  function announceTurn() {
    if (vsAI && currentPlayer === AI) {
      scheduleAIMove();
      return;
    }
    statusEl.textContent = vsAI ? 'Your turn' : `${currentPlayer}'s turn`;
    Clock.resume();
  }

  function playMove(index) {
    if (gameOver || index === null || index === undefined || board[index]) return;

    board[index] = currentPlayer;
    if (lastMove !== null) cells[lastMove].classList.remove('last');
    lastMove = index;

    const cell = cells[index];
    cell.textContent = currentPlayer;
    cell.classList.add(currentPlayer.toLowerCase(), 'last');
    cell.disabled = true;

    const winningLine = winningLineAt(board, index);
    if (winningLine) {
      winningLine.forEach((i) => cells[i].classList.add('win'));
      scores[currentPlayer] += 1;
      updateScores();
      Clock.pause();
      const time = Clock.value();
      recordWin(currentPlayer);
      endGame(vsAI
        ? (currentPlayer === HUMAN ? `You win in ${formatTime(time)}! 🎉` : 'Computer wins!')
        : `${currentPlayer} wins in ${formatTime(time)}!`);
      return;
    }

    if (board.every(Boolean)) {
      scores.draw += 1;
      updateScores();
      endGame("It's a draw!");
      return;
    }

    currentPlayer = currentPlayer === 'X' ? 'O' : 'X';
    announceTurn();
  }

  function startRound() {
    cancelAIMove();
    board = Array(size * size).fill('');
    lastMove = null;
    gameOver = false;
    Clock.attach(timerEl);
    Clock.reset();

    cells.forEach((cell) => {
      cell.textContent = '';
      cell.disabled = false;
      cell.classList.remove('x', 'o', 'win', 'last');
    });

    if (vsAI) {
      // Coin flip: 50/50 whether you or the computer opens the round.
      currentPlayer = Math.random() < 0.5 ? HUMAN : AI;
      if (currentPlayer === AI) {
        statusEl.textContent = 'Coin flip — computer goes first';
        scheduleAIMove();
      } else {
        statusEl.textContent = 'Coin flip — you go first';
        Clock.resume();
      }
    } else {
      currentPlayer = 'X';
      statusEl.textContent = "X's turn";
      Clock.resume();
    }
  }

  function chooseMode(useAI) {
    vsAI = useAI;
    difficulty = document.querySelector('input[name="ttt-difficulty"]:checked').value;
    sizeTagEl.textContent = vsAI
      ? `vs AI · ${difficulty[0].toUpperCase()}${difficulty.slice(1)}`
      : '2 Players';
    Screens.show('ttt-size-screen');
  }

  function startGame(boardSize) {
    size = boardSize;
    winLength = Math.min(size, 5);

    tagEl.textContent = `${vsAI ? `AI · ${difficulty}` : '2 Players'} · ${size}×${size} · ${winLength} in a row`;
    labelEls.X.textContent = vsAI ? 'You' : 'X';
    labelEls.O.textContent = vsAI ? 'Computer' : 'O';

    scores.X = 0;
    scores.O = 0;
    scores.draw = 0;
    updateScores();
    HUD.show(statsKey(), `wins · ${size}×${size}`);

    buildBoard();
    Screens.show('ttt-game-screen');
    startRound();
  }

  /* ---------- Wiring ---------- */

  document.getElementById('pick-ttt').addEventListener('click', () => Screens.show('ttt-mode-screen'));
  document.getElementById('ttt-mode-ai').addEventListener('click', () => chooseMode(true));
  document.getElementById('ttt-mode-duo').addEventListener('click', () => chooseMode(false));

  document.querySelectorAll('#ttt-size-screen .size-card').forEach((card) => {
    card.addEventListener('click', () => startGame(Number(card.dataset.size)));
  });

  document.getElementById('ttt-restart').addEventListener('click', startRound);
  document.getElementById('ttt-reset').addEventListener('click', () => {
    scores.X = 0;
    scores.O = 0;
    scores.draw = 0;
    updateScores();
    startRound();
  });

  document.addEventListener('screen-left', cancelAIMove);
})();
