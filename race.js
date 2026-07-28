/* Speed Rush — a 3D arcade racer.

   The world is drawn with a perspective road renderer: the track is a list of
   short segments with a curve and a height, each projected into screen space
   from the camera. Drawing is batched into three passes per view (project →
   grass spans → road polys) so a full view costs a few hundred draw calls
   instead of a few thousand, which keeps the frame rate at display refresh. */

(() => {
  const canvas = document.getElementById('race-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  let W = canvas.width;   // 960 windowed, raised in fullscreen
  let H = canvas.height;  // 600

  /* ---------- Camera / engine ---------- */
  const SEG_LENGTH = 200;
  const RUMBLE_LENGTH = 3;
  const ROAD_WIDTH = 2000;
  const LANES = 3;
  const CAMERA_HEIGHT = 1250;
  const FOV = 108;
  const CAMERA_DEPTH = 1 / Math.tan((FOV / 2) * Math.PI / 180);

  /* How far behind the car the camera sits. Higher = more zoomed out. */
  const ZOOMS = [
    { factor: 1.3, name: 'Close' },
    { factor: 1.9, name: 'Normal' },
    { factor: 2.6, name: 'Far' },
    { factor: 3.4, name: 'Very far' },
  ];
  let zoomIndex = 2;
  const playerZ = () => CAMERA_HEIGHT * CAMERA_DEPTH * ZOOMS[zoomIndex].factor;

  const MAX_SPEED = SEG_LENGTH * 60;
  const ACCEL = MAX_SPEED / 4.5;
  const BRAKING = -MAX_SPEED / 1.4;
  const DECEL = -MAX_SPEED / 6;
  const OFF_ROAD_DECEL = -MAX_SPEED / 1.8;
  const OFF_ROAD_LIMIT = MAX_SPEED / 3.2;
  const CENTRIFUGAL = 0.32;
  const CAR_WIDTH = 720;
  /* Rivals are drawn a touch smaller: your own car is sized at the camera's
     focal distance but sits at the very bottom of the view, which makes an
     equally-sized rival read as larger than it should. */
  const RIVAL_SCALE = 0.82;
  const OWN_SCALE = 1.12;
  const PROP_BASE = 900;

  const TURBO_MULT = 1.55;
  const TURBO_DRAIN = 34;
  const TURBO_REFILL = 11;

  const LAPS = 3;
  const RACERS = 5;
  const AI_SKILL = { easy: 0.80, normal: 0.89, hard: 0.97 };

  /* ---------- Drivetrain ----------
     Six gears. Each covers a band of the car's speed range and pulls with a
     different mechanical advantage, so acceleration tapers as you go up the
     box instead of being linear all the way to the limiter. */
  const GEAR_TOP = [0.20, 0.35, 0.51, 0.68, 0.85, 1.0];
  const GEAR_PULL = [1.60, 1.30, 1.08, 0.92, 0.78, 0.66];
  const SHIFT_TIME = 0.13;

  /* Torque curve: weak off idle, peak at ~72% of the rev range, tails off. */
  const torqueAt = (rpm) => 0.62 + 0.72 * Math.exp(-Math.pow((rpm - 0.72) / 0.42, 2));

  const DRAFT_RANGE = SEG_LENGTH * 9;
  const DRAFT_SPEED = 0.09;   // extra top speed in a tow
  const DRAFT_PULL = 0.3;     // extra acceleration in a tow

  /* Adaptive quality: draw distance moves to hold a smooth frame rate. */
  const QUALITY = { min: 120, max: 340 };
  let drawDistance = 280;

  /* ---------- Track shapes ---------- */
  const LENGTH = { none: 0, short: 15, medium: 30, long: 60 };
  const CURVE = { none: 0, easy: 2, medium: 4, hard: 6 };
  const HILL = { none: 0, low: 20, medium: 40, high: 60 };

  /* Deterministic noise so backdrops are stable frame to frame. */
  function makeRng(seed) {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  const TRACKS = {
    sunset: {
      name: 'Sunset Sprint',
      sky: ['#f97316', '#fbbf24', '#fde9c8'],
      sun: { x: 0.68, y: 0.34, color: '#fff7dc', glow: 'rgba(255, 214, 130, 0.75)' },
      colors: {
        light: { road: '#6f6f6f', grass: '#d9a066', rumble: '#f8f8f8', lane: '#ffffff' },
        dark:  { road: '#666666', grass: '#cd8f55', rumble: '#c92a2a', lane: null },
        start: { road: '#f8f8f8', grass: '#d9a066', rumble: '#f8f8f8', lane: null },
        finish:{ road: '#1c1c1c', grass: '#d9a066', rumble: '#1c1c1c', lane: null },
        fog: '#f6c98a',
      },
      props: ['cactus', 'rock', 'barrel', 'palm', 'tyres', 'cactus', 'rock'],
      landmark: 'billboard',
      weather: 'dust',
      backdrop(g, w, h, layer) {
        const rng = makeRng(layer === 0 ? 7 : 21);
        if (layer === 0) {
          for (let c = 0; c < 9; c++) {
            const cx = rng() * w;
            const cy = rng() * h * 0.4;
            g.fillStyle = `rgba(255, 236, 210, ${0.18 + rng() * 0.22})`;
            for (let puff = 0; puff < 5; puff++) {
              g.beginPath();
              g.ellipse(cx + puff * 14 - 28, cy + (rng() - 0.5) * 8, 22 + rng() * 16, 7 + rng() * 5, 0, 0, Math.PI * 2);
              g.fill();
            }
          }
        }
        g.fillStyle = layer === 0 ? '#c2703a' : '#964f26';
        g.beginPath();
        g.moveTo(0, h);
        let y = h * (layer === 0 ? 0.55 : 0.4);
        for (let x = 0; x <= w; x += 32) {
          y += (rng() - 0.5) * h * 0.14;
          y = Math.max(h * 0.18, Math.min(h * 0.8, y));
          g.lineTo(x, y);
        }
        g.lineTo(w, h);
        g.closePath();
        g.fill();
      },
      build(road) {
        road.straight(LENGTH.long);
        road.curve(LENGTH.long, CURVE.easy, HILL.low);
        road.straight(LENGTH.medium);
        road.curve(LENGTH.long, -CURVE.medium, HILL.none);
        road.hill(LENGTH.long, HILL.medium);
        road.curve(LENGTH.medium, CURVE.medium, -HILL.low);
        road.straight(LENGTH.long);
        road.sCurves();
        road.curve(LENGTH.long, -CURVE.easy, HILL.low);
        road.straight(LENGTH.medium);
        road.curve(LENGTH.medium, CURVE.hard, HILL.none);
        road.hill(LENGTH.medium, -HILL.medium);
        road.straight(LENGTH.long);
      },
    },

    neon: {
      name: 'Neon City',
      sky: ['#090922', '#1e1b4b', '#4c1d95'],
      sun: { x: 0.24, y: 0.26, color: '#e9d5ff', glow: 'rgba(168, 85, 247, 0.55)' },
      colors: {
        light: { road: '#30303f', grass: '#141430', rumble: '#22d3ee', lane: '#f0abfc' },
        dark:  { road: '#282836', grass: '#101026', rumble: '#a855f7', lane: null },
        start: { road: '#ede9fe', grass: '#141430', rumble: '#ede9fe', lane: null },
        finish:{ road: '#0b0b14', grass: '#141430', rumble: '#0b0b14', lane: null },
        fog: '#1b1240',
      },
      props: ['pylon', 'lamp', 'tyres', 'barrel', 'pylon', 'lamp'],
      landmark: 'billboard',
      night: true,
      backdrop(g, w, h, layer) {
        const rng = makeRng(layer === 0 ? 11 : 33);
        if (layer === 0) {
          for (let star = 0; star < 90; star++) {
            g.fillStyle = `rgba(226, 232, 255, ${0.25 + rng() * 0.6})`;
            const size = rng() > 0.9 ? 2 : 1;
            g.fillRect(rng() * w, rng() * h * 0.55, size, size);
          }
        }
        const base = layer === 0 ? '#241f52' : '#151233';
        let x = 0;
        while (x < w) {
          const bw = 26 + rng() * 54;
          const bh = h * (0.28 + rng() * (layer === 0 ? 0.42 : 0.62));
          g.fillStyle = base;
          g.fillRect(x, h - bh, bw, bh);
          if (layer === 1) {
            g.fillStyle = 'rgba(250, 204, 21, 0.55)';
            for (let wy = h - bh + 8; wy < h - 8; wy += 12) {
              for (let wx = x + 5; wx < x + bw - 6; wx += 11) {
                if (rng() > 0.55) g.fillRect(wx, wy, 4, 6);
              }
            }
          }
          x += bw + 5 + rng() * 12;
        }
      },
      build(road) {
        road.straight(LENGTH.short);
        road.sCurves();
        road.curve(LENGTH.medium, CURVE.hard, HILL.none);
        road.straight(LENGTH.short);
        road.curve(LENGTH.medium, -CURVE.hard, HILL.low);
        road.sCurves();
        road.straight(LENGTH.medium);
        road.curve(LENGTH.long, CURVE.medium, -HILL.low);
        road.sCurves();
        road.curve(LENGTH.medium, -CURVE.medium, HILL.medium);
        road.straight(LENGTH.short);
        road.curve(LENGTH.long, CURVE.easy, -HILL.medium);
        road.sCurves();
        road.straight(LENGTH.medium);
      },
    },

    alpine: {
      name: 'Alpine Pass',
      sky: ['#38bdf8', '#a5e4fd', '#f0f9ff'],
      sun: { x: 0.5, y: 0.2, color: '#ffffff', glow: 'rgba(255, 255, 255, 0.6)' },
      colors: {
        light: { road: '#646b78', grass: '#f2f7fb', rumble: '#dc2626', lane: '#ffffff' },
        dark:  { road: '#5c626e', grass: '#e2ecf4', rumble: '#f8fafc', lane: null },
        start: { road: '#ffffff', grass: '#f2f7fb', rumble: '#ffffff', lane: null },
        finish:{ road: '#1f2937', grass: '#f2f7fb', rumble: '#1f2937', lane: null },
        fog: '#e8f3fb',
      },
      props: ['pine', 'rock', 'snowman', 'pine', 'hut', 'pine', 'tyres'],
      landmark: 'sign',
      weather: 'snow',
      backdrop(g, w, h, layer) {
        const rng = makeRng(layer === 0 ? 5 : 17);
        if (layer === 0) {
          for (let c = 0; c < 7; c++) {
            const cx = rng() * w;
            const cy = rng() * h * 0.35;
            g.fillStyle = `rgba(255, 255, 255, ${0.3 + rng() * 0.3})`;
            for (let puff = 0; puff < 4; puff++) {
              g.beginPath();
              g.ellipse(cx + puff * 16 - 24, cy + (rng() - 0.5) * 6, 20 + rng() * 14, 6 + rng() * 4, 0, 0, Math.PI * 2);
              g.fill();
            }
          }
        }
        const peak = layer === 0 ? '#8fa8bd' : '#5b7286';
        let x = -40;
        while (x < w + 40) {
          const pw = 90 + rng() * 130;
          const ph = h * (layer === 0 ? 0.5 + rng() * 0.3 : 0.7 + rng() * 0.3);
          g.fillStyle = peak;
          g.beginPath();
          g.moveTo(x, h);
          g.lineTo(x + pw / 2, h - ph);
          g.lineTo(x + pw, h);
          g.closePath();
          g.fill();
          g.fillStyle = '#ffffff';
          g.beginPath();
          g.moveTo(x + pw / 2, h - ph);
          g.lineTo(x + pw / 2 + pw * 0.17, h - ph * 0.72);
          g.lineTo(x + pw / 2 - pw * 0.17, h - ph * 0.72);
          g.closePath();
          g.fill();
          x += pw * 0.62;
        }
      },
      build(road) {
        road.straight(LENGTH.medium);
        road.hill(LENGTH.long, HILL.high);
        road.curve(LENGTH.medium, -CURVE.hard, HILL.medium);
        road.curve(LENGTH.medium, CURVE.hard, -HILL.low);
        road.straight(LENGTH.short);
        road.hill(LENGTH.long, -HILL.high);
        road.sCurves();
        road.curve(LENGTH.long, CURVE.medium, HILL.high);
        road.straight(LENGTH.medium);
        road.curve(LENGTH.medium, -CURVE.hard, -HILL.medium);
        road.hill(LENGTH.medium, HILL.medium);
        road.sCurves();
        road.curve(LENGTH.long, CURVE.easy, -HILL.low);
        road.straight(LENGTH.medium);
      },
    },
  };

  /* ---------- Audio ----------
     Fully synthesised: a two-oscillator engine note driven by revs, filtered
     noise for tyre scrub and turbo, and short bursts for impacts and lights.
     Nothing is loaded; the context is created on the first race (a click has
     already happened by then, so autoplay policy is satisfied). */

  const Sound = {
    ctx: null,
    on: true,
    ready: false,

    init() {
      if (this.ctx || !window.AudioContext) return;
      this.ctx = new AudioContext();
      const master = this.ctx.createGain();
      master.gain.value = 0.5;
      master.connect(this.ctx.destination);
      this.master = master;

      // engine: two detuned saws through a low-pass that opens with throttle
      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineFilter = this.ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.value = 700;
      this.engineGain.connect(this.engineFilter);
      this.engineFilter.connect(master);

      // three voices: fundamental plus two harmonics, mixed per car
      this.voices = [0, 1, 2].map((i) => {
        const osc = this.ctx.createOscillator();
        osc.type = i === 1 ? 'square' : 'sawtooth';
        osc.frequency.value = 60;
        osc.detune.value = [-6, 9, 4][i];
        const gain = this.ctx.createGain();
        gain.gain.value = i === 0 ? 1 : 0;
        osc.connect(gain);
        gain.connect(this.engineGain);
        osc.start();
        return { osc, gain };
      });

      // shared noise source for scrub and turbo
      const seconds = 2;
      const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buffer;

      this.scrubGain = this.ctx.createGain();
      this.scrubGain.gain.value = 0;
      const scrubFilter = this.ctx.createBiquadFilter();
      scrubFilter.type = 'bandpass';
      scrubFilter.frequency.value = 1900;
      scrubFilter.Q.value = 1.4;
      const scrub = this.ctx.createBufferSource();
      scrub.buffer = buffer;
      scrub.loop = true;
      scrub.connect(scrubFilter);
      scrubFilter.connect(this.scrubGain);
      this.scrubGain.connect(master);
      scrub.start();

      this.turboGain = this.ctx.createGain();
      this.turboGain.gain.value = 0;
      const turboFilter = this.ctx.createBiquadFilter();
      turboFilter.type = 'highpass';
      turboFilter.frequency.value = 2600;
      const turbo = this.ctx.createBufferSource();
      turbo.buffer = buffer;
      turbo.loop = true;
      turbo.connect(turboFilter);
      turboFilter.connect(this.turboGain);
      this.turboGain.connect(master);
      turbo.start();

      this.ready = true;
    },

    resume() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    /* Called every frame with the car the camera is following. */
    drive(car, throttle, racing) {
      if (!this.ready) return;
      const level = this.on && racing ? 1 : 0;
      const revs = clamp(car.rpm, 0.12, 1.1);
      const voicing = (car.car && car.car.audio) || DEFAULT_AUDIO;
      const now = this.ctx.currentTime;
      const hz = voicing.base + revs * voicing.span;

      // engine character only changes when the car does
      if (this.voicedFor !== voicing) {
        this.voicedFor = voicing;
        this.voices[0].osc.type = voicing.tone;
        this.voices[1].gain.gain.setTargetAtTime(voicing.g2, now, 0.05);
        this.voices[2].gain.gain.setTargetAtTime(voicing.g3, now, 0.05);
        this.engineFilter.Q.setTargetAtTime(voicing.q, now, 0.05);
      }

      this.voices[0].osc.frequency.setTargetAtTime(hz, now, 0.03);
      this.voices[1].osc.frequency.setTargetAtTime(hz * voicing.h2, now, 0.03);
      if (voicing.h3) this.voices[2].osc.frequency.setTargetAtTime(hz * voicing.h3, now, 0.03);
      this.engineFilter.frequency.setTargetAtTime(
        voicing.cutoff * (0.25 + revs * 0.85) + (throttle ? 700 : 0), now, 0.05);
      // the limiter chops the fuel, so the note stutters instead of climbing
      const limiter = car.overRev && Math.sin(this.ctx.currentTime * 95) < 0 ? 0.35 : 1;
      this.engineGain.gain.setTargetAtTime(level * limiter * (0.05 + revs * 0.1), this.ctx.currentTime, car.overRev ? 0.008 : 0.05);
      this.scrubGain.gain.setTargetAtTime(level * car.slip * 0.22, this.ctx.currentTime, 0.04);
      this.turboGain.gain.setTargetAtTime(level * (car.boosting ? 0.07 : 0), this.ctx.currentTime, 0.08);
    },

    /* One-shot: type is 'shift' | 'impact' | 'beep' | 'go'. */
    blip(type) {
      if (!this.ready || !this.on) return;
      const now = this.ctx.currentTime;
      const gain = this.ctx.createGain();
      gain.connect(this.master);

      if (type === 'impact') {
        const source = this.ctx.createBufferSource();
        source.buffer = this.noiseBuffer;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 420;
        source.connect(filter);
        filter.connect(gain);
        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        source.start(now);
        source.stop(now + 0.3);
        return;
      }

      const osc = this.ctx.createOscillator();
      osc.type = type === 'shift' ? 'square' : 'sine';
      const pitch = type === 'go' ? 880 : type === 'beep' ? 440 : 180;
      osc.frequency.setValueAtTime(pitch, now);
      if (type === 'shift') osc.frequency.exponentialRampToValueAtTime(90, now + 0.09);
      osc.connect(gain);
      gain.gain.setValueAtTime(type === 'shift' ? 0.12 : 0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + (type === 'go' ? 0.45 : 0.18));
      osc.start(now);
      osc.stop(now + 0.5);
    },

    silence() {
      if (!this.ready) return;
      this.engineGain.gain.value = 0;
      this.scrubGain.gain.value = 0;
      this.turboGain.gain.value = 0;
    },
  };

  /* ---------- Textures ----------
     Everything is generated at load time into small offscreen tiles and used
     as repeating canvas patterns; nothing is loaded from disk or the network.
     Patterns are cached per target context so the garage previews work too. */

  const patternCache = new WeakMap();

  function getPattern(g, name, size, paint) {
    let store = patternCache.get(g);
    if (!store) { store = {}; patternCache.set(g, store); }
    if (!store[name]) {
      const tile = document.createElement('canvas');
      tile.width = size;
      tile.height = size;
      paint(tile.getContext('2d'), size);
      store[name] = g.createPattern(tile, 'repeat');
    }
    return store[name];
  }

  /* Coarse chippings over fine grit — reads as asphalt at speed. */
  function paintAsphalt(g, size) {
    const rng = makeRng(4211);
    g.clearRect(0, 0, size, size);
    for (let i = 0; i < 240; i++) {
      const r = 0.8 + rng() * 2.2;
      g.fillStyle = rng() > 0.55 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.13)';
      g.beginPath();
      g.arc(rng() * size, rng() * size, r, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 900; i++) {
      g.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.06)';
      g.fillRect(rng() * size, rng() * size, 1, 1);
    }
  }

  /* Clumpy blotches for the verge — neutral, so it tints any terrain colour. */
  function paintTerrain(g, size) {
    const rng = makeRng(9137);
    g.clearRect(0, 0, size, size);
    for (let i = 0; i < 130; i++) {
      g.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.1)';
      g.beginPath();
      g.ellipse(rng() * size, rng() * size, 2 + rng() * 6, 1 + rng() * 3, rng() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  }

  /* 2x2 twill weave for spoilers and diffusers. */
  function paintCarbon(g, size) {
    g.fillStyle = '#161b26';
    g.fillRect(0, 0, size, size);
    const cell = size / 4;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const up = (row + col) % 2 === 0;
        const grd = g.createLinearGradient(col * cell, row * cell, (col + 1) * cell, (row + 1) * cell);
        grd.addColorStop(0, up ? '#2b3444' : '#0f141d');
        grd.addColorStop(1, up ? '#0f141d' : '#2b3444');
        g.fillStyle = grd;
        g.fillRect(col * cell, row * cell, cell, cell);
      }
    }
  }

  /* Metallic flake for car paint. */
  function paintFlake(g, size) {
    const rng = makeRng(551);
    g.clearRect(0, 0, size, size);
    for (let i = 0; i < 420; i++) {
      g.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)';
      g.fillRect(rng() * size, rng() * size, 1, 1);
    }
  }

  /* Scroll a pattern so the grain travels toward the camera. */
  function scrollPattern(target, offset) {
    if (!target || typeof target.setTransform !== 'function' || typeof DOMMatrix === 'undefined') return;
    target.setTransform(new DOMMatrix().translateSelf(0, offset));
  }

  /* ---------- Maths ---------- */
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, percent) => a + (b - a) * percent;
  const easeIn = (a, b, percent) => a + (b - a) * Math.pow(percent, 2);
  const easeInOut = (a, b, percent) => a + (b - a) * (-Math.cos(percent * Math.PI) / 2 + 0.5);
  const rumbleWidth = (projectedWidth) => projectedWidth / Math.max(6, 2 * LANES);
  const laneWidth = (projectedWidth) => projectedWidth / Math.max(32, 8 * LANES);

  /* ---------- State ---------- */
  let track = null;
  let trackId = 'sunset';
  let segments = [];
  let trackLength = 0;
  let minimap = [];
  let backdrop = [];
  let racers = [];
  let players = [];
  let splitScreen = false;
  let online = false;
  let netRole = null;      // 'host' | 'guest'
  let netAlive = false;
  let sendTimer = 0;
  const SEND_RATE = 1 / 20; // 20 state updates a second
  let difficulty = 'normal';
  let raceState = 'countdown';
  let countdown = 3.999;
  let raceTime = 0;
  let clockNow = 0;
  let rafId = null;
  let lastFrame = 0;
  let frameId = 0;
  let fps = 60;
  const seededSegments = [];
  const visible = [];    // segments whose road surface gets painted
  const projected = [];  // every segment projected this frame (sprites use this)
  const keys = Object.create(null);
  const cache = {};

  /* ---------- Track building ---------- */

  function buildTrack(definition) {
    segments = [];
    const colors = definition.colors;
    const lastY = () => (segments.length === 0 ? 0 : segments[segments.length - 1].p2.world.y);

    function addSegment(curve, y) {
      const n = segments.length;
      segments.push({
        index: n,
        p1: { world: { y: lastY(), z: n * SEG_LENGTH }, camera: {}, screen: {} },
        p2: { world: { y, z: (n + 1) * SEG_LENGTH }, camera: {}, screen: {} },
        curve,
        color: Math.floor(n / RUMBLE_LENGTH) % 2 ? colors.dark : colors.light,
        // rubber laid down on the inside line of a corner
        skid: Math.abs(curve) > 1.6 ? clamp(-curve * 0.11, -0.62, 0.62) : 0,
        props: [],
        cars: [],
        frame: -1,
        clip: 0,
        fog: 1,
      });
    }

    function addRoad(enter, hold, leave, curve, height) {
      const startY = lastY();
      const endY = startY + height * SEG_LENGTH;
      const total = enter + hold + leave;
      for (let n = 0; n < enter; n++) addSegment(easeIn(0, curve, n / enter), easeInOut(startY, endY, n / total));
      for (let n = 0; n < hold; n++) addSegment(curve, easeInOut(startY, endY, (enter + n) / total));
      for (let n = 0; n < leave; n++) addSegment(easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n) / total));
    }

    const road = {
      straight: (n) => addRoad(n, n, n, 0, 0),
      curve: (n, curve, height) => addRoad(n, n, n, curve, height),
      hill: (n, height) => addRoad(n, n, n, 0, height),
      sCurves: () => {
        addRoad(LENGTH.medium, LENGTH.medium, LENGTH.medium, -CURVE.easy, HILL.none);
        addRoad(LENGTH.medium, LENGTH.medium, LENGTH.medium, CURVE.medium, HILL.medium);
        addRoad(LENGTH.medium, LENGTH.medium, LENGTH.medium, CURVE.easy, -HILL.low);
        addRoad(LENGTH.medium, LENGTH.medium, LENGTH.medium, -CURVE.easy, HILL.medium);
        addRoad(LENGTH.medium, LENGTH.medium, LENGTH.medium, -CURVE.medium, -HILL.medium);
      },
    };

    definition.build(road);

    for (let n = 0; n < RUMBLE_LENGTH * 2; n++) {
      segments[n].color = colors.start;
      segments[n].checker = true;
    }
    for (let n = 1; n <= RUMBLE_LENGTH * 3; n++) {
      const segment = segments[segments.length - n];
      segment.color = colors.finish;
      segment.checker = true;
    }

    trackLength = segments.length * SEG_LENGTH;

    /* Scenery is picked deterministically from the track's set so it never
       changes between frames or between the two split-screen views. */
    const kinds = definition.props;
    segments.forEach((segment, index) => {
      if (index % 8 === 0) {
        segment.props.push({
          side: -1,
          offset: 1.32 + (index % 5) * 0.26,
          kind: kinds[(index * 7) % kinds.length],
          scale: 0.8 + ((index * 13) % 7) * 0.09,
        });
        segment.props.push({
          side: 1,
          offset: 1.32 + (index % 7) * 0.23,
          kind: kinds[(index * 11 + 3) % kinds.length],
          scale: 0.8 + ((index * 17) % 7) * 0.09,
        });
      } else if (index % 37 === 0) {
        segment.props.push({
          side: index % 74 === 0 ? -1 : 1,
          offset: 1.18,
          kind: definition.landmark,
          scale: 1.15,
        });
      }
    });

    buildMinimap();
    buildBackdrop(definition);
  }

  function buildBackdrop(definition) {
    backdrop = [0, 1].map((layer) => {
      const surface = document.createElement('canvas');
      surface.width = 1024;
      surface.height = layer === 0 ? 170 : 230;
      definition.backdrop(surface.getContext('2d'), surface.width, surface.height, layer);
      return { canvas: surface, factor: layer === 0 ? 0.35 : 0.62 };
    });
  }

  /* Schematic overhead path, with the closing error spread around the loop. */
  function buildMinimap() {
    const points = [];
    let heading = 0;
    let x = 0;
    let y = 0;

    segments.forEach((segment, index) => {
      heading += segment.curve * 0.0125;
      x += Math.sin(heading);
      y += Math.cos(heading);
      if (index % 4 === 0) points.push({ x, y });
    });

    const errX = points[points.length - 1].x - points[0].x;
    const errY = points[points.length - 1].y - points[0].y;
    points.forEach((point, i) => {
      const share = i / (points.length - 1);
      point.x -= errX * share;
      point.y -= errY * share;
    });

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
    minimap = points.map((point) => ({ x: (point.x - minX) / span, y: (point.y - minY) / span }));
  }

  const findSegment = (z) => segments[Math.floor(z / SEG_LENGTH) % segments.length];

  /* ---------- Racers ---------- */

  /* Each car trades top speed, acceleration, grip and turbo tank against the
     others, and has its own silhouette (width, roofline, spoiler, wheels). */
  const CARS = [
    {
      id: 'blaze', name: 'Blaze GT', blurb: 'Balanced all-rounder',
      body: '#ef4444', trim: '#7f1d1d', accentColor: '#fca5a5',
      speed: 1.00, accel: 1.00, grip: 1.00, tank: 1.00,
      shape: { width: 1.00, roof: 0.46, spoiler: 0.9, wheel: 1.0 },
    },
    {
      id: 'vortex', name: 'Vortex R', blurb: 'Huge top end, lazy off the line',
      body: '#3b82f6', trim: '#1e3a8a', accentColor: '#bfdbfe',
      speed: 1.13, accel: 0.86, grip: 0.94, tank: 1.05,
      shape: { width: 0.95, roof: 0.38, spoiler: 1.25, wheel: 0.94 },
    },
    {
      id: 'piston', name: 'Piston X', blurb: 'Rockets out of corners',
      body: '#22c55e', trim: '#14532d', accentColor: '#bbf7d0',
      speed: 0.93, accel: 1.20, grip: 1.06, tank: 0.95,
      shape: { width: 1.02, roof: 0.50, spoiler: 0.65, wheel: 1.06 },
    },
    {
      id: 'drift', name: 'Drift King', blurb: 'Glued to the road',
      body: '#a855f7', trim: '#581c87', accentColor: '#e9d5ff',
      speed: 0.98, accel: 1.02, grip: 1.28, tank: 1.00,
      shape: { width: 1.05, roof: 0.44, spoiler: 1.4, wheel: 1.1 },
    },
    {
      id: 'thunder', name: 'Thunder V8', blurb: 'Muscle — a handful in corners',
      body: '#facc15', trim: '#713f12', accentColor: '#fef08a',
      speed: 1.08, accel: 1.12, grip: 0.80, tank: 0.90,
      shape: { width: 1.09, roof: 0.53, spoiler: 1.0, wheel: 1.14 },
    },
    {
      id: 'nitro', name: 'Nitro Bee', blurb: 'Turbo tank for days',
      body: '#f97316', trim: '#7c2d12', accentColor: '#fed7aa',
      speed: 0.96, accel: 1.02, grip: 1.02, tank: 1.5,
      shape: { width: 0.98, roof: 0.46, spoiler: 1.1, wheel: 1.0 },
    },
    {
      id: 'boxer9', name: 'Boxer 9', blurb: 'Rear-engined flat-six · surgical grip',
      body: '#cf1020', trim: '#5c0a12', accentColor: '#ff6b6b',
      speed: 1.10, accel: 1.14, grip: 1.24, tank: 0.85,
      shape: { width: 1.06, roof: 0.42, spoiler: 0.55, wheel: 1.12 },
      profile: 'sport',
      // flat-six: higher pitched, rich in harmonics, metallic rasp under load
      audio: { base: 54, span: 300, cutoff: 3400, q: 5.5, tone: 'sawtooth', h2: 1.5, g2: 0.5, h3: 3.02, g3: 0.3 },
    },
  ];

  /* Default engine voicing for everything else. */
  const DEFAULT_AUDIO = { base: 42, span: 240, cutoff: 2200, q: 1, tone: 'sawtooth', h2: 2.01, g2: 0.35, h3: 0, g3: 0 };

  const RIVAL_NAMES = ['Vega', 'Kuro', 'Nova', 'Rook', 'Ash'];
  let chosenCar = 0;

  function applyCar(racer, definition) {
    racer.car = definition;
    racer.body = definition.body;
    racer.trim = definition.trim;
    racer.accent = definition.accentColor;
    racer.shape = definition.shape;
    racer.profile = definition.profile || 'gt';
    racer.maxSpeed = MAX_SPEED * definition.speed;
    racer.accelRate = ACCEL * definition.accel;
    racer.grip = definition.grip;
    racer.turboMax = 100 * definition.tank;
    racer.turbo = racer.turboMax;
  }

  function createRacers() {
    racers = [];
    const humans = splitScreen || online ? 2 : 1;
    let rivalName = 0;

    for (let i = 0; i < RACERS; i++) {
      const isHuman = i < humans;
      // P1 drives the chosen car; P2 and the rivals take the ones after it.
      const definition = CARS[(chosenCar + i) % CARS.length];
      // Staggered grid just past the line so lap 1 is a full lap.
      // Humans take the back slots, so there is something to overtake.
      const slot = RACERS - 1 - i;

      const racer = {
        id: i,
        name: isHuman ? (splitScreen ? `Player ${i + 1}` : 'You') : RIVAL_NAMES[rivalName++],
        human: isHuman,
        z: 400 + slot * 300,
        x: slot % 2 === 0 ? -0.45 : 0.45,
        speed: 0,
        lap: 1,
        lapStart: 0,
        bestLap: null,
        finished: false,
        finishTime: 0,
        place: slot + 1,
        boosting: false,
        braking: false,
        steer: 0,
        lane: slot % 2 === 0 ? -0.45 : 0.45,
        laneTimer: 0,
        wobble: Math.random() * Math.PI * 2,
        bg: 0,
        gear: 0,
        rpm: 0.15,
        shiftTimer: 0,
        manual: false,
        overRev: false,
        bogging: false,
        slip: 0,
        draft: 0,
        pitch: 0,
        roll: 0,
        shake: 0,
        prevSpeed: 0,
        camX: slot % 2 === 0 ? -0.45 : 0.45,
        smoke: [],
      };

      applyCar(racer, definition);
      racers.push(racer);
    }

    if (online) {
      // index 0 is the host's car, index 1 the guest's; each side drives its own
      // and receives the other's position over the wire
      const mine = netRole === 'host' ? 0 : 1;
      racers.forEach((racer, i) => {
        racer.local = i === mine;
        racer.remote = !racer.local && (i < 2 || netRole === 'guest');
        racer.name = i === mine ? 'You' : (i < 2 ? 'Rival' : racer.name);
      });
      players = [racers[mine]];
    } else {
      racers.forEach((racer) => { racer.local = racer.human; racer.remote = false; });
      players = racers.filter((racer) => racer.human);
    }
  }

  /* ---------- Networked cars ----------
     Remote cars keep moving on their last known speed between updates and are
     eased toward each new position, so a dropped packet is invisible. */

  function applyNetCar(car, state) {
    car.netZ = state[1];
    car.netX = state[2];
    car.speed = state[3];
    car.lap = state[4];
    car.boosting = Boolean(state[5] & 1);
    car.braking = Boolean(state[5] & 2);
    car.gear = state[6];
    car.rpm = state[7];
    car.hasNet = true;
  }

  function updateRemote(car, dt) {
    car.z += car.speed * dt;
    if (car.hasNet) {
      let drift = car.netZ - car.z;
      if (drift > trackLength / 2) drift -= trackLength;
      if (drift < -trackLength / 2) drift += trackLength;
      car.z += drift * Math.min(1, dt * 6);
      car.netZ += car.speed * dt;
      car.x += (car.netX - car.x) * Math.min(1, dt * 8);
    }
    while (car.z >= trackLength) car.z -= trackLength;
    while (car.z < 0) car.z += trackLength;
  }

  function packCar(car) {
    return [
      car.id,
      Math.round(car.z),
      Math.round(car.x * 1000) / 1000,
      Math.round(car.speed),
      car.lap,
      (car.boosting ? 1 : 0) | (car.braking ? 2 : 0),
      car.gear,
      Math.round(car.rpm * 100) / 100,
    ];
  }

  function pushState() {
    if (!netAlive) return;
    // the host owns the AI cars, so it reports them along with its own
    const mine = netRole === 'host'
      ? racers.filter((car) => car.local || !car.human)
      : racers.filter((car) => car.local);
    Net.send({ t: 's', c: mine.map(packCar) });
  }

  function onNetMessage(message) {
    if (!racers.length) return;

    if (message.t === 's') {
      message.c.forEach((state) => {
        const car = racers[state[0]];
        if (car && !car.local) applyNetCar(car, state);
      });
      return;
    }

    if (message.t === 'start' && netRole === 'guest') {
      raceState = 'countdown';
      countdown = 3.999;
      return;
    }

    if (message.t === 'fin') {
      const car = racers[message.i];
      if (car && !car.finished) {
        car.finished = true;
        car.finishTime = message.time;
        car.lap = LAPS;
        if (car.human) checkOnlineFinish();
      }
      return;
    }

    if (message.t === 'bye') {
      netAlive = false;
      statusEl.textContent = 'The other player left — their car is now on autopilot';
    }
  }

  function checkOnlineFinish() {
    const humans = racers.filter((car) => car.human);
    if (humans.every((car) => car.finished)) endRace();
  }

  /* ---------- Input ---------- */

  const CONTROLS = [
    { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', turbo: ['ShiftLeft', 'Space'] },
    { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', turbo: ['ShiftRight', 'Enter', 'Numpad0'] },
  ];

  /* Gear selection. Pressing any of these drops the car into manual. */
  const GEAR_KEYS = [
    {
      up: 'KeyE', down: 'KeyQ',
      digits: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'],
    },
    {
      up: 'Period', down: 'Comma',
      digits: ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6'],
    },
  ];

  function setGear(car, gear) {
    if (!car || car.finished) return;
    car.manual = true;
    const next = clamp(gear, 0, GEAR_TOP.length - 1);
    if (next === car.gear) return;
    car.gear = next;
    car.shiftTimer = SHIFT_TIME;
    if (car === players[0]) Sound.blip('shift');
  }

  /* Route a gear key to the right player (solo accepts either set). */
  function handleGearKey(code) {
    for (let set = 0; set < GEAR_KEYS.length; set++) {
      const keys = GEAR_KEYS[set];
      const car = splitScreen ? players[set] : players[0];
      if (!car) continue;
      if (code === keys.up) { setGear(car, car.gear + 1); return true; }
      if (code === keys.down) { setGear(car, car.gear - 1); return true; }
      const digit = keys.digits.indexOf(code);
      if (digit >= 0) { setGear(car, digit); return true; }
    }
    return false;
  }

  function readInput(index) {
    const sets = splitScreen ? [CONTROLS[index]] : CONTROLS;
    const held = (field) => sets.some((set) => {
      const value = set[field];
      return Array.isArray(value) ? value.some((code) => keys[code]) : keys[value];
    });
    return { up: held('up'), down: held('down'), left: held('left'), right: held('right'), turbo: held('turbo') };
  }

  /* ---------- Simulation ---------- */

  /* How much tow a car is getting from the one in front. */
  function draftFactor(car) {
    let best = 0;
    for (let i = 0; i < racers.length; i++) {
      const other = racers[i];
      if (other === car) continue;
      let gap = other.z - car.z;
      if (gap < 0) gap += trackLength;
      if (gap < SEG_LENGTH * 0.7 || gap > DRAFT_RANGE) continue;
      if (Math.abs(other.x - car.x) > 0.4) continue;
      best = Math.max(best, 1 - gap / DRAFT_RANGE);
    }
    return best;
  }

  /* Pick the gear for a speed, and the revs within it. */
  function drivetrain(car) {
    const fraction = car.speed / car.maxSpeed;
    let gear = 0;
    while (gear < GEAR_TOP.length - 1 && fraction > GEAR_TOP[gear]) gear += 1;
    const bottom = gear === 0 ? 0 : GEAR_TOP[gear - 1];
    const top = GEAR_TOP[gear];
    const rpm = clamp(0.18 + 0.82 * ((fraction - bottom) / (top - bottom)), 0.14, 1.12);
    return { gear, rpm };
  }

  function updatePlayer(car, index, dt) {
    const live = raceState === 'racing' && !car.finished;
    const input = live ? readInput(index) : {};
    const segment = findSegment(car.z + playerZ());
    const speedPercent = car.speed / car.maxSpeed;
    const offRoad = car.x < -1 || car.x > 1;

    /* --- turbo --- */
    car.boosting = Boolean(input.turbo) && car.turbo > 1 && car.speed > car.maxSpeed * 0.35;
    car.braking = Boolean(input.down);
    if (car.boosting) car.turbo = Math.max(0, car.turbo - TURBO_DRAIN * dt);
    else car.turbo = Math.min(car.turboMax, car.turbo + TURBO_REFILL * dt);

    /* --- slipstream --- */
    car.draft = draftFactor(car);
    let ceiling = car.maxSpeed * (car.boosting ? TURBO_MULT : 1) * (1 + car.draft * DRAFT_SPEED);

    /* --- gearbox: automatic, or whatever gear the driver selected --- */
    if (car.manual) {
      const bottom = car.gear === 0 ? 0 : GEAR_TOP[car.gear - 1];
      const top = GEAR_TOP[car.gear];
      car.rpm = clamp(0.18 + 0.82 * ((speedPercent - bottom) / (top - bottom)), 0.02, 1.3);
      car.overRev = car.rpm > 1.02;   // bouncing off the limiter
      car.bogging = car.rpm < 0.16;   // lugging in too tall a gear
    } else {
      const box = drivetrain(car);
      if (box.gear !== car.gear) {
        car.shiftTimer = SHIFT_TIME;
        if (car === players[0] && box.gear > car.gear) Sound.blip('shift');
        car.gear = box.gear;
      }
      car.rpm = box.rpm;
      car.overRev = false;
      car.bogging = false;
    }
    car.shiftTimer = Math.max(0, car.shiftTimer - dt);

    /* --- steering --- */
    const steerRate = dt * 2.4 * speedPercent * car.grip;
    if (input.left) { car.x -= steerRate; car.steer = -1; }
    else if (input.right) { car.x += steerRate; car.steer = 1; }
    else car.steer = 0;

    /* --- grip limit: past it the car washes wide and scrubs speed --- */
    const lateral = Math.abs(segment.curve) * speedPercent * speedPercent * 0.5
      + Math.abs(car.steer) * speedPercent * 0.22;
    const limit = car.grip * (offRoad ? 0.45 : 1);
    car.slip = clamp((lateral - limit * 0.72) / Math.max(0.2, limit), 0, 1);

    car.x -= dt * 2.4 * speedPercent * speedPercent * segment.curve * CENTRIFUGAL / car.grip;
    if (car.slip > 0.02) {
      car.x -= Math.sign(segment.curve || car.steer) * car.slip * dt * 1.3;
      car.speed -= car.speed * car.slip * dt * 0.5;
    }

    /* --- longitudinal --- */
    // in manual, the selected gear caps your speed no matter what else is going on
    if (car.manual) ceiling = Math.min(ceiling, car.maxSpeed * GEAR_TOP[car.gear] * 1.03);

    const cut = car.shiftTimer > 0 ? 0.06 : 1;
    let pull = GEAR_PULL[car.gear] * torqueAt(Math.min(car.rpm, 1.05)) * cut * (1 + car.draft * DRAFT_PULL);
    if (car.overRev) pull *= 0.08;    // limiter cuts the fuel
    if (car.bogging) pull *= 0.35;    // no revs, no torque
    if (input.up) car.speed += car.accelRate * pull * dt * (car.boosting ? 1.6 : 1);
    else if (input.down) car.speed += BRAKING * dt;
    else car.speed += DECEL * dt * (0.6 + car.rpm * 0.8);   // engine braking rises with revs

    if (offRoad && car.speed > OFF_ROAD_LIMIT) car.speed += OFF_ROAD_DECEL * dt;

    car.x = clamp(car.x, -2.2, 2.2);
    const previous = car.speed;
    car.speed = clamp(car.speed, 0, ceiling);
    if (!car.boosting && car.speed > car.maxSpeed) {
      car.speed = Math.max(car.maxSpeed, car.speed - car.maxSpeed * dt);
    }

    /* --- weight transfer: the body pitches under power and dives on the brakes --- */
    const gForce = clamp((car.speed - car.prevSpeed) / Math.max(0.001, dt) / 9000, -1, 1);
    car.prevSpeed = previous;
    car.pitch += (gForce * -70 - car.pitch) * Math.min(1, dt * 4);
    const lateralForce = clamp(car.steer * 0.7 + segment.curve * speedPercent * 0.22, -1, 1);
    car.roll += (lateralForce - car.roll) * Math.min(1, dt * 5);
    car.camX += (car.x - car.camX) * Math.min(1, dt * 7);   // camera trails the car slightly

    /* --- rumble strips and rough ground shake the view --- */
    const rough = offRoad ? 0.7 : (Math.abs(car.x) > 0.92 ? 0.4 : 0);
    car.shake = Math.max(car.shake * 0.9, rough * speedPercent * 4 + car.slip * speedPercent * 3);

    /* --- tyre smoke --- */
    if ((car.slip > 0.12 || (car.braking && speedPercent > 0.5)) && car.smoke.length < 26) {
      car.smoke.push({ x: (Math.random() - 0.5) * 0.7, y: 0, life: 1, size: 6 + Math.random() * 8 });
    }
    for (let i = car.smoke.length - 1; i >= 0; i--) {
      const puff = car.smoke[i];
      puff.life -= dt * 1.5;
      puff.y += dt * 26;
      puff.size += dt * 26;
      if (puff.life <= 0) car.smoke.splice(i, 1);
    }

    car.bg += segment.curve * speedPercent * dt * 26;
  }

  function updateAI(car, dt) {
    if (raceState !== 'racing' || car.finished) { car.speed = Math.max(0, car.speed - car.accelRate * dt); return; }

    const segment = findSegment(car.z + playerZ());
    const ahead = findSegment(car.z + playerZ() + SEG_LENGTH * 22);
    const cornerBrake = 1 - Math.min(0.28, Math.abs(ahead.curve) * 0.045);
    const leader = racers.reduce((best, other) => (progress(other) > progress(best) ? other : best), racers[0]);
    const gap = (progress(leader) - progress(car)) / trackLength;
    const band = 1 + clamp(gap, -0.15, 0.35) * 0.22;

    car.draft = draftFactor(car);
    const target = car.maxSpeed * AI_SKILL[difficulty] * cornerBrake * band * (1 + car.draft * DRAFT_SPEED);
    car.speed += (target - car.speed) * Math.min(1, dt * 1.6);
    car.braking = car.speed > target * 1.04;

    car.laneTimer -= dt;
    if (car.laneTimer <= 0) {
      car.laneTimer = 1.2 + Math.random() * 2;
      const blocked = racers.some((other) => other !== car
        && other.z > car.z && other.z - car.z < SEG_LENGTH * 14
        && Math.abs(other.x - car.lane) < 0.45);
      car.lane = blocked
        ? clamp(car.lane + (Math.random() < 0.5 ? -0.55 : 0.55), -0.7, 0.7)
        : clamp(car.lane + (Math.random() - 0.5) * 0.3, -0.7, 0.7);
    }

    car.wobble += dt * 2;
    car.x += ((car.lane + Math.sin(car.wobble) * 0.02) - car.x) * Math.min(1, dt * 2.2);
    car.x -= dt * (car.speed / car.maxSpeed) * segment.curve * CENTRIFUGAL * 0.55;
    car.x = clamp(car.x, -0.95, 0.95);
  }

  const progress = (car) => (car.lap - 1) * trackLength + car.z;

  function advance(car, dt) {
    car.z += car.speed * dt;
    while (car.z >= trackLength) {
      car.z -= trackLength;
      if (car.finished) continue;
      const lapTime = raceTime - car.lapStart;
      car.lapStart = raceTime;
      if (car.bestLap === null || lapTime < car.bestLap) car.bestLap = lapTime;
      car.lap += 1;
      if (car.lap > LAPS) finishRacer(car);
    }
  }

  function collide(dt) {
    collide.cooldown = Math.max(0, (collide.cooldown || 0) - dt);
    for (let i = 0; i < racers.length; i++) {
      for (let j = i + 1; j < racers.length; j++) {
        const a = racers[i];
        const b = racers[j];
        const dz = Math.abs(a.z - b.z);
        if (dz > SEG_LENGTH * 2 && dz < trackLength - SEG_LENGTH * 2) continue;
        if (Math.abs(a.x - b.x) > 0.42) continue;

        const front = a.z > b.z ? a : b;
        const back = a.z > b.z ? b : a;
        const push = (a.x < b.x ? -1 : 1) * 0.9 * dt;
        a.x += push;
        b.x -= push;
        const closing = Math.abs(back.speed - front.speed);
        back.speed = Math.min(back.speed, front.speed * 0.86);
        front.speed = Math.min(front.maxSpeed, front.speed * 0.98 + 20);

        // a real hit rattles the view and thumps
        if (closing > 900) {
          if (a.human) a.shake = Math.max(a.shake, 7);
          if (b.human) b.shake = Math.max(b.shake, 7);
          if ((a.human || b.human) && !collide.cooldown) {
            Sound.blip('impact');
            collide.cooldown = 0.35;
          }
        }
      }
    }
  }

  function updatePlaces() {
    const order = racers.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return progress(b) - progress(a);
    });
    order.forEach((car, index) => { car.place = index + 1; });
    return order;
  }

  function finishRacer(car) {
    car.finished = true;
    car.finishTime = raceTime;
    car.lap = LAPS;

    if (online) {
      if (car.local || netRole === 'host') Net.send({ t: 'fin', i: car.id, time: raceTime });
      if (car.human) checkOnlineFinish();
      return;
    }

    if (car.human && players.every((player) => player.finished)) endRace();
  }

  /* ---------- Projection ---------- */

  function project(point, cameraX, cameraY, cameraZ, width, height) {
    point.camera.x = (point.world.x || 0) - cameraX;
    point.camera.y = (point.world.y || 0) - cameraY;
    point.camera.z = (point.world.z || 0) - cameraZ;
    const scale = CAMERA_DEPTH / point.camera.z;
    point.screen.scale = scale;
    point.screen.x = (width / 2 + scale * point.camera.x * width / 2) | 0;
    point.screen.y = (height / 2 - scale * point.camera.y * height / 2) | 0;
    point.screen.w = (scale * ROAD_WIDTH * width / 2) | 0;
  }

  function polygon(x1, y1, x2, y2, x3, y3, x4, y4, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.lineTo(x4, y4);
    ctx.closePath();
    ctx.fill();
  }

  function roundedRect(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    ctx.fill();
  }

  /* ---------- Sprites ---------- */

  /* A 3/4 rear view: the body is a pair of tapered volumes (wide rear track,
     narrower roofline) rather than flat rectangles, which is what sells the
     depth. `skew` shows a sliver of the near flank for cars off to one side. */
  function drawCar(g, x, y, width, car, tilt, detailed, skew = 0) {
    const shape = car.shape || { width: 1, roof: 0.46, spoiler: 1, wheel: 1 };
    const w = width * shape.width;
    const h = w * 0.62;
    const top = y - h;
    const half = w / 2;

    const restore = tilt || skew;
    if (restore) {
      g.save();
      g.translate(x, y);
      if (tilt) g.rotate(tilt * 0.045);
      if (skew) g.transform(1, 0, skew * 0.22, 1, 0, 0);
      g.translate(-x, -y);
    }

    /* contact shadow */
    g.fillStyle = 'rgba(0,0,0,0.32)';
    g.beginPath();
    g.ellipse(x, y, half * 1.08, h * 0.15, 0, 0, Math.PI * 2);
    g.fill();

    /* rear tyres — sunk behind the bodywork, with a rim face */
    const wheelW = w * 0.2 * shape.wheel;
    const wheelH = h * 0.44 * shape.wheel;
    [-1, 1].forEach((side) => {
      const wx = x + side * (half - wheelW * 0.42);
      g.fillStyle = '#0b1120';
      roundedRectOn(g, wx - wheelW / 2, y - wheelH, wheelW, wheelH, wheelW * 0.28);
      if (detailed) {
        // tread blocks down the visible shoulder of the tyre
        g.fillStyle = 'rgba(255,255,255,0.09)';
        for (let tread = 0; tread < 4; tread++) {
          g.fillRect(wx - wheelW * 0.46, y - wheelH * (0.9 - tread * 0.22), wheelW * 0.92, wheelH * 0.05);
        }
        g.fillStyle = '#334155';
        roundedRectOn(g, wx - wheelW * 0.3, y - wheelH * 0.78, wheelW * 0.6, wheelH * 0.45, wheelW * 0.16);
        g.fillStyle = 'rgba(255,255,255,0.28)';
        g.fillRect(wx - wheelW * 0.24, y - wheelH * 0.66, wheelW * 0.48, wheelH * 0.08);
      }
    });

    if (car.profile === 'sport') {
      drawSportRear(g, x, y, w, h, car, detailed);
      if (car.boosting) drawFlame(g, x, y, w, h);
      if (restore) g.restore();
      return;
    }

    /* lower body: wider at the bottom so it reads as a solid volume */
    const bodyTop = top + h * shape.roof;
    const bottomHalf = half;
    const shoulderHalf = half * 0.9;

    if (detailed) {
      const paint = g.createLinearGradient(x - half, bodyTop, x + half, y);
      paint.addColorStop(0, car.trim);
      paint.addColorStop(0.32, car.body);
      paint.addColorStop(0.62, car.accent || car.body);
      paint.addColorStop(1, car.trim);
      g.fillStyle = paint;
    } else {
      g.fillStyle = car.body;
    }
    g.beginPath();
    g.moveTo(x - shoulderHalf, bodyTop);
    g.lineTo(x + shoulderHalf, bodyTop);
    g.lineTo(x + bottomHalf, y - h * 0.1);
    g.lineTo(x + bottomHalf * 0.86, y);
    g.lineTo(x - bottomHalf * 0.86, y);
    g.lineTo(x - bottomHalf, y - h * 0.1);
    g.closePath();
    g.fill();

    /* metallic flake in the paint, only worth it on a big sprite */
    if (detailed && w > 44) {
      g.save();
      g.clip();
      g.globalAlpha = 0.5;
      g.fillStyle = getPattern(g, 'flake', 48, paintFlake);
      g.fillRect(x - bottomHalf, bodyTop, bottomHalf * 2, h);
      g.restore();
    }

    /* cabin: tapers inward toward the roof */
    const roofHalf = half * 0.52;
    g.fillStyle = car.trim;
    g.beginPath();
    g.moveTo(x - roofHalf, top);
    g.lineTo(x + roofHalf, top);
    g.lineTo(x + shoulderHalf * 0.98, bodyTop);
    g.lineTo(x - shoulderHalf * 0.98, bodyTop);
    g.closePath();
    g.fill();

    /* rear glass */
    if (detailed) {
      const glass = g.createLinearGradient(0, top, 0, bodyTop);
      glass.addColorStop(0, 'rgba(226,244,255,0.85)');
      glass.addColorStop(0.55, 'rgba(120,170,210,0.6)');
      glass.addColorStop(1, 'rgba(20,40,60,0.75)');
      g.fillStyle = glass;
    } else {
      g.fillStyle = 'rgba(170,210,240,0.6)';
    }
    g.beginPath();
    g.moveTo(x - roofHalf * 0.84, top + h * 0.06);
    g.lineTo(x + roofHalf * 0.84, top + h * 0.06);
    g.lineTo(x + shoulderHalf * 0.8, bodyTop - h * 0.03);
    g.lineTo(x - shoulderHalf * 0.8, bodyTop - h * 0.03);
    g.closePath();
    g.fill();

    /* spoiler — carbon fibre once the sprite is big enough to show the weave */
    const spoilerW = half * 1.9 * shape.spoiler * 0.5;
    g.fillStyle = detailed && w > 60 ? getPattern(g, 'carbon', 16, paintCarbon) : car.trim;
    g.fillRect(x - spoilerW, bodyTop - h * 0.1, spoilerW * 2, h * 0.07);
    g.fillStyle = car.trim;
    g.fillRect(x - spoilerW * 0.72, bodyTop - h * 0.08, w * 0.05, h * 0.12);
    g.fillRect(x + spoilerW * 0.62, bodyTop - h * 0.08, w * 0.05, h * 0.12);

    /* tail lights, brighter under braking */
    const lit = car.braking;
    g.fillStyle = lit ? '#fee2e2' : '#dc2626';
    roundedRectOn(g, x - half * 0.84, y - h * 0.42, w * 0.22, h * 0.13, h * 0.04);
    roundedRectOn(g, x + half * 0.84 - w * 0.22, y - h * 0.42, w * 0.22, h * 0.13, h * 0.04);
    if (detailed && lit) {
      g.fillStyle = 'rgba(248,113,113,0.4)';
      roundedRectOn(g, x - half, y - h * 0.5, w, h * 0.28, h * 0.1);
    }

    if (detailed) {
      /* bumper, carbon diffuser, exhausts, plate */
      g.fillStyle = w > 60 ? getPattern(g, 'carbon', 16, paintCarbon) : 'rgba(0,0,0,0.35)';
      g.fillRect(x - bottomHalf * 0.86, y - h * 0.16, bottomHalf * 1.72, h * 0.16);
      g.fillStyle = '#0f172a';
      for (let fin = -2; fin <= 2; fin++) {
        g.fillRect(x + fin * w * 0.12 - w * 0.012, y - h * 0.14, w * 0.024, h * 0.12);
      }
      g.fillStyle = '#94a3b8';
      g.beginPath();
      g.arc(x - w * 0.26, y - h * 0.06, w * 0.035, 0, Math.PI * 2);
      g.arc(x + w * 0.26, y - h * 0.06, w * 0.035, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#e2e8f0';
      g.fillRect(x - w * 0.1, y - h * 0.36, w * 0.2, h * 0.09);

      /* specular streak along the shoulder line */
      g.fillStyle = 'rgba(255,255,255,0.2)';
      g.fillRect(x - shoulderHalf * 0.94, bodyTop + h * 0.05, shoulderHalf * 1.88, h * 0.045);
    }

    /* turbo flame */
    if (car.boosting) {
      const flicker = 0.75 + Math.sin(clockNow * 0.045) * 0.3;
      g.fillStyle = 'rgba(59,130,246,0.75)';
      g.beginPath();
      g.moveTo(x - w * 0.22, y - h * 0.06);
      g.lineTo(x, y + h * 0.8 * flicker);
      g.lineTo(x + w * 0.22, y - h * 0.06);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(253,224,71,0.9)';
      g.beginPath();
      g.moveTo(x - w * 0.1, y - h * 0.06);
      g.lineTo(x, y + h * 0.42 * flicker);
      g.lineTo(x + w * 0.1, y - h * 0.06);
      g.closePath();
      g.fill();
    }

    if (restore) g.restore();
  }

  /* Rear three-quarter of a rear-engined sports coupe: wide haunches that
     curve over the wheels, a fastback screen, a full-width light bar and
     quad tailpipes under a ducktail. */
  function drawSportRear(g, x, y, w, h, car, detailed) {
    const top = y - h;
    const half = w / 2;
    const hipY = top + h * 0.34;          // widest point, over the rear arches
    const deckY = top + h * 0.3;          // engine cover / rear deck
    const roofHalf = half * 0.5;

    /* haunches: bezier shoulders instead of a flat trapezoid */
    if (detailed) {
      const paint = g.createLinearGradient(x - half, deckY, x + half, y);
      paint.addColorStop(0, car.trim);
      paint.addColorStop(0.2, car.body);
      paint.addColorStop(0.5, car.accent || car.body);
      paint.addColorStop(0.8, car.body);
      paint.addColorStop(1, car.trim);
      g.fillStyle = paint;
    } else {
      g.fillStyle = car.body;
    }
    g.beginPath();
    g.moveTo(x - half * 0.62, deckY);
    g.quadraticCurveTo(x - half, deckY, x - half, hipY);      // left haunch
    g.lineTo(x - half, y - h * 0.14);
    g.quadraticCurveTo(x - half, y, x - half * 0.8, y);
    g.lineTo(x + half * 0.8, y);
    g.quadraticCurveTo(x + half, y, x + half, y - h * 0.14);
    g.lineTo(x + half, hipY);
    g.quadraticCurveTo(x + half, deckY, x + half * 0.62, deckY); // right haunch
    g.closePath();
    g.fill();

    if (detailed && w > 44) {
      g.save();
      g.clip();
      g.globalAlpha = 0.45;
      g.fillStyle = getPattern(g, 'flake', 48, paintFlake);
      g.fillRect(x - half, deckY, w, h);
      g.restore();
    }

    /* fastback roof and rear screen */
    g.fillStyle = car.trim;
    g.beginPath();
    g.moveTo(x - roofHalf, top + h * 0.04);
    g.quadraticCurveTo(x, top - h * 0.06, x + roofHalf, top + h * 0.04);
    g.lineTo(x + half * 0.68, deckY + h * 0.02);
    g.lineTo(x - half * 0.68, deckY + h * 0.02);
    g.closePath();
    g.fill();

    if (detailed) {
      const glass = g.createLinearGradient(0, top, 0, deckY);
      glass.addColorStop(0, 'rgba(222,242,255,0.8)');
      glass.addColorStop(0.6, 'rgba(110,160,200,0.55)');
      glass.addColorStop(1, 'rgba(16,32,48,0.8)');
      g.fillStyle = glass;
    } else {
      g.fillStyle = 'rgba(170,210,240,0.55)';
    }
    g.beginPath();
    g.moveTo(x - roofHalf * 0.86, top + h * 0.09);
    g.quadraticCurveTo(x, top + h * 0.01, x + roofHalf * 0.86, top + h * 0.09);
    g.lineTo(x + half * 0.58, deckY - h * 0.01);
    g.lineTo(x - half * 0.58, deckY - h * 0.01);
    g.closePath();
    g.fill();

    /* louvred engine cover between the screen and the light bar */
    if (detailed && w > 52) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      for (let slat = 0; slat < 4; slat++) {
        g.fillRect(x - half * 0.42, deckY + h * (0.06 + slat * 0.045), w * 0.42, h * 0.018);
      }
    }

    /* ducktail: a lip that runs the whole width and kicks up at the trailing edge */
    g.fillStyle = detailed && w > 60 ? getPattern(g, 'carbon', 16, paintCarbon) : car.trim;
    g.beginPath();
    g.moveTo(x - half * 0.96, deckY + h * 0.02);
    g.quadraticCurveTo(x, deckY - h * 0.12, x + half * 0.96, deckY + h * 0.02);
    g.lineTo(x + half * 0.96, deckY + h * 0.08);
    g.quadraticCurveTo(x, deckY - h * 0.04, x - half * 0.96, deckY + h * 0.08);
    g.closePath();
    g.fill();

    /* the signature: one continuous light bar across the full width */
    const barY = y - h * 0.42;
    const barH = h * 0.1;
    const lit = car.braking;
    if (detailed) {
      const bar = g.createLinearGradient(x - half, 0, x + half, 0);
      bar.addColorStop(0, lit ? '#fee2e2' : '#7f1d1d');
      bar.addColorStop(0.5, lit ? '#fca5a5' : '#dc2626');
      bar.addColorStop(1, lit ? '#fee2e2' : '#7f1d1d');
      g.fillStyle = bar;
    } else {
      g.fillStyle = lit ? '#fca5a5' : '#dc2626';
    }
    roundedRectOn(g, x - half * 0.9, barY, half * 1.8, barH, barH * 0.45);

    // inner lens detail + brake glow
    if (detailed) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x - half * 0.9, barY + barH * 0.42, half * 1.8, barH * 0.16);
      if (lit) {
        g.fillStyle = 'rgba(248,113,113,0.4)';
        roundedRectOn(g, x - half, barY - h * 0.06, w, barH + h * 0.12, h * 0.09);
      }
      // reflector strip below
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(x - half * 0.34, y - h * 0.27, w * 0.34, h * 0.035);
    }

    /* rear bumper, diffuser and quad tailpipes */
    if (detailed) {
      g.fillStyle = w > 60 ? getPattern(g, 'carbon', 16, paintCarbon) : 'rgba(0,0,0,0.4)';
      g.beginPath();
      g.moveTo(x - half * 0.72, y - h * 0.17);
      g.lineTo(x + half * 0.72, y - h * 0.17);
      g.lineTo(x + half * 0.6, y);
      g.lineTo(x - half * 0.6, y);
      g.closePath();
      g.fill();

      g.fillStyle = '#0f172a';
      for (let fin = -2; fin <= 2; fin++) {
        g.fillRect(x + fin * w * 0.1 - w * 0.011, y - h * 0.14, w * 0.022, h * 0.12);
      }

      g.fillStyle = '#cbd5e1';
      [-1, 1].forEach((side) => {
        [0.2, 0.3].forEach((offset) => {
          g.beginPath();
          g.arc(x + side * w * offset, y - h * 0.09, w * 0.032, 0, Math.PI * 2);
          g.fill();
        });
      });
      g.fillStyle = '#111827';
      [-1, 1].forEach((side) => {
        [0.2, 0.3].forEach((offset) => {
          g.beginPath();
          g.arc(x + side * w * offset, y - h * 0.09, w * 0.019, 0, Math.PI * 2);
          g.fill();
        });
      });

      /* highlight over the haunches */
      g.strokeStyle = 'rgba(255,255,255,0.28)';
      g.lineWidth = Math.max(1, h * 0.03);
      g.beginPath();
      g.moveTo(x - half * 0.94, hipY + h * 0.06);
      g.quadraticCurveTo(x, hipY - h * 0.02, x + half * 0.94, hipY + h * 0.06);
      g.stroke();
    }
  }

  function drawFlame(g, x, y, w, h) {
    const flicker = 0.75 + Math.sin(clockNow * 0.045) * 0.3;
    g.fillStyle = 'rgba(59,130,246,0.75)';
    g.beginPath();
    g.moveTo(x - w * 0.22, y - h * 0.06);
    g.lineTo(x, y + h * 0.8 * flicker);
    g.lineTo(x + w * 0.22, y - h * 0.06);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(253,224,71,0.9)';
    g.beginPath();
    g.moveTo(x - w * 0.1, y - h * 0.06);
    g.lineTo(x, y + h * 0.42 * flicker);
    g.lineTo(x + w * 0.1, y - h * 0.06);
    g.closePath();
    g.fill();
  }

  function roundedRectOn(g, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + radius, y);
    g.arcTo(x + w, y, x + w, y + h, radius);
    g.arcTo(x + w, y + h, x, y + h, radius);
    g.arcTo(x, y + h, x, y, radius);
    g.arcTo(x, y, x + w, y, radius);
    g.closePath();
    g.fill();
  }

  /* How tall each kind stands relative to its width. */
  const PROP_RATIO = {
    pine: 1.9, cactus: 1.6, palm: 2.3, rock: 0.62, barrel: 0.85,
    tyres: 0.42, snowman: 1.0, hut: 0.95, pylon: 2.1, lamp: 2.5,
    billboard: 1.5, sign: 1.2,
  };

  function drawProp(kind, x, y, width) {
    const height = width * (PROP_RATIO[kind] || 1.5);
    const w = width;
    const h = height;

    switch (kind) {
      case 'pine': {
        ctx.fillStyle = '#4b3621';
        ctx.fillRect(x - w * 0.07, y - h * 0.22, w * 0.14, h * 0.22);
        ctx.fillStyle = '#166534';
        for (let tier = 0; tier < 3; tier++) {
          const top = y - h + (h * 0.24) * tier;
          const spread = w * (0.28 + tier * 0.1);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x + spread, top + h * 0.34);
          ctx.lineTo(x - spread, top + h * 0.34);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath();
        ctx.moveTo(x, y - h);
        ctx.lineTo(x + w * 0.16, y - h * 0.82);
        ctx.lineTo(x - w * 0.16, y - h * 0.82);
        ctx.closePath();
        ctx.fill();
        return;
      }

      case 'cactus': {
        ctx.fillStyle = '#2f7a3d';
        ctx.fillRect(x - w * 0.12, y - h, w * 0.24, h);
        ctx.fillRect(x - w * 0.44, y - h * 0.62, w * 0.16, h * 0.4);
        ctx.fillRect(x + w * 0.28, y - h * 0.74, w * 0.16, h * 0.52);
        ctx.fillRect(x - w * 0.44, y - h * 0.62, w * 0.32, w * 0.16);
        ctx.fillRect(x + w * 0.12, y - h * 0.74, w * 0.32, w * 0.16);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(x + w * 0.02, y - h, w * 0.1, h);
        return;
      }

      case 'palm': {
        ctx.fillStyle = '#8b5e34';
        ctx.fillRect(x - w * 0.06, y - h * 0.78, w * 0.12, h * 0.78);
        ctx.fillStyle = '#15803d';
        for (let leaf = 0; leaf < 6; leaf++) {
          const angle = (leaf / 6) * Math.PI * 2;
          ctx.beginPath();
          ctx.ellipse(x + Math.cos(angle) * w * 0.3, y - h * 0.8 + Math.sin(angle) * h * 0.08,
            w * 0.32, h * 0.05, angle * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#a16207';
        ctx.beginPath();
        ctx.arc(x, y - h * 0.78, w * 0.09, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      case 'rock': {
        ctx.fillStyle = '#6b7280';
        ctx.beginPath();
        ctx.moveTo(x - w * 0.45, y);
        ctx.lineTo(x - w * 0.28, y - h * 0.8);
        ctx.lineTo(x + w * 0.05, y - h);
        ctx.lineTo(x + w * 0.4, y - h * 0.55);
        ctx.lineTo(x + w * 0.48, y);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.beginPath();
        ctx.moveTo(x + w * 0.05, y - h);
        ctx.lineTo(x + w * 0.4, y - h * 0.55);
        ctx.lineTo(x + w * 0.1, y - h * 0.5);
        ctx.closePath();
        ctx.fill();
        return;
      }

      case 'barrel': {
        ctx.fillStyle = '#ea580c';
        ctx.fillRect(x - w * 0.22, y - h, w * 0.44, h);
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(x - w * 0.22, y - h * 0.72, w * 0.44, h * 0.2);
        ctx.fillRect(x - w * 0.22, y - h * 0.28, w * 0.44, h * 0.16);
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(x + w * 0.08, y - h, w * 0.14, h);
        return;
      }

      case 'tyres': {
        ctx.fillStyle = '#1f2937';
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.ellipse(x - w * 0.3 + i * w * 0.3, y - h * 0.5, w * 0.19, h * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#f8fafc';
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.ellipse(x - w * 0.3 + i * w * 0.3, y - h * 0.5, w * 0.07, h * 0.2, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }

      case 'snowman': {
        ctx.fillStyle = '#f8fafc';
        ctx.beginPath();
        ctx.arc(x, y - h * 0.22, w * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y - h * 0.58, w * 0.22, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y - h * 0.84, w * 0.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#111827';
        ctx.fillRect(x - w * 0.17, y - h * 0.99, w * 0.34, h * 0.09);
        ctx.fillRect(x - w * 0.11, y - h * 1.1, w * 0.22, h * 0.13);
        ctx.fillStyle = '#f97316';
        ctx.fillRect(x + w * 0.1, y - h * 0.86, w * 0.14, h * 0.04);
        return;
      }

      case 'hut': {
        ctx.fillStyle = '#7c4a24';
        ctx.fillRect(x - w * 0.42, y - h * 0.6, w * 0.84, h * 0.6);
        ctx.fillStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(x - w * 0.52, y - h * 0.58);
        ctx.lineTo(x, y - h);
        ctx.lineTo(x + w * 0.52, y - h * 0.58);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#facc15';
        ctx.fillRect(x - w * 0.14, y - h * 0.44, w * 0.28, h * 0.24);
        return;
      }

      case 'pylon': {
        ctx.fillStyle = '#22d3ee';
        ctx.fillRect(x - w * 0.07, y - h, w * 0.14, h);
        ctx.fillStyle = '#f0abfc';
        ctx.fillRect(x - w * 0.3, y - h, w * 0.6, h * 0.06);
        ctx.fillStyle = 'rgba(240,171,252,0.3)';
        ctx.fillRect(x - w * 0.18, y - h, w * 0.36, h * 0.22);
        return;
      }

      case 'lamp': {
        ctx.fillStyle = '#475569';
        ctx.fillRect(x - w * 0.05, y - h, w * 0.1, h);
        ctx.fillRect(x - w * 0.05, y - h, w * 0.36, h * 0.05);
        ctx.fillStyle = '#fde68a';
        ctx.beginPath();
        ctx.ellipse(x + w * 0.3, y - h * 0.97, w * 0.12, h * 0.035, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(253,230,138,0.22)';
        ctx.beginPath();
        ctx.moveTo(x + w * 0.3, y - h * 0.95);
        ctx.lineTo(x + w * 0.75, y);
        ctx.lineTo(x - w * 0.15, y);
        ctx.closePath();
        ctx.fill();
        return;
      }

      case 'billboard': {
        ctx.fillStyle = '#475569';
        ctx.fillRect(x - w * 0.07, y - h * 0.55, w * 0.06, h * 0.55);
        ctx.fillRect(x + w * 0.02, y - h * 0.55, w * 0.06, h * 0.55);
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(x - w * 0.6, y - h, w * 1.2, h * 0.5);
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(x - w * 0.55, y - h * 0.95, w * 1.1, h * 0.4);
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(x - w * 0.44, y - h * 0.86, w * 0.88, h * 0.09);
        ctx.fillRect(x - w * 0.3, y - h * 0.72, w * 0.6, h * 0.08);
        return;
      }

      default: { // sign
        ctx.fillStyle = '#9ca3af';
        ctx.fillRect(x - w * 0.05, y - h * 0.66, w * 0.1, h * 0.66);
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(x - w * 0.45, y - h, w * 0.9, h * 0.4);
        ctx.fillStyle = '#dc2626';
        ctx.fillRect(x - w * 0.36, y - h * 0.93, w * 0.72, h * 0.25);
      }
    }
  }

  /* ---------- Cached gradients ---------- */

  function skyGradient(h) {
    const key = `sky-${trackId}-${h}`;
    if (!cache[key]) {
      const grd = ctx.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, track.sky[0]);
      grd.addColorStop(0.58, track.sky[1]);
      grd.addColorStop(1, track.sky[2]);
      cache[key] = grd;
    }
    return cache[key];
  }

  function vignette(w, h) {
    const key = `vig-${w}-${h}`;
    if (!cache[key]) {
      const grd = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.95);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(1, 'rgba(0,0,0,0.42)');
      cache[key] = grd;
    }
    return cache[key];
  }

  /* ---------- Rendering one viewport ---------- */

  function renderView(view) {
    const { w, h, camera, car } = view;
    const colors = track.colors;
    const pz = playerZ();

    ctx.save();
    ctx.beginPath();
    ctx.rect(view.x, view.y, w, h);
    ctx.clip();
    // camera shake from kerbs, dirt and contact
    const shake = car.shake;
    ctx.translate(
      view.x + (shake ? (Math.random() - 0.5) * shake : 0),
      view.y + (shake ? (Math.random() - 0.5) * shake : 0),
    );

    ctx.fillStyle = skyGradient(h);
    ctx.fillRect(0, 0, w, h);

    const baseSegment = findSegment(camera.z);
    const basePercent = (camera.z % SEG_LENGTH) / SEG_LENGTH;
    const playerSegment = findSegment(camera.z + pz);
    const playerPercent = ((camera.z + pz) % SEG_LENGTH) / SEG_LENGTH;
    const playerY = lerp(playerSegment.p1.world.y, playerSegment.p2.world.y, playerPercent);
    const horizon = h * 0.52 - playerY / 34;

    drawSky(w, h, horizon, view);

    /* --- pass 1: project, collect what is actually visible --- */
    visible.length = 0;
    projected.length = 0;
    let maxy = h;
    let x = 0;
    let dx = -(baseSegment.curve * basePercent);

    for (let n = 0; n < drawDistance; n++) {
      const segment = segments[(baseSegment.index + n) % segments.length];
      const looped = segment.index < baseSegment.index;
      segment.clip = maxy;
      segment.frame = frameId;
      segment.fog = 1 / Math.pow(Math.E, (n / drawDistance) * (n / drawDistance) * 4);

      const offsetZ = camera.z - (looped ? trackLength : 0);
      const eye = playerY + CAMERA_HEIGHT + car.pitch;
      project(segment.p1, camera.x * ROAD_WIDTH - x, eye, offsetZ, w, h);
      project(segment.p2, camera.x * ROAD_WIDTH - x - dx, eye, offsetZ, w, h);

      x += dx;
      dx += segment.curve;

      if (segment.p1.camera.z <= CAMERA_DEPTH) continue;

      // Sprites use every projected segment. A segment can fail the road tests
      // below for a single frame (rounding makes p1.y and p2.y equal); if its
      // scenery were tied to that list the trees would blink in and out.
      projected.push(segment);

      if (segment.p2.screen.y >= segment.p1.screen.y) continue;
      if (segment.p2.screen.y >= maxy) continue;

      visible.push(segment);
      maxy = segment.p2.screen.y;
      if (maxy <= 0) break;  // the road has filled the view; nothing beyond can show
    }

    /* --- pass 2: grass, batched into runs of one colour --- */
    let spanColor = null;
    let spanBottom = h;
    for (let i = 0; i < visible.length; i++) {
      const grass = visible[i].color.grass;
      if (spanColor === null) spanColor = grass;
      else if (grass !== spanColor) {
        const top = visible[i].p1.screen.y;
        ctx.fillStyle = spanColor;
        ctx.fillRect(0, top, w, spanBottom - top);
        spanBottom = top;
        spanColor = grass;
      }
    }
    if (spanColor !== null) {
      ctx.fillStyle = spanColor;
      ctx.fillRect(0, maxy, w, spanBottom - maxy);
    }

    /* terrain texture over the whole ground plane (the road covers it next) */
    if (visible.length) {
      const terrain = getPattern(ctx, 'terrain', 128, paintTerrain);
      scrollPattern(terrain, (car.z * 0.05) % 128);
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = terrain;
      ctx.fillRect(0, maxy, w, h - maxy);
      ctx.globalAlpha = 1;
    }

    /* --- pass 3: road surface, collecting its outline for the asphalt grain --- */
    const roadPath = new Path2D();
    for (let i = 0; i < visible.length; i++) {
      const segment = visible[i];
      renderSegment(w, segment);
      const a = segment.p1.screen;
      const b = segment.p2.screen;
      roadPath.moveTo(a.x - a.w, a.y);
      roadPath.lineTo(a.x + a.w, a.y);
      roadPath.lineTo(b.x + b.w, b.y);
      roadPath.lineTo(b.x - b.w, b.y);
      roadPath.closePath();
    }

    if (visible.length) {
      const asphalt = getPattern(ctx, 'asphalt', 96, paintAsphalt);
      scrollPattern(asphalt, (car.z * 0.14) % 96);
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = asphalt;
      ctx.fill(roadPath);
      ctx.globalAlpha = 1;
    }

    /* --- distance fog as a single gradient instead of per-segment alpha --- */
    const fogHeight = Math.max(1, h * 0.4);
    const fogKey = `fog-${trackId}-${h}`;
    if (!cache[fogKey]) {
      // built at the origin so it can be translated to the horizon each frame
      const grd = ctx.createLinearGradient(0, 0, 0, fogHeight);
      grd.addColorStop(0, colors.fog);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      cache[fogKey] = grd;
    }
    ctx.save();
    ctx.translate(0, maxy);
    ctx.fillStyle = cache[fogKey];
    ctx.fillRect(0, 0, w, fogHeight);
    ctx.restore();

    /* --- pass 4: sprites, far to near --- */
    for (let i = projected.length - 1; i >= 0; i--) {
      const segment = projected[i];
      const screen = segment.p1.screen;
      if (screen.scale <= 0 || screen.y > segment.clip) continue;

      for (let p = 0; p < segment.props.length; p++) {
        const prop = segment.props[p];
        const spriteW = screen.scale * PROP_BASE * prop.scale * w / 2;
        if (spriteW < 1.5) continue;
        const spriteX = screen.x + screen.scale * prop.side * prop.offset * ROAD_WIDTH * w / 2;
        if (spriteX < -spriteW * 2 || spriteX > w + spriteW * 2) continue;
        ctx.globalAlpha = segment.fog;
        drawProp(prop.kind, spriteX, screen.y, spriteW);
        ctx.globalAlpha = 1;
      }

      for (let c = 0; c < segment.cars.length; c++) {
        const other = segment.cars[c];
        if (other === car) continue;
        const percent = (other.z % SEG_LENGTH) / SEG_LENGTH;
        const scale = lerp(segment.p1.screen.scale, segment.p2.screen.scale, percent);
        const carW = scale * CAR_WIDTH * RIVAL_SCALE * w / 2;
        if (carW < 1.5) continue;
        const carX = lerp(segment.p1.screen.x, segment.p2.screen.x, percent) + scale * other.x * ROAD_WIDTH * w / 2;
        const carY = lerp(segment.p1.screen.y, segment.p2.screen.y, percent);
        if (carY > segment.clip) continue;
        ctx.globalAlpha = segment.fog;
        // cars away from the view centre show a little of their near flank
        drawCar(ctx, carX, carY, carW, other, 0, carW > 26, (carX - w / 2) / w);
        ctx.globalAlpha = 1;
      }
    }

    /* --- headlights on the night circuit --- */
    if (track.night) drawHeadlights(w, h, maxy);

    /* --- the player's own car --- */
    const ownScale = CAMERA_DEPTH / pz;
    const ownW = ownScale * CAR_WIDTH * OWN_SCALE * w / 2;
    const bounce = Math.sin(car.z * 0.02) * 1.6 * (car.speed / car.maxSpeed);
    const offRoad = Math.abs(car.x) > 1;
    if (offRoad && car.speed > 200) drawDust(w / 2, h - 10, ownW, colors.grass);
    drawSmoke(car, w / 2, h - 10, ownW);
    drawCar(ctx, w / 2, h - 14 + bounce, ownW, car, car.steer + car.roll * 0.8, true);

    if (car.boosting || car.draft > 0.4) drawSpeedLines(w, h);
    drawWeather(w, h, maxy, car);

    ctx.fillStyle = vignette(w, h);
    ctx.fillRect(0, 0, w, h);

    renderHUD(view);
    ctx.restore();
  }

  function drawSky(w, h, horizon, view) {
    const sun = track.sun;
    const sunX = w * sun.x;
    const sunY = horizon - h * (0.5 - sun.y);

    const glowKey = `glow-${trackId}-${w}-${h}`;
    if (!cache[glowKey]) {
      const grd = ctx.createRadialGradient(sunX, sunY, 2, sunX, sunY, h * 0.34);
      grd.addColorStop(0, sun.color);
      grd.addColorStop(0.25, sun.glow);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      cache[glowKey] = { grd, sunX, sunY };
    }
    const glow = cache[glowKey];
    ctx.save();
    ctx.translate(0, sunY - glow.sunY);
    ctx.fillStyle = glow.grd;
    ctx.fillRect(0, glow.sunY - h * 0.34, w, h * 0.68);
    ctx.restore();

    backdrop.forEach((layer) => {
      const width = layer.canvas.width;
      const offset = ((view.car.bg * layer.factor) % width + width) % width;
      const y = horizon - layer.canvas.height + 2;
      ctx.drawImage(layer.canvas, -offset, y);
      ctx.drawImage(layer.canvas, -offset + width, y);
    });
  }

  function renderSegment(width, segment) {
    const p1 = segment.p1.screen;
    const p2 = segment.p2.screen;
    const color = segment.color;

    if (p1.w > 5) {
      const r1 = rumbleWidth(p1.w);
      const r2 = rumbleWidth(p2.w);
      polygon(p1.x - p1.w - r1, p1.y, p1.x - p1.w, p1.y, p2.x - p2.w, p2.y, p2.x - p2.w - r2, p2.y, color.rumble);
      polygon(p1.x + p1.w + r1, p1.y, p1.x + p1.w, p1.y, p2.x + p2.w, p2.y, p2.x + p2.w + r2, p2.y, color.rumble);
    }

    polygon(p1.x - p1.w, p1.y, p1.x + p1.w, p1.y, p2.x + p2.w, p2.y, p2.x - p2.w, p2.y, color.road);

    /* start / finish grid: alternating cells across the road, flipped each row */
    if (segment.checker) {
      if (p1.w < 4) return;
      const cells = 10;
      const row = (segment.index >> 1) & 1;
      const dark = color === track.colors.finish ? '#f8fafc' : '#111827';
      for (let j = 0; j < cells; j++) {
        if (((j + row) & 1) === 0) continue;
        const a1 = p1.x - p1.w + (2 * p1.w * j) / cells;
        const b1 = p1.x - p1.w + (2 * p1.w * (j + 1)) / cells;
        const a2 = p2.x - p2.w + (2 * p2.w * j) / cells;
        const b2 = p2.x - p2.w + (2 * p2.w * (j + 1)) / cells;
        polygon(a1, p1.y, b1, p1.y, b2, p2.y, a2, p2.y, dark);
      }
      return;
    }

    if (!color.lane || p1.w < 18) return;

    /* Crowned surface: the asphalt falls away toward each shoulder, so the
       edges sit slightly in shadow. Two thin wedges read as a curved surface. */
    const shade1 = p1.w * 0.3;
    const shade2 = p2.w * 0.3;
    ctx.globalAlpha = 0.16;
    polygon(p1.x - p1.w, p1.y, p1.x - p1.w + shade1, p1.y, p2.x - p2.w + shade2, p2.y, p2.x - p2.w, p2.y, '#000000');
    polygon(p1.x + p1.w - shade1, p1.y, p1.x + p1.w, p1.y, p2.x + p2.w, p2.y, p2.x + p2.w - shade2, p2.y, '#000000');
    ctx.globalAlpha = 1;

    if (p1.w < 34) return;

    /* solid edge lines */
    const e1 = Math.max(1, p1.w * 0.022);
    const e2 = Math.max(0.6, p2.w * 0.022);
    const inset1 = p1.w * 0.94;
    const inset2 = p2.w * 0.94;
    polygon(p1.x - inset1 - e1, p1.y, p1.x - inset1 + e1, p1.y, p2.x - inset2 + e2, p2.y, p2.x - inset2 - e2, p2.y, color.lane);
    polygon(p1.x + inset1 - e1, p1.y, p1.x + inset1 + e1, p1.y, p2.x + inset2 + e2, p2.y, p2.x + inset2 - e2, p2.y, color.lane);

    /* skid marks left on the racing line through corners */
    if (segment.skid) {
      ctx.globalAlpha = 0.22;
      const s1 = p1.w * 0.1;
      const s2 = p2.w * 0.1;
      const off1 = p1.w * segment.skid;
      const off2 = p2.w * segment.skid;
      polygon(p1.x + off1 - s1, p1.y, p1.x + off1 + s1, p1.y, p2.x + off2 + s2, p2.y, p2.x + off2 - s2, p2.y, '#000000');
      ctx.globalAlpha = 1;
    }

    /* dashed lane dividers */
    if (p1.w > 42 && (segment.index >> 1) % 2 === 0) {
      const l1 = laneWidth(p1.w);
      const l2 = laneWidth(p2.w);
      const lw1 = (p1.w * 2) / LANES;
      const lw2 = (p2.w * 2) / LANES;
      let lx1 = p1.x - p1.w + lw1;
      let lx2 = p2.x - p2.w + lw2;
      for (let lane = 1; lane < LANES; lane++) {
        polygon(lx1 - l1, p1.y, lx1 + l1, p1.y, lx2 + l2, p2.y, lx2 - l2, p2.y, color.lane);
        lx1 += lw1;
        lx2 += lw2;
      }
    }
  }

  function drawDust(x, y, size, color) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.45;
    for (let i = 0; i < 6; i++) {
      const t = clockNow * 0.01 + i;
      const dx = Math.sin(t) * size * 0.6;
      const dy = -((t * 13) % 40);
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, size * 0.1 + (i % 3) * 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* Twin light cones thrown up the road ahead. */
  function drawHeadlights(w, h, horizon) {
    const reach = Math.max(horizon, h * 0.35);
    ctx.globalCompositeOperation = 'lighter';
    [-1, 1].forEach((side) => {
      const grd = ctx.createLinearGradient(0, h, 0, reach);
      grd.addColorStop(0, 'rgba(255, 244, 214, 0.3)');
      grd.addColorStop(1, 'rgba(255, 244, 214, 0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(w / 2 + side * w * 0.04, h);
      ctx.lineTo(w / 2 + side * w * 0.1, h);
      ctx.lineTo(w / 2 + side * w * 0.2, reach);
      ctx.lineTo(w / 2 + side * w * 0.01, reach);
      ctx.closePath();
      ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawSmoke(car, x, y, size) {
    if (!car.smoke.length) return;
    for (let i = 0; i < car.smoke.length; i++) {
      const puff = car.smoke[i];
      ctx.globalAlpha = puff.life * 0.35;
      ctx.fillStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.arc(x + puff.x * size, y + puff.y * 0.4, puff.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* Falling snow / blown dust, denser the faster you go. */
  function drawWeather(w, h, horizon, car) {
    if (!track.weather) return;
    const count = track.weather === 'snow' ? 70 : 46;
    const drift = clockNow * 0.001;
    const rush = 1 + (car.speed / car.maxSpeed) * 3;

    ctx.fillStyle = track.weather === 'snow' ? 'rgba(255,255,255,0.85)' : 'rgba(217,160,102,0.5)';
    for (let i = 0; i < count; i++) {
      const seed = i * 0.618;
      const x = ((seed * 7.3 + drift * (0.3 + (i % 5) * 0.2)) % 1) * w;
      const y = horizon + (((seed * 3.1 + drift * rush * (0.4 + (i % 7) * 0.12)) % 1) * (h - horizon));
      const size = track.weather === 'snow' ? 1 + (i % 3) : 1;
      ctx.fillRect(x, y, size, size * (track.weather === 'snow' ? 1 : 3));
    }
  }

  function drawSpeedLines(w, h) {
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2 + clockNow * 0.001;
      const radius = Math.min(w, h) * 0.44;
      const cx = w / 2;
      const cy = h * 0.55;
      ctx.moveTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius * 0.6);
      ctx.lineTo(cx + Math.cos(angle) * (radius + 46), cy + Math.sin(angle) * (radius + 46) * 0.6);
    }
    ctx.stroke();
  }

  /* ---------- HUD ---------- */

  const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];

  function panel(x, y, w, h) {
    ctx.fillStyle = 'rgba(6, 11, 24, 0.55)';
    roundedRect(x, y, w, h, 10);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function renderHUD(view) {
    const { w, h, car } = view;
    const compact = splitScreen;
    const pad = 12;
    const font = (weight, size) => `${weight} ${size}px Segoe UI, system-ui, sans-serif`;

    ctx.save();
    ctx.textBaseline = 'top';

    panel(pad, pad, compact ? 100 : 126, compact ? 44 : 56);
    ctx.fillStyle = '#fff';
    ctx.font = font(800, compact ? 22 : 30);
    ctx.fillText(ORDINALS[car.place - 1] || `${car.place}th`, pad + 10, pad + (compact ? 7 : 9));
    ctx.font = font(600, compact ? 10 : 12);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`of ${RACERS}`, pad + (compact ? 58 : 78), pad + (compact ? 18 : 26));

    panel(pad, pad + (compact ? 50 : 64), compact ? 100 : 126, compact ? 32 : 38);
    ctx.fillStyle = '#fff';
    ctx.font = font(700, compact ? 15 : 19);
    ctx.fillText(`LAP ${Math.min(car.lap, LAPS)}/${LAPS}`, pad + 10, pad + (compact ? 58 : 74));

    drawTacho(w, h, car, compact, pad);

    const barW = compact ? 122 : 156;
    const barX = pad;
    const barY = h - pad - 16;
    panel(barX, barY, barW, 15);
    const grd = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    grd.addColorStop(0, car.boosting ? '#f97316' : '#38bdf8');
    grd.addColorStop(1, car.boosting ? '#fbbf24' : '#a78bfa');
    ctx.fillStyle = grd;
    roundedRect(barX + 2, barY + 2, Math.max(0, (car.turbo / 100) * (barW - 4)), 11, 5);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = font(700, 9);
    ctx.fillText('TURBO  (SHIFT)', barX + 4, barY - 12);

    renderMinimap(view);

    if (!compact || view.index === 0) {
      ctx.fillStyle = fps > 50 ? '#4ade80' : fps > 30 ? '#facc15' : '#f87171';
      ctx.font = font(700, 11);
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(fps)} FPS · ${ZOOMS[zoomIndex].name} (C)`, w - pad, pad + (compact ? 82 : 118));
      ctx.textAlign = 'left';
    }

    if (raceState === 'countdown') {
      const n = Math.ceil(countdown - 1);
      ctx.textAlign = 'center';
      ctx.fillStyle = n > 0 ? '#fff' : '#4ade80';
      ctx.font = font(900, compact ? 56 : 84);
      ctx.fillText(n > 0 ? String(n) : 'GO!', w / 2, h * 0.28);
      ctx.textAlign = 'left';
    } else if (car.finished) {
      ctx.textAlign = 'center';
      panel(w / 2 - 110, h * 0.36, 220, 44);
      ctx.fillStyle = '#fde68a';
      ctx.font = font(800, compact ? 20 : 26);
      ctx.fillText(`FINISHED ${ORDINALS[car.place - 1]}`, w / 2, h * 0.375);
      ctx.textAlign = 'left';
    }

    ctx.restore();
  }

  /* Analogue rev counter with a redline arc, needle, gear and digital speed. */
  function drawTacho(w, h, car, compact, pad) {
    const radius = compact ? 34 : 48;
    const cx = w - pad - radius - 4;
    const cy = h - pad - radius - 4;
    const from = Math.PI * 0.75;
    const to = Math.PI * 2.25;
    const font = (weight, size) => `${weight} ${size}px Segoe UI, system-ui, sans-serif`;

    ctx.save();
    ctx.fillStyle = 'rgba(6, 11, 24, 0.62)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineCap = 'butt';
    ctx.lineWidth = compact ? 5 : 7;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, from, to);
    ctx.stroke();

    // redline
    ctx.strokeStyle = 'rgba(239,68,68,0.85)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, from + (to - from) * 0.82, to);
    ctx.stroke();

    // filled revs — flashes on the limiter
    const revs = clamp(car.rpm, 0, 1);
    const limiting = car.overRev && Math.sin(clockNow * 0.06) > 0;
    ctx.strokeStyle = limiting ? '#fca5a5'
      : revs > 0.82 ? '#f87171'
      : car.boosting ? '#60a5fa' : '#38bdf8';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, from, from + (to - from) * revs);
    ctx.stroke();

    // needle
    const angle = from + (to - from) * revs;
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * (radius - 6), cy + Math.sin(angle) * (radius - 6));
    ctx.stroke();

    // gear + speed
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = car.overRev ? '#f87171' : car.bogging ? '#fbbf24' : car.shiftTimer > 0 ? '#fbbf24' : '#fff';
    ctx.font = font(800, compact ? 20 : 26);
    ctx.fillText(String(car.gear + 1), cx, cy - (compact ? 6 : 8));

    ctx.fillStyle = car.manual ? '#4ade80' : '#64748b';
    ctx.font = font(800, compact ? 7 : 9);
    ctx.fillText(car.manual ? 'MANUAL' : 'AUTO', cx, cy - radius + (compact ? 9 : 12));
    ctx.fillStyle = car.boosting ? '#93c5fd' : '#e2e8f0';
    ctx.font = font(700, compact ? 13 : 17);
    ctx.fillText(Math.round(car.speed / 55), cx, cy + (compact ? 12 : 15));
    ctx.fillStyle = '#94a3b8';
    ctx.font = font(600, compact ? 7 : 9);
    ctx.fillText('km/h', cx, cy + (compact ? 24 : 30));

    if (car.draft > 0.35) {
      ctx.fillStyle = '#4ade80';
      ctx.font = font(800, compact ? 9 : 11);
      ctx.fillText('SLIPSTREAM', cx, cy - radius - 12);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.restore();
  }

  function renderMinimap(view) {
    const { w, car } = view;
    const size = splitScreen ? 74 : 104;
    const x = w - size - 12;
    const y = 12;

    ctx.save();
    panel(x, y, size, size);

    const inset = 10;
    const scale = size - inset * 2;
    const px = (point) => x + inset + point.x * scale;
    const py = (point) => y + inset + point.y * scale;

    ctx.strokeStyle = 'rgba(226,232,240,0.85)';
    ctx.lineWidth = splitScreen ? 2 : 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < minimap.length; i++) {
      const point = minimap[i];
      if (i === 0) ctx.moveTo(px(point), py(point));
      else ctx.lineTo(px(point), py(point));
    }
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.arc(px(minimap[0]), py(minimap[0]), 2.5, 0, Math.PI * 2);
    ctx.fill();

    racers.forEach((racer) => {
      const point = minimap[Math.floor(racer.z / SEG_LENGTH / 4) % minimap.length];
      if (!point) return;
      const isSelf = racer === car;
      ctx.fillStyle = racer.body;
      ctx.beginPath();
      ctx.arc(px(point), py(point), isSelf ? 4.2 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (isSelf) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    });

    ctx.restore();
  }

  /* ---------- Frame ---------- */

  function assignCarsToSegments() {
    for (let i = 0; i < seededSegments.length; i++) seededSegments[i].cars.length = 0;
    seededSegments.length = 0;
    for (let i = 0; i < racers.length; i++) {
      const segment = findSegment(racers[i].z);
      if (!segment.cars.length) seededSegments.push(segment);
      segment.cars.push(racers[i]);
    }
  }

  function update(dt) {
    if (raceState === 'countdown') {
      const before = Math.ceil(countdown - 1);
      countdown -= dt;
      const after = Math.ceil(countdown - 1);
      if (after !== before) Sound.blip(after > 0 ? 'beep' : 'go');
      if (countdown <= 1) {
        raceState = 'racing';
        raceTime = 0;
        racers.forEach((car) => { car.lapStart = 0; });
      }
    } else if (raceState === 'racing') {
      raceTime += dt;
    }

    for (let i = 0; i < players.length; i++) updatePlayer(players[i], i, dt);

    for (let i = 0; i < racers.length; i++) {
      const car = racers[i];
      if (car.local) continue;
      // guests take the AI cars from the host; everyone else simulates them
      const drivenHere = !car.human && (!online || netRole === 'host' || !netAlive);
      if (drivenHere) updateAI(car, dt);
    }

    collide(dt);

    for (let i = 0; i < racers.length; i++) {
      const car = racers[i];
      const fromNetwork = online && netAlive && !car.local
        && (car.human || netRole === 'guest');
      if (fromNetwork) updateRemote(car, dt);
      else advance(car, dt);
    }

    if (online) {
      sendTimer -= dt;
      if (sendTimer <= 0) {
        sendTimer = SEND_RATE;
        pushState();
      }
    }

    updatePlaces();
    assignCarsToSegments();

    const listener = players[0];
    Sound.drive(listener, readInput(0).up, raceState === 'racing' && !listener.finished);
  }

  function render() {
    frameId += 1;

    const views = splitScreen
      ? [
          { index: 0, x: 0, y: 0, w: W, h: H / 2 - 2, car: players[0] },
          { index: 1, x: 0, y: H / 2 + 2, w: W, h: H / 2 - 2, car: players[1] },
        ]
      : [{ index: 0, x: 0, y: 0, w: W, h: H, car: players[0] }];

    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      view.camera = { x: view.car.x, z: view.car.z };
      renderView(view);
    }

    if (splitScreen) {
      ctx.fillStyle = '#070b16';
      ctx.fillRect(0, H / 2 - 2, W, 4);
    }
  }

  /* Nudge the draw distance to keep the frame time near the display refresh.
     Only every 15th frame, so the far edge of the scenery does not shimmer. */
  let qualityTick = 0;
  function adaptQuality(frameMs) {
    if (++qualityTick < 15) return;
    qualityTick = 0;
    if (frameMs > 21 && drawDistance > QUALITY.min) drawDistance -= 12;
    else if (frameMs < 13 && drawDistance < QUALITY.max) drawDistance += 6;
  }

  function frame(now) {
    const raw = now - lastFrame;
    const dt = Math.min(0.05, raw / 1000 || 0.016);
    lastFrame = now;
    clockNow = now;
    fps = fps * 0.9 + (1000 / Math.max(1, raw)) * 0.1;
    adaptQuality(raw);

    update(dt);
    render();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* ---------- Race lifecycle ---------- */

  const statusEl = document.getElementById('race-status');
  const resultsEl = document.getElementById('race-results');
  const resultsBody = document.getElementById('race-results-body');
  const resultsTitle = document.getElementById('race-results-title');
  const tagEl = document.getElementById('race-tag');

  const statsKey = () => `race-${trackId}`;

  function updateHUD() {
    const record = Stats.get(statsKey());
    HUD.set({
      leftIcon: '🏁',
      left: record.wins || 0,
      leftLabel: `wins · ${track.name.split(' ')[0].toLowerCase()}`,
      rightIcon: '⏱️',
      right: record.best === null ? '--:--' : formatTime(record.best),
      rightLabel: 'best lap',
    });
  }

  function endRace() {
    raceState = 'finished';
    Sound.silence();
    const order = updatePlaces();
    const winner = order[0];

    resultsTitle.textContent = splitScreen
      ? `${winner.name} wins!`
      : (winner.human ? '🏆 You win!' : `${winner.name} wins`);

    resultsBody.innerHTML = order.map((car) => `
      <tr class="${car.human ? 'is-you' : ''}">
        <td>${ORDINALS[car.place - 1]}</td>
        <td><span class="race-chip" style="background:${car.body}"></span>${car.name}</td>
        <td>${car.bestLap === null ? '—' : formatTime(car.bestLap * 1000)}</td>
      </tr>`).join('');

    resultsEl.hidden = false;

    players.forEach((car) => {
      if (car.bestLap !== null && Stats.recordMin(statsKey(), 'best', car.bestLap * 1000)) {
        HUD.pop(HUD.bestBadge);
      }
    });
    if (winner.human) {
      Stats.bump(statsKey(), 'wins');
      HUD.pop(HUD.winsBadge);
    }
    updateHUD();
    statusEl.textContent = 'Race over — hit Restart for another go';
  }

  function controlHint() {
    const common = `1-6 gears · Q/E shift · G auto · C camera · M sound ${Sound.on ? 'on' : 'off'}`;
    return splitScreen
      ? `P1: W A S D + Shift · P2: arrows + Right Shift (gears ,/. or numpad 1-6) · ${common}`
      : `W A S D or arrows · Shift/Space turbo · ${common}`;
  }

  function startRace() {
    Sound.init();
    Sound.resume();
    resultsEl.hidden = true;
    raceState = 'countdown';
    countdown = 3.999;
    sendTimer = 0;
    // the host owns the clock; the guest waits to be told when to go
    if (online && netRole === 'host') Net.send({ t: 'start' });
    raceTime = 0;
    drawDistance = splitScreen ? 200 : 280;
    createRacers();
    assignCarsToSegments();
    statusEl.textContent = controlHint();
    lastFrame = performance.now();
    stop();
    rafId = requestAnimationFrame(frame);
  }

  function chooseTrack(id) {
    trackId = id;
    track = TRACKS[id];
    Object.keys(cache).forEach((key) => delete cache[key]);
    document.getElementById('race-car-sub').textContent = splitScreen
      ? `${track.name} · P1 picks; P2 and the rivals take the next cars`
      : `${track.name} · each car handles differently`;
    Screens.show('race-car-screen');
  }

  function startGame() {
    buildTrack(track);
    const mode = online ? `online (${netRole})` : splitScreen ? '2 players' : `vs AI (${difficulty})`;
    tagEl.textContent = `${track.name} · ${CARS[chosenCar].name} · ${mode} · ${LAPS} laps`;
    updateHUD();
    Screens.show('race-game-screen');
    startRace();
  }

  /* ---------- Garage ---------- */

  function buildGarage() {
    const list = document.getElementById('race-cars');
    list.textContent = '';

    CARS.forEach((definition, index) => {
      const card = document.createElement('button');
      card.className = 'car-card';
      card.type = 'button';
      card.innerHTML = `
        <canvas class="car-card__art" width="200" height="110"></canvas>
        <span class="car-card__name">${definition.name}</span>
        <span class="car-card__blurb">${definition.blurb}</span>
        <span class="car-stats">
          ${statRow('Speed', definition.speed, 0.9, 1.15)}
          ${statRow('Accel', definition.accel, 0.85, 1.2)}
          ${statRow('Grip', definition.grip, 0.78, 1.3)}
          ${statRow('Turbo', definition.tank, 0.88, 1.5)}
        </span>`;

      card.addEventListener('click', () => {
        chosenCar = index;
        if (online) openLobby();
        else startGame();
      });

      list.appendChild(card);
      drawPreview(card.querySelector('.car-card__art'), definition);
    });
  }

  function statRow(label, value, min, max) {
    const percent = Math.round(((value - min) / (max - min)) * 100);
    return `<span class="car-stat">
        <span class="car-stat__label">${label}</span>
        <span class="car-stat__bar"><i style="width:${clamp(percent, 6, 100)}%"></i></span>
      </span>`;
  }

  function drawPreview(surface, definition) {
    const g = surface.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, surface.height);
    grd.addColorStop(0, '#1e293b');
    grd.addColorStop(1, '#0b1120');
    g.fillStyle = grd;
    g.fillRect(0, 0, surface.width, surface.height);

    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.beginPath();
    g.ellipse(surface.width / 2, surface.height - 14, 62, 10, 0, 0, Math.PI * 2);
    g.stroke();

    drawCar(g, surface.width / 2, surface.height - 12, 104, {
      body: definition.body,
      trim: definition.trim,
      accent: definition.accentColor,
      shape: definition.shape,
      profile: definition.profile || 'gt',
      braking: false,
      boosting: false,
    }, 0, true);
  }

  /* ---------- Online lobby ---------- */

  const netEls = {
    roles: document.getElementById('net-roles'),
    hostPanel: document.getElementById('net-host-panel'),
    joinPanel: document.getElementById('net-join-panel'),
    offer: document.getElementById('net-offer'),
    answerIn: document.getElementById('net-answer-in'),
    offerIn: document.getElementById('net-offer-in'),
    answer: document.getElementById('net-answer'),
    status: document.getElementById('net-status'),
  };

  function netSay(text, kind = '') {
    netEls.status.textContent = text;
    netEls.status.className = `net-status ${kind}`;
  }

  function openLobby() {
    netEls.roles.hidden = false;
    netEls.hostPanel.hidden = true;
    netEls.joinPanel.hidden = true;
    netEls.offer.value = '';
    netEls.answer.value = '';
    netEls.answerIn.value = '';
    netEls.offerIn.value = '';
    netSay('');
    Screens.show('race-net-screen');
  }

  /* navigator.clipboard needs a secure context; fall back for plain http/file */
  function copyField(field) {
    field.select();
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(field.value).then(() => netSay('Copied — send it over.', 'ok'));
      return;
    }
    try {
      document.execCommand('copy');
      netSay('Copied — send it over.', 'ok');
    } catch {
      netSay('Select the text and copy it manually.');
    }
  }

  Net.on('open', () => {
    netAlive = true;
    netSay('Connected! Starting the race…', 'ok');
    setTimeout(() => startGame(), 600);
  }).on('close', () => {
    netAlive = false;
    if (Screens.isActive('race-game-screen')) {
      statusEl.textContent = 'Connection lost — the other car is on autopilot';
    } else {
      netSay('Connection closed.', 'bad');
    }
  }).on('message', onNetMessage);

  document.getElementById('net-host').addEventListener('click', async () => {
    netRole = 'host';
    netEls.roles.hidden = true;
    netEls.hostPanel.hidden = false;
    netSay('Building your invite…');
    try {
      netEls.offer.value = await Net.createInvite({ track: trackId, car: chosenCar, laps: LAPS });
      netSay('Send the invite, then paste their reply below.');
    } catch (error) {
      netSay(`Could not start hosting: ${error.message}`, 'bad');
    }
  });

  document.getElementById('net-join').addEventListener('click', () => {
    netRole = 'guest';
    netEls.roles.hidden = true;
    netEls.joinPanel.hidden = false;
    netSay('Paste the invite code you were sent.');
  });

  document.getElementById('net-copy-offer').addEventListener('click', () => copyField(netEls.offer));
  document.getElementById('net-copy-answer').addEventListener('click', () => copyField(netEls.answer));

  document.getElementById('net-accept').addEventListener('click', async () => {
    try {
      netSay('Connecting…');
      await Net.acceptReply(netEls.answerIn.value);
    } catch (error) {
      netSay(`Reply rejected: ${error.message}`, 'bad');
    }
  });

  document.getElementById('net-generate').addEventListener('click', async () => {
    try {
      netSay('Reading the invite…');
      const result = await Net.joinWithInvite(netEls.offerIn.value, { car: chosenCar });
      // the host decides the track
      trackId = result.invite.track || trackId;
      track = TRACKS[trackId];
      Object.keys(cache).forEach((key) => delete cache[key]);
      netEls.answer.value = result.code;
      netSay(`Track: ${track.name}. Send the reply back and wait.`);
    } catch (error) {
      netSay(`Invite rejected: ${error.message}`, 'bad');
    }
  });

  /* ---------- Wiring ---------- */

  document.getElementById('pick-race').addEventListener('click', () => Screens.show('race-mode-screen'));

  document.getElementById('race-mode-solo').addEventListener('click', () => {
    splitScreen = false;
    online = false;
    difficulty = document.querySelector('input[name="race-difficulty"]:checked').value;
    Screens.show('race-track-screen');
  });

  document.getElementById('race-mode-split').addEventListener('click', () => {
    splitScreen = true;
    online = false;
    difficulty = document.querySelector('input[name="race-difficulty"]:checked').value;
    Screens.show('race-track-screen');
  });

  document.getElementById('race-mode-online').addEventListener('click', () => {
    splitScreen = false;
    online = true;
    difficulty = document.querySelector('input[name="race-difficulty"]:checked').value;
    Screens.show('race-track-screen');
  });

  document.querySelectorAll('#race-track-screen .track-card').forEach((card) => {
    card.addEventListener('click', () => chooseTrack(card.dataset.track));
  });

  buildGarage();

  document.getElementById('race-restart').addEventListener('click', startRace);
  document.getElementById('race-again').addEventListener('click', startRace);

  /* One-shot actions, shared by the keyboard and the on-screen buttons. */
  function pressKey(code) {
    if (code === 'KeyC') {
      zoomIndex = (zoomIndex + 1) % ZOOMS.length;
      statusEl.textContent = `Camera: ${ZOOMS[zoomIndex].name} · ${controlHint()}`;
      return true;
    }
    if (code === 'KeyM') {
      Sound.on = !Sound.on;
      if (!Sound.on) Sound.silence();
      statusEl.textContent = controlHint();
      return true;
    }
    if (code === 'KeyG') {
      players.forEach((player) => { player.manual = !player.manual; });
      statusEl.textContent = `Gearbox: ${players[0].manual ? 'MANUAL' : 'AUTO'} · ${controlHint()}`;
      return true;
    }
    return handleGearKey(code);
  }

  document.addEventListener('keydown', (event) => {
    if (!Screens.isActive('race-game-screen')) return;
    keys[event.code] = true;
    if (pressKey(event.code)) event.preventDefault();
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) event.preventDefault();
  });

  document.addEventListener('keyup', (event) => { keys[event.code] = false; });

  /* ---------- Touch controls ----------
     The buttons write into the same `keys` map the keyboard uses, so the
     physics never needs to know how the car is being driven. Pointer capture
     keeps a button held even if the thumb slides off it, and each button owns
     its own pointer, so steering + throttle + turbo work together. */

  const touchPad = document.getElementById('race-touch');

  function bindHold(button, code) {
    const press = (event) => {
      event.preventDefault();
      if (button.setPointerCapture) {
        try { button.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
      }
      button.classList.add('held');
      keys[code] = true;
      Sound.resume();
    };
    const release = () => {
      button.classList.remove('held');
      keys[code] = false;
    };
    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /* Holding a labelled button used to raise the browser's own
     select/copy popup over the controls. Kill selection on the whole pad. */
  ['selectstart', 'contextmenu', 'dragstart'].forEach((event) => {
    touchPad.addEventListener(event, (e) => e.preventDefault());
    canvas.addEventListener(event, (e) => e.preventDefault());
  });

  touchPad.querySelectorAll('[data-hold]').forEach((button) => bindHold(button, button.dataset.hold));

  touchPad.querySelectorAll('[data-tap]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.classList.add('held');
      Sound.resume();
      pressKey(button.dataset.tap);
    });
    const clear = () => button.classList.remove('held');
    button.addEventListener('pointerup', clear);
    button.addEventListener('pointercancel', clear);
  });

  /* ---------- Fullscreen ---------- */

  const gameScreen = document.getElementById('race-game-screen');
  const fullscreenBtn = document.getElementById('race-fullscreen');

  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;

  /* Render at a higher backing resolution when the canvas is filling a screen,
     otherwise a 960x600 buffer stretched to 1080p looks soft. Cached gradients
     are keyed on view height, so they have to go when the size changes. */
  function setResolution(width, height) {
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    W = width;
    H = height;
    Object.keys(cache).forEach((key) => delete cache[key]);
  }

  function toggleFullscreen() {
    if (fullscreenElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
      return;
    }
    const request = gameScreen.requestFullscreen || gameScreen.webkitRequestFullscreen;
    if (!request) return;
    const result = request.call(gameScreen);
    if (result && result.catch) result.catch(() => { /* denied by the browser */ });
    // phones race far better sideways; the lock is advisory and often refused
    if (screen.orientation && screen.orientation.lock) {
      try { screen.orientation.lock('landscape').catch(() => {}); } catch { /* unsupported */ }
    }
  }

  function onFullscreenChange() {
    const active = Boolean(fullscreenElement());
    fullscreenBtn.classList.toggle('on', active);
    fullscreenBtn.textContent = active ? '⤢' : '⛶';
    setResolution(active ? 1280 : 960, active ? 800 : 600);
    if (!active && screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch { /* unsupported */ }
    }
  }

  fullscreenBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  function setTouchControls(visible) {
    touchPad.hidden = !visible;
    document.getElementById('race-touch-toggle').classList.toggle('on', visible);
    if (!visible) {
      // never leave a control stuck down
      ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'ShiftLeft'].forEach((code) => { keys[code] = false; });
      touchPad.querySelectorAll('.touch-btn').forEach((button) => button.classList.remove('held'));
    }
  }

  const touchDevice = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  setTouchControls(touchDevice);

  document.getElementById('race-touch-toggle').addEventListener('click', () => {
    setTouchControls(touchPad.hidden);
  });

  document.addEventListener('screen-left', () => {
    stop();
    Sound.silence();
    Object.keys(keys).forEach((code) => { keys[code] = false; });
    if (netAlive) {
      Net.send({ t: 'bye' });
      Net.reset();
      netAlive = false;
    }
  });
})();
