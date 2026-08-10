'use strict';

/* ============================================================
   おばけをポン！  ゲームロジック
   ============================================================ */

/* ===== ていすう ===== */
const GHOST_IMAGE = 'images/ghost-normal.png';

const GAME_DURATION_MS = 30000;   // 1プレイ 30びょう
const TICK_MS = 100;              // のこりじかんの ひょうじを ぬりかえる かんかく

// おばけの みため のおおきさ（px）。プレイエリアのはばに あわせて この はんいで きまる
const GHOST_SIZE_MIN = 100;
const GHOST_SIZE_MAX = 156;
const GHOST_SIZE_RATIO = 0.34;

const GHOST_HIT_PAD = 16;         // みための そとがわに つける タップのよゆう（px）
const EDGE_MARGIN = 10;           // プレイエリアの ふちから あける よはく（px）
const MIN_MOVE_RATIO = 0.35;      // まえのいちから さいてい これだけ はなす（たんぺんの ひりつ）
const SPAWN_RETRY = 12;           // いちの ひきなおし かいすう

const RESPAWN_DELAY_MS = 260;     // ポン！のあと つぎが でるまで
const POP_EFFECT_MS = 500;        // ポン！えんしゅつの ながさ（あとしまつの タイミング）
const POP_STAR_COUNT = 8;
const POP_STARS = ['⭐', '✨', '💫', '🌟'];
const SCORE_BUMP_MS = 140;
const HURRY_SEC = 5;              // のこり なんびょうで タイマーを めだたせるか

// けっか画面の ほめことば（0てんでも まえむきに）
const PRAISE_STEPS = [
  { min: 20, text: 'てんさい！' },
  { min: 12, text: 'すごい！' },
  { min: 6,  text: 'じょうず！' },
  { min: 1,  text: 'やったね！' },
  { min: 0,  text: 'よくがんばったね！' },
];
const RESULT_STAR_STEP = 5;       // なんひきで ほしが 1つ ふえるか
const RESULT_STAR_MAX = 5;

// おと（ファイルを おいたら ここに パスを かく。null のあいだは ブラウザで つくった おとが なる）
const SOUND_FILES = {
  start: null,   // れい: 'sounds/start.mp3'
  pon: null,     // れい: 'sounds/pon.mp3'
  finish: null,  // れい: 'sounds/finish.mp3'
};

const STATE = { TITLE: 'TITLE', PLAYING: 'PLAYING', RESULT: 'RESULT' };

/* ===== DOM ===== */
const titleScreen = document.getElementById('title-screen');
const gameScreen = document.getElementById('game-screen');
const resultScreen = document.getElementById('result-screen');
const playfield = document.getElementById('playfield');
const scoreEl = document.getElementById('score');
const scoreBox = document.getElementById('score-box');
const timeLeftEl = document.getElementById('time-left');
const timerBox = document.getElementById('timer-box');
const startButton = document.getElementById('start-button');
const replayButton = document.getElementById('replay-button');
const resultPraise = document.getElementById('result-praise');
const resultScore = document.getElementById('result-score');
const resultStars = document.getElementById('result-stars');

/* ===== じょうたい ===== */
const game = {
  phase: STATE.TITLE,
  score: 0,
  endAt: 0,          // ゲームが おわる じこく（performance.now ベース）
  tickId: null,      // のこりじかんの こうしん
  respawnId: null,   // つぎの おばけを だす タイマー
  ghostEl: null,
  ghostAlive: false,
  lastPos: null,
  popTimers: new Set(),
};

/* ============================================================
   おと（ファイルが なければ WebAudio で つくる）
   ============================================================ */
const sound = (() => {
  let ctx = null;
  const buffers = {};   // ファイルを つかう ばあいの <audio>

  // ユーザーの そうさの なかで よぶこと（じどうさいせい ブロックを さける）
  function unlock() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { ctx = new AC(); } catch (_) { ctx = null; }
  }

  function tone({ freq, toFreq, start = 0, dur = 0.18, type = 'sine', gain = 0.22 }) {
    if (!ctx) return;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (toFreq) osc.frequency.exponentialRampToValueAtTime(toFreq, t0 + dur * 0.8);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  const synth = {
    pon() {
      tone({ freq: 620, toFreq: 1500, dur: 0.16, type: 'sine', gain: 0.28 });
      tone({ freq: 1240, toFreq: 2400, dur: 0.10, type: 'triangle', gain: 0.10 });
    },
    start() {
      [523.25, 659.25, 783.99].forEach((f, i) =>
        tone({ freq: f, start: i * 0.09, dur: 0.16, type: 'triangle', gain: 0.2 }));
    },
    finish() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone({ freq: f, start: i * 0.12, dur: 0.28, type: 'triangle', gain: 0.22 }));
    },
  };

  function play(name) {
    const src = SOUND_FILES[name];
    if (src) {
      let el = buffers[name];
      if (!el) { el = buffers[name] = new Audio(src); }
      el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});   // さいせいできなくても ゲームは とめない
      return;
    }
    unlock();
    if (ctx && synth[name]) synth[name]();
  }

  return { play, unlock, isReady: () => !!ctx && ctx.state === 'running' };
})();

