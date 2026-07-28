/* Memory Match: flip cards two at a time and clear every pair. */

(() => {
  const FACES = [
    '🍎', '🍌', '🍇', '🍒', '🍉', '🥝', '🍑', '🍍',
    '🥑', '🌽', '🍄', '🌶️', '🥕', '🍆', '🥦', '🍋',
    '🫐', '🥥', '🍔', '🍕', '🌮', '🍩', '🍿', '🧁',
  ];

  const boardEl = document.getElementById('mem-board');
  const screenEl = document.getElementById('mem-game-screen');
  const statusEl = document.getElementById('mem-status');
  const timerEl = document.getElementById('mem-timer');
  const tagEl = document.getElementById('mem-tag');
  const pairsEl = document.getElementById('mem-pairs');
  const flipsEl = document.getElementById('mem-flips');
  const bestEl = document.getElementById('mem-best');

  let cols = 4;
  let rows = 4;
  let cards = [];       // { value, el, matched }
  let picked = [];      // indices currently face up
  let locked = false;
  let matched = 0;
  let flips = 0;
  let started = false;
  let unflipTimer = null;

  const pairCount = () => (cols * rows) / 2;
  const statsKey = () => `mem-${cols}x${rows}`;

  function shuffled(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function renderStats() {
    pairsEl.textContent = `${matched}/${pairCount()}`;
    flipsEl.textContent = flips;
    const best = Stats.get(statsKey()).best;
    bestEl.textContent = best === null ? '--:--' : formatTime(best);
  }

  function buildBoard() {
    const values = shuffled(FACES.slice(0, pairCount()).flatMap((face) => [face, face]));

    screenEl.style.maxWidth = `min(96vw, ${Math.max(380, cols * 78)}px)`;
    boardEl.style.setProperty('--cols', cols);
    boardEl.style.setProperty('--face', cols > 6 ? '1.5rem' : '2rem');
    boardEl.textContent = '';
    cards = [];

    values.forEach((value, index) => {
      const card = document.createElement('button');
      card.className = 'mem-card';
      card.type = 'button';
      card.setAttribute('aria-label', 'Hidden card');
      card.innerHTML = `
        <span class="mem-card__inner">
          <span class="mem-card__side mem-card__side--back">?</span>
          <span class="mem-card__side mem-card__side--front">${value}</span>
        </span>`;
      card.addEventListener('click', () => flip(index));
      cards.push({ value, el: card, matched: false });
      boardEl.appendChild(card);
    });
  }

  function flip(index) {
    const card = cards[index];
    if (locked || card.matched || picked.includes(index)) return;

    if (!started) {
      started = true;
      Clock.resume();
    }

    card.el.classList.add('flipped');
    card.el.setAttribute('aria-label', card.value);
    picked.push(index);

    if (picked.length < 2) return;

    flips += 1;
    const [a, b] = picked;

    if (cards[a].value === cards[b].value) {
      cards[a].matched = true;
      cards[b].matched = true;
      cards[a].el.classList.add('matched');
      cards[b].el.classList.add('matched');
      picked = [];
      matched += 1;
      renderStats();
      statusEl.textContent = matched === pairCount() ? '' : 'Nice — keep going';
      if (matched === pairCount()) win();
      return;
    }

    locked = true;
    statusEl.textContent = 'Not a pair';
    renderStats();
    unflipTimer = setTimeout(() => {
      picked.forEach((i) => {
        cards[i].el.classList.remove('flipped');
        cards[i].el.setAttribute('aria-label', 'Hidden card');
      });
      picked = [];
      locked = false;
      unflipTimer = null;
      statusEl.textContent = 'Flip two cards';
    }, 750);
  }

  function win() {
    Clock.pause();
    const time = Clock.value();
    locked = true;

    if (Stats.recordWin(statsKey(), time)) {
      Clock.markRecord();
      HUD.pop(HUD.bestBadge);
      statusEl.textContent = `🎉 All pairs in ${formatTime(time)} — new record!`;
    } else {
      statusEl.textContent = `🎉 All pairs in ${formatTime(time)} · ${flips} flips`;
    }

    HUD.pop(HUD.winsBadge);
    HUD.show(statsKey(), `wins · ${cols}×${rows}`);
    renderStats();
  }

  function startRound() {
    clearTimeout(unflipTimer);
    unflipTimer = null;
    picked = [];
    locked = false;
    matched = 0;
    flips = 0;
    started = false;

    Clock.attach(timerEl);
    Clock.reset();
    buildBoard();
    renderStats();
    statusEl.textContent = 'Flip two cards';
  }

  function startGame(c, r) {
    cols = c;
    rows = r;
    tagEl.textContent = `Memory · ${cols}×${rows}`;
    HUD.show(statsKey(), `wins · ${cols}×${rows}`);
    Screens.show('mem-game-screen');
    startRound();
  }

  /* ---------- Wiring ---------- */

  document.getElementById('pick-mem').addEventListener('click', () => Screens.show('mem-mode-screen'));

  document.querySelectorAll('#mem-mode-screen .size-card').forEach((card) => {
    card.addEventListener('click', () => startGame(Number(card.dataset.cols), Number(card.dataset.rows)));
  });

  document.getElementById('mem-restart').addEventListener('click', startRound);

  document.addEventListener('screen-left', () => {
    clearTimeout(unflipTimer);
    unflipTimer = null;
  });
})();
