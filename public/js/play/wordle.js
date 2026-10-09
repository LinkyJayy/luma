// StarWordle: guess the five-letter word in six tries.

import { el, rng } from './common.js';
import { ANSWERS, GUESSES } from './words.js';

const ROWS = 6;
const LEN = 5;
const EPOCH = new Date(2026, 0, 1);
const STORE = 'luma-wordle';

// Everyone gets the same word each day, in an order fixed by a seed.
const dailyOrder = (() => {
  const r = rng(20260101);
  const a = ANSWERS.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
})();

function todayIndex() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - EPOCH) / 864e5);
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    return {};
  }
}
function save(data) {
  try {
    localStorage.setItem(STORE, JSON.stringify(data));
  } catch {
    /* private mode: progress just isn't kept */
  }
}

// Marks each letter: 'hit' (right spot), 'near' (elsewhere), 'miss'. Handles repeats.
export function score(guess, answer) {
  const out = Array(LEN).fill('miss');
  const left = {};
  for (let i = 0; i < LEN; i++) {
    if (guess[i] === answer[i]) out[i] = 'hit';
    else left[answer[i]] = (left[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < LEN; i++) {
    if (out[i] !== 'hit' && left[guess[i]]) {
      out[i] = 'near';
      left[guess[i]] -= 1;
    }
  }
  return out;
}

export function play({ stage, setInfo }) {
  let mode = 'daily';
  let answer;
  let guesses = [];
  let current = '';
  let done = false;
  let busy = false;

  const root = el('div', { class: 'wordle' });
  const tabs = el('div', { class: 'segmented wordle-tabs' });
  const board = el('div', { class: 'wordle-board' });
  const message = el('div', { class: 'wordle-msg', role: 'status', 'aria-live': 'polite' });
  const keyboard = el('div', { class: 'wordle-keys' });
  root.append(tabs, board, message, keyboard);
  stage.append(root);

  const tiles = [];
  for (let r = 0; r < ROWS; r++) {
    const row = el('div', { class: 'wordle-row' });
    tiles.push([]);
    for (let c = 0; c < LEN; c++) {
      const t = el('div', { class: 'tile' });
      tiles[r].push(t);
      row.append(t);
    }
    board.append(row);
  }

  const keyEls = {};
  for (const line of ['qwertyuiop', 'asdfghjkl', '+zxcvbnm-']) {
    const row = el('div', { class: 'key-row' });
    for (const ch of line) {
      const label = ch === '+' ? 'Enter' : ch === '-' ? '⌫' : ch;
      const k = el('button', { class: `key ${ch === '+' || ch === '-' ? 'wide' : ''}`, 'aria-label': ch === '-' ? 'Delete' : label, onclick: () => press(ch === '+' ? 'Enter' : ch === '-' ? 'Backspace' : ch) }, label);
      if (/[a-z]/.test(ch)) keyEls[ch] = k;
      row.append(k);
    }
    keyboard.append(row);
  }

  const say = (text) => (message.textContent = text);

  function paintRow(r, word, marks, animate) {
    tiles[r].forEach((t, i) => {
      t.textContent = word[i] || '';
      t.className = `tile ${word[i] ? 'filled' : ''}`;
      if (!marks) return;
      if (animate) {
        t.style.animationDelay = `${i * 0.25}s`;
        t.classList.add('flip');
        setTimeout(() => t.classList.add(marks[i]), i * 250 + 250);
      } else t.classList.add(marks[i]);
    });
  }

  function paintKeys() {
    const rank = { miss: 1, near: 2, hit: 3 };
    const best = {};
    for (const g of guesses) {
      score(g, answer).forEach((m, i) => {
        if (!best[g[i]] || rank[m] > rank[best[g[i]]]) best[g[i]] = m;
      });
    }
    for (const [ch, k] of Object.entries(keyEls)) k.className = `key ${best[ch] || ''}`;
  }

  function stats() {
    const d = load();
    return d.stats || { played: 0, wins: 0, streak: 0, best: 0, dist: [0, 0, 0, 0, 0, 0], lastDay: null };
  }

  function record(won) {
    const d = load();
    const s = stats();
    const day = todayIndex();
    if (s.lastDay === day) return;
    s.played += 1;
    if (won) {
      s.wins += 1;
      s.streak = s.lastWinDay === day - 1 ? s.streak + 1 : 1;
      s.best = Math.max(s.best, s.streak);
      s.dist[guesses.length - 1] += 1;
      s.lastWinDay = day;
    } else s.streak = 0;
    s.lastDay = day;
    d.stats = s;
    save(d);
  }

  function shareText() {
    const marks = { hit: '🟩', near: '🟨', miss: '⬛' };
    const won = guesses[guesses.length - 1] === answer;
    const head = mode === 'daily' ? `StarWordle #${todayIndex() + 1}` : 'StarWordle practice';
    return `${head} ${won ? guesses.length : 'X'}/6\n${guesses.map((g) => score(g, answer).map((m) => marks[m]).join('')).join('\n')}`;
  }

  function finish(won) {
    done = true;
    if (mode === 'daily') record(won);
    const s = stats();
    const end = el(
      'div',
      { class: 'wordle-end' },
      el('b', {}, won ? ['Brilliant!', 'Amazing!', 'Great!', 'Nice!', 'Good!', 'Phew!'][guesses.length - 1] : `The word was ${answer.toUpperCase()}`),
      mode === 'daily'
        ? el('div', { class: 'wordle-stats' }, [
            ['Played', s.played],
            ['Win %', s.played ? Math.round((s.wins / s.played) * 100) : 0],
            ['Streak', s.streak],
            ['Best', s.best],
          ].map(([k, v]) => el('div', {}, el('b', {}, v), el('span', {}, k))))
        : null,
      el(
        'div',
        { class: 'results-actions' },
        el(
          'button',
          {
            class: 'btn primary small',
            onclick: async () => {
              try {
                if (navigator.share) await navigator.share({ text: shareText() });
                else {
                  await navigator.clipboard.writeText(shareText());
                  say('Copied to clipboard');
                }
              } catch {
                /* dismissed */
              }
            },
          },
          'Share',
        ),
        el('button', { class: 'btn small', onclick: () => start('practice') }, mode === 'daily' ? 'Practice word' : 'New word'),
      ),
    );
    message.replaceChildren(end);
  }

  function shake(r) {
    const row = board.children[r];
    row.classList.remove('shake');
    void row.offsetWidth;
    row.classList.add('shake');
  }

  function submit() {
    const r = guesses.length;
    if (current.length < LEN) {
      shake(r);
      return say('Not enough letters');
    }
    if (!GUESSES.has(current)) {
      shake(r);
      return say('Not in the word list');
    }
    const g = current;
    guesses.push(g);
    current = '';
    say('');
    busy = true;
    paintRow(r, g, score(g, answer), true);
    setTimeout(() => {
      busy = false;
      paintKeys();
      if (mode === 'daily') {
        const d = load();
        d.daily = { day: todayIndex(), guesses };
        save(d);
      }
      if (g === answer) finish(true);
      else if (guesses.length === ROWS) finish(false);
    }, LEN * 250 + 300);
  }

  function press(key) {
    if (done || busy) return;
    if (key === 'Enter') return submit();
    if (key === 'Backspace') current = current.slice(0, -1);
    else if (/^[a-z]$/i.test(key) && current.length < LEN) current += key.toLowerCase();
    else return;
    paintRow(guesses.length, current);
  }

  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' || e.key === 'Backspace' || /^[a-z]$/i.test(e.key)) {
      e.preventDefault();
      press(e.key);
    }
  };
  window.addEventListener('keydown', onKey);

  function start(m) {
    mode = m;
    done = false;
    busy = false;
    current = '';
    guesses = [];
    tabs.replaceChildren(
      el('button', { 'aria-pressed': String(m === 'daily'), onclick: () => start('daily') }, `Daily #${todayIndex() + 1}`),
      el('button', { 'aria-pressed': String(m === 'practice'), onclick: () => start('practice') }, 'Practice'),
    );
    if (m === 'daily') {
      answer = dailyOrder[((todayIndex() % dailyOrder.length) + dailyOrder.length) % dailyOrder.length];
      const saved = load().daily;
      if (saved?.day === todayIndex()) guesses = saved.guesses.slice();
    } else {
      answer = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
    }
    for (let r = 0; r < ROWS; r++) paintRow(r, guesses[r] || '', guesses[r] ? score(guesses[r], answer) : null);
    paintKeys();
    say(m === 'daily' ? 'A new word every day.' : 'Unlimited practice words.');
    setInfo(null);
    const last = guesses[guesses.length - 1];
    if (last === answer) finish(true);
    else if (guesses.length === ROWS) finish(false);
  }

  start('daily');
  return () => window.removeEventListener('keydown', onKey);
}
