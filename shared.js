/* Shared plumbing for every game in the hub:
   screen routing, the corner HUD, persisted records, the round clock and input helpers. */

/* ---------- Screens ---------- */

const Screens = {
  current: 'hub-screen',

  show(id) {
    document.querySelectorAll('.screen').forEach((screen) => {
      screen.classList.toggle('screen--active', screen.id === id);
    });
    this.current = id;
    // theme follows the game prefix: hub / ttt / c4 / mem / g2048 / snake / ms
    document.body.className = `theme-${id.split('-')[0]}`;
    window.scrollTo(0, 0);
  },

  isActive(id) {
    return this.current === id;
  },
};

/* ---------- Formatting ---------- */

function formatTime(ms) {
  const total = ms / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = (total % 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${seconds}`;
}

/* ---------- Persisted records ----------
   { [key]: { wins, best, ...custom } } — best is a time in ms. */

const Stats = {
  STORAGE_KEY: 'game-hub-stats',
  data: {},

  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.STORAGE_KEY));
      this.data = saved && typeof saved === 'object' ? saved : {};
    } catch {
      this.data = {};
    }
  },

  save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* storage blocked (private mode / file:// restrictions) — records stay in memory */
    }
  },

  get(key) {
    if (!this.data[key]) this.data[key] = { wins: 0, best: null };
    const entry = this.data[key];
    if (typeof entry.wins !== 'number') entry.wins = 0;
    if (entry.best === undefined) entry.best = null;
    return entry;
  },

  bump(key, field = 'wins') {
    const entry = this.get(key);
    entry[field] = (entry[field] || 0) + 1;
    this.save();
    return entry[field];
  },

  /* Lower is better (times). Returns true on a new record. */
  recordMin(key, field, value) {
    const entry = this.get(key);
    if (entry[field] === null || entry[field] === undefined || value < entry[field]) {
      entry[field] = value;
      this.save();
      return true;
    }
    return false;
  },

  /* Higher is better (scores). Returns true on a new record. */
  recordMax(key, field, value) {
    const entry = this.get(key);
    if (entry[field] === null || entry[field] === undefined || value > entry[field]) {
      entry[field] = value;
      this.save();
      return true;
    }
    return false;
  },

  recordWin(key, ms) {
    this.bump(key, 'wins');
    return this.recordMin(key, 'best', ms);
  },

  totals() {
    const all = Object.values(this.data);
    const times = all.map((entry) => entry.best).filter((value) => typeof value === 'number');
    return {
      wins: all.reduce((sum, entry) => sum + (entry.wins || 0), 0),
      best: times.length ? Math.min(...times) : null,
    };
  },
};

Stats.load();

/* ---------- Corner HUD ---------- */

const HUD = {
  winsBadge: document.getElementById('badge-wins'),
  bestBadge: document.getElementById('badge-best'),
  winsIcon: document.getElementById('hud-wins-icon'),
  winsEl: document.getElementById('hud-wins'),
  winsLabel: document.getElementById('hud-wins-label'),
  bestIcon: document.getElementById('hud-best-icon'),
  bestEl: document.getElementById('hud-best'),
  bestLabel: document.getElementById('hud-best-label'),

  /* Fully custom pair of badges. */
  set({ leftIcon = '🏆', left, leftLabel, rightIcon = '⚡', right, rightLabel }) {
    this.winsIcon.textContent = leftIcon;
    this.winsEl.textContent = left;
    this.winsLabel.textContent = leftLabel;
    this.bestIcon.textContent = rightIcon;
    this.bestEl.textContent = right;
    this.bestLabel.textContent = rightLabel;
  },

  /* Wins + fastest time, the common case. Pass null for all-time totals. */
  show(key, label) {
    const entry = key ? Stats.get(key) : Stats.totals();
    this.set({
      left: entry.wins,
      leftLabel: label || (key ? 'wins' : 'total wins'),
      right: entry.best === null ? '--:--' : formatTime(entry.best),
      rightLabel: 'best',
    });
  },

  pop(badge) {
    badge.classList.remove('pop');
    void badge.offsetWidth; // restart the animation
    badge.classList.add('pop');
  },
};

/* ---------- Round clock ----------
   Counts only the time a human can act on: paused while a computer opponent
   thinks, so an opponent's delay never inflates a record. */

const Clock = {
  el: null,
  elapsed: 0,
  since: null,
  handle: null,

  attach(el) {
    this.el = el;
  },

  value() {
    return this.since === null ? this.elapsed : this.elapsed + (performance.now() - this.since);
  },

  render() {
    if (this.el) this.el.textContent = formatTime(this.value());
  },

  resume() {
    if (this.since !== null) return;
    this.since = performance.now();
    this.handle = setInterval(() => this.render(), 100);
    this.render();
  },

  pause() {
    if (this.since !== null) {
      this.elapsed += performance.now() - this.since;
      this.since = null;
    }
    clearInterval(this.handle);
    this.handle = null;
    this.render();
  },

  reset() {
    this.pause();
    this.elapsed = 0;
    if (this.el) this.el.classList.remove('record');
    this.render();
  },

  markRecord() {
    if (this.el) this.el.classList.add('record');
  },
};

/* ---------- Input helpers ---------- */

/* Calls handler('up' | 'down' | 'left' | 'right') on a flick. */
function onSwipe(element, handler) {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  element.addEventListener('touchstart', (event) => {
    const touch = event.changedTouches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    tracking = true;
  }, { passive: true });

  element.addEventListener('touchmove', (event) => {
    if (tracking) event.preventDefault(); // stop the page scrolling under the board
  }, { passive: false });

  element.addEventListener('touchend', (event) => {
    if (!tracking) return;
    tracking = false;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) handler(dx > 0 ? 'right' : 'left');
    else handler(dy > 0 ? 'down' : 'up');
  });
}

const ARROW_KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
};

/* Physical-key fallback so W/A/S/D still work on AZERTY and other layouts. */
const ARROW_CODES = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
};

/* 'up' | 'down' | 'left' | 'right', or undefined for any other key. */
function directionFromKey(event) {
  return ARROW_KEYS[event.key] || ARROW_CODES[event.code];
}

/* ---------- Generic back buttons ---------- */

document.querySelectorAll('[data-back]').forEach((button) => {
  button.addEventListener('click', () => {
    Clock.pause();
    document.dispatchEvent(new CustomEvent('screen-left'));
    Screens.show(button.dataset.back);
    HUD.show(null);
  });
});