/* ============================================================
   おばけ
   ============================================================ */

function currentGhostSize() {
  const w = playfield.clientWidth;
  return Math.round(Math.min(GHOST_SIZE_MAX, Math.max(GHOST_SIZE_MIN, w * GHOST_SIZE_RATIO)));
}

// プレイエリアの なかの ランダムないち（がめんがいに でない・まえと おなじばしょに でない）
function pickPosition(size) {
  const w = playfield.clientWidth;
  const h = playfield.clientHeight;
  const half = size / 2 + GHOST_HIT_PAD;
  const minX = half + EDGE_MARGIN;
  const maxX = Math.max(minX, w - half - EDGE_MARGIN);
  const minY = half + EDGE_MARGIN;
  const maxY = Math.max(minY, h - half - EDGE_MARGIN);
  const minDist = Math.min(w, h) * MIN_MOVE_RATIO;

  let pos = null;
  for (let i = 0; i < SPAWN_RETRY; i++) {
    pos = {
      x: minX + Math.random() * (maxX - minX),
      y: minY + Math.random() * (maxY - minY),
    };
    if (!game.lastPos) break;
    if (Math.hypot(pos.x - game.lastPos.x, pos.y - game.lastPos.y) >= minDist) break;
  }
  game.lastPos = pos;
  return pos;
}

function spawnGhost() {
  removeGhost();
  if (game.phase !== STATE.PLAYING) return;

  const size = currentGhostSize();
  const pos = pickPosition(size);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.setAttribute('aria-label', 'おばけ');
  btn.style.setProperty('--size', size + 'px');
  btn.style.setProperty('--pad', GHOST_HIT_PAD + 'px');
  btn.style.left = pos.x + 'px';
  btn.style.top = pos.y + 'px';

  const img = document.createElement('img');
  img.src = GHOST_IMAGE;
  img.alt = '';
  btn.appendChild(img);

  btn.addEventListener('pointerdown', onGhostHit);
  btn.addEventListener('click', onGhostHit);   // キーボード（Enter/Space）ようの ほけん

  playfield.appendChild(btn);
  game.ghostEl = btn;
  game.ghostAlive = true;
}

function removeGhost() {
  if (game.ghostEl) {
    game.ghostEl.remove();
    game.ghostEl = null;
  }
  game.ghostAlive = false;
}

/* ===== タップ ===== */
function onGhostHit(e) {
  if (e) e.preventDefault();
  // PLAYING いがい／すでに ポンされた おばけ は かぞえない（れんだ・にじゅうタップ よけ）
  if (game.phase !== STATE.PLAYING || !game.ghostAlive) return;
  game.ghostAlive = false;

  const el = game.ghostEl;
  const x = parseFloat(el.style.left);
  const y = parseFloat(el.style.top);
  const size = parseFloat(el.style.getPropertyValue('--size'));

  addScore(1);
  sound.play('pon');
  showPop(x, y, size);

  // おばけは えんしゅつのあいだ のこして、さいごに かたづける
  el.classList.add('is-popped');
  game.ghostEl = null;
  const cleanup = setTimeout(() => {
    el.remove();
    game.popTimers.delete(cleanup);
  }, POP_EFFECT_MS);
  game.popTimers.add(cleanup);

  clearTimeout(game.respawnId);
  game.respawnId = setTimeout(spawnGhost, RESPAWN_DELAY_MS);
}

/* ===== ポン！えんしゅつ ===== */
function showPop(x, y, size) {
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  pop.style.setProperty('--pop-size', Math.round(size * 1.6) + 'px');
  pop.style.setProperty('--text-size', Math.round(size * 0.42) + 'px');

  const flash = document.createElement('div');
  flash.className = 'pop-flash';
  pop.appendChild(flash);

  const ring = document.createElement('div');
  ring.className = 'pop-ring';
  pop.appendChild(ring);

  for (let i = 0; i < POP_STAR_COUNT; i++) {
    const star = document.createElement('span');
    star.className = 'pop-star';
    star.textContent = POP_STARS[i % POP_STARS.length];
    const angle = (Math.PI * 2 * i) / POP_STAR_COUNT + Math.random() * 0.4;
    const dist = size * (0.55 + Math.random() * 0.45);
    star.style.setProperty('--dx', Math.round(Math.cos(angle) * dist) + 'px');
    star.style.setProperty('--dy', Math.round(Math.sin(angle) * dist) + 'px');
    star.style.setProperty('--star-size', Math.round(size * (0.16 + Math.random() * 0.1)) + 'px');
    pop.appendChild(star);
  }

  const text = document.createElement('span');
  text.className = 'pop-text';
  text.textContent = 'ポン！';
  pop.appendChild(text);

  playfield.appendChild(pop);
  const t = setTimeout(() => {
    pop.remove();
    game.popTimers.delete(t);
  }, POP_EFFECT_MS);
  game.popTimers.add(t);
}

