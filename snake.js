/* Snake: eat apples, grow, avoid the walls and yourself. */

(() => {
  const GRID = 21;
  const POINTS = { 150: 1, 105: 2, 75: 3, 50: 5 };
  const NAMES = { 150: 'Chill', 105: 'Normal', 75: 'Fast', 50: 'Insane' };
  const VECTORS = {
    up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
  };

  const canvas = document.getElementById('snake-canvas');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('snake-status');
  const timerEl = document.getElementById('snake-timer');
  const tagEl = document.getElementById('snake-tag');
  const scoreEl = document.getElementById('snake-score');
  const bestEl = document.getElementById('snake-best');
  const lengthEl = document.getElementById('snake-length');
  const pauseBtn = document.getElementById('snake-pause');

  const cell = canvas.width / GRID;

  let snake = [];
  let direction = { x: 1, y: 0 };
  let queue = [];
  let food = { x: 0, y: 0 };
  let score = 0;
  let speed = 105;
  let loop = null;
  let waiting = true;   // waiting for the first direction press
  let paused = false;
  let dead = false;

  const statsKey = () => `snake-${speed}`;

  /* ---------- Drawing ---------- */

  function roundRect(x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
    ctx.fill();
  }

  function draw() {
    ctx.fillStyle = '#08240f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (let i = 1; i < GRID; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, canvas.height);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(canvas.width, i * cell);
      ctx.stroke();
    }

    // apple
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(food.x * cell + cell / 2, food.y * cell + cell / 2, cell * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#16a34a';
    ctx.fillRect(food.x * cell + cell / 2 - 1, food.y * cell + cell * 0.14, 2, cell * 0.16);

    // snake, tail first so the head sits on top
    snake.forEach((part, index) => {
      const head = index === 0;
      const shade = Math.max(0.35, 1 - index / (snake.length + 6));
      ctx.fillStyle = head ? '#bbf7d0' : `rgba(74, 222, 128, ${shade})`;
      roundRect(part.x * cell + 1, part.y * cell + 1, cell - 2, cell - 2, head ? cell * 0.35 : cell * 0.25);
    });

    // eyes
    const head = snake[0];
    if (head) {
      ctx.fillStyle = '#052e16';
      const cx = head.x * cell + cell / 2;
      const cy = head.y * cell + cell / 2;
      const offset = cell * 0.18;
      const ex = direction.y !== 0 ? offset : direction.x * offset * 0.6;
      const ey = direction.x !== 0 ? offset : direction.y * offset * 0.6;
      ctx.beginPath();
      ctx.arc(cx + (direction.y !== 0 ? -ex : ex), cy + (direction.x !== 0 ? -ey : ey), cell * 0.09, 0, Math.PI * 2);
      ctx.arc(cx + ex, cy + ey, cell * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------- Game ---------- */

  function placeFood() {
    const free = [];
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (!snake.some((part) => part.x === x && part.y === y)) free.push({ x, y });
      }
    }
    food = free[Math.floor(Math.random() * free.length)] || { x: 0, y: 0 };
  }

  function renderStats() {
    scoreEl.textContent = score;
    lengthEl.textContent = snake.length;
    const record = Stats.get(statsKey());
    bestEl.textContent = record.bestScore || 0;
  }

  function updateHUD() {
    const record = Stats.get(statsKey());
    HUD.set({
      leftIcon: '🐍',
      left: record.bestScore || 0,
      leftLabel: `best · ${NAMES[speed].toLowerCase()}`,
      rightIcon: '📏',
      right: record.bestLength || 0,
      rightLabel: 'longest',
    });
  }

  function step() {
    if (queue.length) {
      const next = queue.shift();
      if (next.x !== -direction.x || next.y !== -direction.y) direction = next;
    }

    const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };

    const hitWall = head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID;
    const hitSelf = snake.some((part, i) => i < snake.length - 1 && part.x === head.x && part.y === head.y);
    if (hitWall || hitSelf) return die(hitWall ? 'You hit the wall' : 'You bit your own tail');

    snake.unshift(head);

    if (head.x === food.x && head.y === food.y) {
      score += POINTS[speed];
      placeFood();
      statusEl.textContent = `+${POINTS[speed]}`;
    } else {
      snake.pop();
    }

    renderStats();
    draw();
  }

  function stopLoop() {
    clearInterval(loop);
    loop = null;
  }

  function die(reason) {
    stopLoop();
    Clock.pause();
    dead = true;

    const isScoreRecord = Stats.recordMax(statsKey(), 'bestScore', score);
    const isLengthRecord = Stats.recordMax(statsKey(), 'bestLength', snake.length);
    if (isScoreRecord) HUD.pop(HUD.winsBadge);
    if (isLengthRecord) HUD.pop(HUD.bestBadge);

    updateHUD();
    renderStats();
    statusEl.textContent = isScoreRecord
      ? `💀 ${reason} — new best score: ${score}!`
      : `💀 ${reason} — score ${score}`;
    pauseBtn.disabled = true;
  }

  function setPaused(value) {
    if (dead || waiting) return;
    paused = value;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (paused) {
      stopLoop();
      Clock.pause();
      statusEl.textContent = '⏸ Paused';
    } else {
      loop = setInterval(step, speed);
      Clock.resume();
      statusEl.textContent = 'Go!';
    }
  }

  function turn(name) {
    const vector = VECTORS[name];
    if (!vector || dead) return;

    if (waiting) {
      waiting = false;
      direction = vector;
      Clock.resume();
      loop = setInterval(step, speed);
      statusEl.textContent = 'Go!';
      pauseBtn.disabled = false;
      return;
    }

    if (paused) return;
    if (queue.length < 2) queue.push(vector);
  }

  function startRound() {
    stopLoop();
    const middle = Math.floor(GRID / 2);
    snake = [{ x: middle, y: middle }, { x: middle - 1, y: middle }, { x: middle - 2, y: middle }];
    direction = { x: 1, y: 0 };
    queue = [];
    score = 0;
    waiting = true;
    paused = false;
    dead = false;
    pauseBtn.textContent = 'Pause';
    pauseBtn.disabled = true;

    Clock.attach(timerEl);
    Clock.reset();
    placeFood();
    renderStats();
    updateHUD();
    draw();
    statusEl.textContent = 'Press W · A · S · D (or an arrow key) to start';
  }

  function startGame(chosenSpeed) {
    speed = chosenSpeed;
    tagEl.textContent = `Snake · ${NAMES[speed]}`;
    Screens.show('snake-game-screen');
    startRound();
  }

  /* ---------- Wiring ---------- */

  document.getElementById('pick-snake').addEventListener('click', () => Screens.show('snake-mode-screen'));

  document.querySelectorAll('#snake-mode-screen .size-card').forEach((card) => {
    card.addEventListener('click', () => startGame(Number(card.dataset.speed)));
  });

  document.getElementById('snake-restart').addEventListener('click', startRound);
  pauseBtn.addEventListener('click', () => setPaused(!paused));

  document.querySelectorAll('#snake-pad .dpad__btn').forEach((button) => {
    button.addEventListener('click', () => turn(button.dataset.dir));
  });

  document.addEventListener('keydown', (event) => {
    if (!Screens.isActive('snake-game-screen')) return;
    if (event.key === ' ') {
      event.preventDefault();
      setPaused(!paused);
      return;
    }
    const name = directionFromKey(event);
    if (!name) return;
    event.preventDefault();
    turn(name);
  });

  onSwipe(canvas, turn);

  document.addEventListener('screen-left', () => {
    stopLoop();
    paused = false;
  });
})();
