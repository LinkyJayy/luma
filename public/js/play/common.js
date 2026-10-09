// Shared pieces for Luma Playables: teams, sprites, canvas, input and rooms.

export const TEAMS = [
  { id: 'red', name: 'Red', hex: '#ff3b30' },
  { id: 'orange', name: 'Orange', hex: '#ff8a00' },
  { id: 'yellow', name: 'Yellow', hex: '#ffd000' },
  { id: 'green', name: 'Green', hex: '#30d158' },
  { id: 'teal', name: 'Teal', hex: '#14c8c8' },
  { id: 'blue', name: 'Blue', hex: '#2f7bff' },
  { id: 'purple', name: 'Purple', hex: '#8e4dff' },
  { id: 'pink', name: 'Pink', hex: '#ff9fd0' },
  { id: 'hotpink', name: 'Hot pink', hex: '#ff2d95' },
  { id: 'white', name: 'White', hex: '#ffffff' },
  { id: 'lightgray', name: 'Light gray', hex: '#c7c7cc' },
  { id: 'darkgray', name: 'Dark gray', hex: '#5d5d63' },
  { id: 'brown', name: 'Brown', hex: '#9a6233' },
];
export const COP_HEX = '#17171c';

export const team = (id) => TEAMS.find((t) => t.id === id) || TEAMS[2];

// ---------- sprites ----------

const imageCache = new Map();

export function loadImage(name) {
  if (!imageCache.has(name)) {
    imageCache.set(
      name,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Couldn't load ${name}`));
        img.src = `/img/play/${name}.png`;
      }),
    );
  }
  return imageCache.get(name);
}

export async function loadSprites(names) {
  const imgs = await Promise.all(names.map(loadImage));
  return Object.fromEntries(names.map((n, i) => [n, imgs[i]]));
}

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const tintCache = new Map();

// Recolours the yellow parts of a sprite (the star body, the circle's centre)
// to a team colour, keeping black outlines, white rings and soft edges intact.
export function tinted(img, hex) {
  const key = `${img.src}|${hex}`;
  if (tintCache.has(key)) return tintCache.get(key);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  const [tr, tg, tb] = hexToRgb(hex);
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    const r = px[i];
    const gg = px[i + 1];
    const b = px[i + 2];
    const max = Math.max(r, gg, b);
    const min = Math.min(r, gg, b);
    if (!max) continue;
    const s = (max - min) / max;
    if (s < 0.12) continue;
    // Hue in degrees; only touch yellows/golds.
    let h;
    if (max === r) h = ((gg - b) / (max - min)) * 60;
    else if (max === gg) h = (2 + (b - r) / (max - min)) * 60;
    else h = (4 + (r - gg) / (max - min)) * 60;
    if (h < 0) h += 360;
    if (h < 28 || h > 75) continue;
    const v = max / 255;
    const k = Math.min(1, s / 0.85);
    px[i] = r + (tr * v - r) * k;
    px[i + 1] = gg + (tg * v - gg) * k;
    px[i + 2] = b + (tb * v - b) * k;
  }
  g.putImageData(data, 0, 0);
  tintCache.set(key, c);
  return c;
}

const glowCache = new Map();

// A tinted sprite with a soft glow baked in, so games don't pay for
// shadowBlur every frame. Returns { canvas, pad } where pad is the glow margin.
export function glowing(img, hex, glowHex = hex, blur = 0.12) {
  const key = `${img.src}|${hex}|${glowHex}|${blur}`;
  if (glowCache.has(key)) return glowCache.get(key);
  const src = tinted(img, hex);
  const pad = Math.round(Math.max(src.width, src.height) * blur);
  const c = document.createElement('canvas');
  c.width = src.width + pad * 2;
  c.height = src.height + pad * 2;
  const g = c.getContext('2d');
  g.shadowColor = glowHex;
  g.shadowBlur = pad * 0.9;
  g.drawImage(src, pad, pad);
  g.shadowBlur = 0;
  g.drawImage(src, pad, pad);
  const out = { canvas: c, pad };
  glowCache.set(key, out);
  return out;
}