function clearPopEffects() {
  game.popTimers.forEach(clearTimeout);
  game.popTimers.clear();
  playfield.querySelectorAll('.pop, .ghost').forEach(el => el.remove());
}

/* ===== スコア ===== */
function addScore(n) {
  game.score += n;
  scoreEl.textContent = game.score;
  scoreBox.classList.add('is-bump');
  setTimeout(() => scoreBox.classList.remove('is-bump'), SCORE_BUMP_MS);
}

/* ============================================================
   じかん
   ============================================================ */

// setInterval に たよらず、いまの じこく から のこりを けいさんする
function remainingMs() {
  return Math.max(0, game.endAt - performance.now());
}

function renderTime() {
  const sec = Math.ceil(remainingMs() / 1000);
  if (timeLeftEl.textContent !== String(sec)) timeLeftEl.textContent = sec;
  timerBox.classList.toggle('is-hurry', sec <= HURRY_SEC);
}

function tick() {
  renderTime();
  if (remainingMs() <= 0) endGame();
}

function stopTimers() {
  clearInterval(game.tickId);
  clearTimeout(game.respawnId);
  game.tickId = null;
  game.respawnId = null;
}

/* ============================================================
   ゲームの ながれ
   ============================================================ */

function showScreen(phase) {
  game.phase = phase;
  titleScreen.classList.toggle('is-hidden', phase !== STATE.TITLE);
  gameScreen.classList.toggle('is-hidden', phase === STATE.TITLE);
  resultScreen.classList.toggle('is-hidden', phase !== STATE.RESULT);
}

function startGame() {
  stopTimers();          // にじゅう タイマーを つくらない
  clearPopEffects();     // まえの プレイの のこりを けす

  game.score = 0;
  game.lastPos = null;
  scoreEl.textContent = '0';
  scoreBox.classList.remove('is-bump');

  game.endAt = performance.now() + GAME_DURATION_MS;
  showScreen(STATE.PLAYING);
  renderTime();

  sound.play('start');
  spawnGhost();
  game.tickId = setInterval(tick, TICK_MS);
}

function endGame() {
  stopTimers();
  removeGhost();          // あたらしい おばけを だすのを やめる／タップを うけつけない
  timeLeftEl.textContent = '0';
  timerBox.classList.remove('is-hurry');

  showResult(game.score);
  showScreen(STATE.RESULT);
  sound.play('finish');
}

function praiseFor(score) {
  return (PRAISE_STEPS.find(s => score >= s.min) || PRAISE_STEPS[PRAISE_STEPS.length - 1]).text;
}

function showResult(score) {
  resultPraise.textContent = praiseFor(score);
  resultScore.textContent = score;
  const stars = Math.min(RESULT_STAR_MAX, Math.max(1, Math.ceil(score / RESULT_STAR_STEP)));
  resultStars.textContent = '⭐'.repeat(stars);
}

/* ===== がめんサイズが かわったとき（おばけを なかに おさめる） ===== */
function handleResize() {
  if (!game.ghostEl || !game.lastPos) return;
  const size = currentGhostSize();
  const half = size / 2 + GHOST_HIT_PAD + EDGE_MARGIN;
  const maxX = Math.max(half, playfield.clientWidth - half);
  const maxY = Math.max(half, playfield.clientHeight - half);
  const x = Math.min(Math.max(game.lastPos.x, half), maxX);
  const y = Math.min(Math.max(game.lastPos.y, half), maxY);
  game.lastPos = { x, y };
  game.ghostEl.style.setProperty('--size', size + 'px');
  game.ghostEl.style.left = x + 'px';
  game.ghostEl.style.top = y + 'px';
}

/* ===== イベント（1かいだけ とうろく） ===== */
startButton.addEventListener('click', () => { sound.unlock(); startGame(); });
replayButton.addEventListener('click', () => { sound.unlock(); startGame(); });
window.addEventListener('resize', handleResize);

// タブを はなれているあいだの ずれを もどす
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && game.phase === STATE.PLAYING) tick();
});

showScreen(STATE.TITLE);

/* ===== けんしょう用のフック（work/verify.js から つかう） ===== */
window.__game = {
  game, STATE, sound,
  spawn: spawnGhost,
  hit: () => onGhostHit(null),
  setRemaining: ms => { game.endAt = performance.now() + ms; },
  tick,
};