// Draws a sprite centred at (x, y), `size` CSS px wide, optionally rotated.
export function drawSprite(g, sprite, x, y, size, angle = 0, alpha = 1) {
  const w = size;
  const h = (size * sprite.height) / sprite.width;
  g.save();
  g.globalAlpha = alpha;
  g.translate(x, y);
  if (angle) g.rotate(angle);
  g.drawImage(sprite, -w / 2, -h / 2, w, h);
  g.restore();
}

const urlCache = new Map();

// A data: URL of a tinted sprite, for <img> tags in lobbies and scoreboards.
export async function spriteURL(name, hex, size = 96) {
  const key = `${name}|${hex}|${size}`;
  if (urlCache.has(key)) return urlCache.get(key);
  const img = await loadImage(name);
  const src = hex ? tinted(img, hex) : img;
  const c = document.createElement('canvas');
  const scale = size / Math.max(src.width, src.height);
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/png');
  urlCache.set(key, url);
  return url;
}

// ---------- canvas & loop ----------

// Keeps a canvas sharp at the device's pixel ratio. Draw in CSS pixels.
export function setupCanvas(canvas, onResize) {
  const g = canvas.getContext('2d');
  const state = { g, w: 1, h: 1, dpr: 1 };
  const resize = () => {
    state.dpr = Math.min(window.devicePixelRatio || 1, 3);
    state.w = Math.max(1, canvas.clientWidth);
    state.h = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(state.w * state.dpr);
    canvas.height = Math.round(state.h * state.dpr);
    g.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    onResize?.(state.w, state.h);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  state.destroy = () => ro.disconnect();
  return state;
}

// Fits a fixed logical field (fw × fh) inside the canvas, centred.
export function fitField(view, fw, fh) {
  const s = Math.min(view.w / fw, view.h / fh);
  return { s, ox: (view.w - fw * s) / 2, oy: (view.h - fh * s) / 2 };
}

export function loop(frame) {
  let raf;
  let last = performance.now();
  let stopped = false;
  const tick = (t) => {
    if (stopped) return;
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    frame(dt, t / 1000);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}

// Deterministic random numbers so every player sees the same course.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- input ----------

export function keyboard() {
  const down = new Set();
  const pressed = new Set();
  const onDown = (e) => {
    if (e.target.closest?.('input, textarea')) return;
    if (!down.has(e.code)) pressed.add(e.code);
    down.add(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };
  const onUp = (e) => down.delete(e.code);
  const onBlur = () => down.clear();
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  window.addEventListener('blur', onBlur);
  return {
    down: (...codes) => codes.some((c) => down.has(c)),
    // True once per key press.
    hit: (...codes) => {
      const any = codes.some((c) => pressed.has(c));
      codes.forEach((c) => pressed.delete(c));
      return any;
    },
    frame: () => pressed.clear(),
    destroy() {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}

// Reports swipes (left/right/up/down) and taps on an element.
export function swipes(el, onGesture) {
  let start = null;
  const down = (e) => {
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const up = (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return onGesture('tap', e);
    if (Math.abs(dx) > Math.abs(dy)) onGesture(dx > 0 ? 'right' : 'left', e);
    else onGesture(dy > 0 ? 'down' : 'up', e);
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', () => (start = null));
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', up);
  };
}

// ---------- rooms ----------

// Client for the server's /ws/play relay. See lib/rooms.js.
export class Room {
  constructor() {
    this.handlers = new Map();
    this.me = null;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws/play`);
    this.ready = new Promise((resolve, reject) => {
      this.on('hello', (m) => {
        this.me = m.me;
        resolve(this);
      });
      this.ws.addEventListener('close', () => reject(new Error("Couldn't connect. Are you signed in?")));
    });
    this.ws.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      for (const fn of this.handlers.get(msg.t) || []) fn(msg);
    });
    this.ws.addEventListener('close', () => {
      for (const fn of this.handlers.get('disconnect') || []) fn();
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.handlers.clear();
    this.ws.close();
  }
}

// ---------- misc ----------

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Small DOM helper: el('div', { class: 'x', onclick }, child, 'text')
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      // setProperty handles custom properties (--team), which assignment ignores.
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, val);
        else node.style[prop] = val;
      }
    }
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
