// Luma client — a small hash-routed single page app, no build step.

const MAX_REEL_SECONDS = 15 * 60;
const SOCIALS = [
  ['tiktok', 'TikTok'],
  ['youtube', 'YouTube'],
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['x', 'X'],
  ['linktree', 'Linktree'],
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const viewEl = $('#view');

const state = {
  me: null,
  muted: true,
  installPrompt: null,
};

// ---------- safe HTML templating ----------

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
};
function html(strings, ...vals) {
  return new Raw(strings.reduce((out, str, i) => out + str + (i < vals.length ? fmt(vals[i]) : ''), ''));
}
const render = (el, tpl) => {
  el.innerHTML = String(tpl);
};

// ---------- icons ----------

const icon = {
  heart: html`<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.3C1 8.2 3.2 4.5 7 4.5c2.1 0 3.6 1.1 5 2.9 1.4-1.8 2.9-2.9 5-2.9 3.8 0 6 3.7 4.5 7.2C19.5 16.4 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  comment: html`<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  share: html`<svg viewBox="0 0 24 24"><path d="M14 5l7 7-7 7v-4c-6 0-9 2-11 5 1-6 4-10 11-11z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  trash: html`<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  play: html`<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>`,
  pause: html`<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>`,
  next: html`<svg viewBox="0 0 24 24"><path d="M5 5v14l10-7zM17 5h2v14h-2z" fill="currentColor"/></svg>`,
  prev: html`<svg viewBox="0 0 24 24"><path d="M19 5v14L9 12zM5 5h2v14H5z" fill="currentColor"/></svg>`,
  muted: html`<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  sound: html`<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  back: html`<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  close: html`<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  gear: html`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  photos: html`<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 16l5-5 4 4 3-3 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
};

// ---------- small components ----------

const verifiedBadge = (v) => (v ? html`<img class="verified" src="/img/verified.png" alt="Verified" title="Verified">` : '');

function avatar(user, cls = '') {
  if (user?.avatar) return html`<img class="avatar ${cls}" src="${user.avatar}" alt="">`;
  const letter = (user?.displayName || user?.username || '?').trim()[0] || '?';
  return html`<span class="avatar ${cls}" aria-hidden="true">${letter}</span>`;
}

const nameLine = (u) => html`<span class="name">${u.displayName}</span>${verifiedBadge(u.verified)}`;

function socialBadges(links) {
  const items = SOCIALS.filter(([key]) => links?.[key]);
  if (!items.length) return '';
  return html`<div class="socials">${items.map(
    ([key, label]) =>
      html`<a href="${links[key]}" target="_blank" rel="noopener noreferrer nofollow" title="${label}"><img src="/img/social/${key}.png" alt="${label}"></a>`,
  )}</div>`;
}

const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const fmtCount = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K` : String(n);

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  const units = [
    [31536000, 'y'],
    [604800, 'w'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u}`;
  return `${s}s`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

const spinner = html`<div class="spinner" role="progressbar" aria-label="Loading"></div>`;

// ---------- API ----------

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error("You're offline. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// XHR so big uploads (15-minute reels) can report progress.
function uploadForm(path, form, onProgress, method = 'POST') {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      const data = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.send(form);
  });
}

function requireLogin() {
  if (state.me) return true;
  location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1) || '/reels')}`;
  return false;
}

// Reads a media file's length in the browser before uploading.
function mediaDuration(file, kind) {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    el.preload = 'metadata';
    const url = URL.createObjectURL(file);
    const done = (d) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    el.onloadedmetadata = () => {
      // Some recorders write Infinity; seeking far forces the real value.
      if (el.duration === Infinity) {
        el.currentTime = 1e7;
        el.ontimeupdate = () => {
          el.ontimeupdate = null;
          done(el.duration);
        };
      } else done(el.duration);
    };
    el.onerror = () => done(NaN);
    el.src = url;
  });
}

// ---------- sheets ----------

function openSheet(title, body, { onClose } = {}) {
  const root = $('#sheet-root');
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  render(
    wrap,
    html`<div class="sheet" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="grab"></div>
      <header><h2>${title}</h2><button class="icon-btn" data-close aria-label="Close">${icon.close}</button></header>
      <div class="body">${body}</div>
    </div>`,
  );
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  root.append(wrap);
  return { el: wrap, body: $('.body', wrap), close };
}

async function openComments(post, onCount) {
  const sheet = openSheet(
    'Comments',
    html`<div class="list">${spinner}</div>
      <form class="comment-form">
        <input class="input" name="body" maxlength="500" placeholder="${state.me ? 'Add a comment…' : 'Sign in to comment'}" autocomplete="off" ${state.me ? '' : 'disabled'}>
        <button class="btn primary small" ${state.me ? '' : 'disabled'}>Post</button>
      </form>`,
  );
  const list = $('.list', sheet.el);
  const row = (c) =>
    html`<div class="comment">${avatar(c.author)}<div><a href="#/u/${c.author.username}" class="name" style="text-decoration:none">${c.author.displayName}</a>${verifiedBadge(c.author.verified)} <span class="hint">${timeAgo(c.createdAt)}</span><p>${c.body}</p></div></div>`;
  try {
    const { comments } = await api(`/api/posts/${post.id}/comments`);
    render(list, comments.length ? comments.map(row) : html`<p class="empty">No comments yet. Be the first!</p>`);
  } catch (e) {
    render(list, html`<p class="error">${e.message}</p>`);
  }
  $('.comment-form', sheet.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.body;
    const body = input.value.trim();
    if (!body) return;
    input.disabled = true;
    try {
      const { comment } = await api(`/api/posts/${post.id}/comments`, { method: 'POST', body: { body } });
      $('.empty', list)?.remove();
      list.insertAdjacentHTML('afterbegin', String(row(comment)));
      input.value = '';
      post.comments += 1;
      onCount?.(post.comments);
    } catch (err) {
      toast(err.message);
    }
    input.disabled = false;
    input.focus();
  });
  sheet.el.addEventListener('click', (e) => {
    if (e.target.closest('a')) sheet.close();
  });
}

async function share(url, title) {
  const full = new URL(url, location.href).toString();
  try {
    if (navigator.share) await navigator.share({ title, url: full });
    else {
      await navigator.clipboard.writeText(full);
      toast('Link copied');
    }
  } catch {
    /* share sheet dismissed */
  }
}

// ---------- Luma Reels ----------

let reelObserver = null;
let activeReelsCleanup = null;

function reelHtml(p) {
  const media =
    p.type === 'video'
      ? html`<video src="${p.media[0]}" playsinline loop preload="metadata" ${state.muted ? 'muted' : ''}></video>
          <svg class="paused-icon" viewBox="0 0 24 24" hidden><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>
          <div class="scrub"><input type="range" min="0" max="1000" value="0" aria-label="Seek"></div>
          <span class="time"></span>`
      : html`<div class="slides">${p.media.map((src) => html`<div class="slide"><img src="${src}" alt="" loading="lazy"></div>`)}</div>
          ${p.media.length > 1 ? html`<div class="dots">${p.media.map((_, i) => html`<i class="${i ? '' : 'on'}"></i>`)}</div><span class="count-pill">1/${p.media.length}</span>` : ''}`;
  const mine = state.me && (state.me.username === p.author.username || state.me.isAdmin);
  return html`<section class="reel" data-id="${p.id}">
    ${media}
    ${p.type === 'video' ? html`<button class="icon-btn mute-btn" aria-label="Toggle sound">${state.muted ? icon.muted : icon.sound}</button>` : ''}
    <div class="info">
      <a class="author" href="#/u/${p.author.username}">${avatar(p.author)}<span>${nameLine(p.author)}</span></a>
      ${p.caption ? html`<div class="caption">${p.caption}</div>` : ''}
    </div>
    <div class="actions">
      <button data-act="like" class="${p.liked ? 'liked' : ''}" aria-label="Like">${icon.heart}<span>${fmtCount(p.likes)}</span></button>
      <button data-act="comments" aria-label="Comments">${icon.comment}<span>${fmtCount(p.comments)}</span></button>
      <button data-act="share" aria-label="Share">${icon.share}<span>Share</span></button>
      ${mine ? html`<button data-act="delete" aria-label="Delete">${icon.trash}</button>` : ''}
    </div>
  </section>`;
}

function setupReel(section, post) {
  const video = $('video', section);
  if (video) {
    const range = $('.scrub input', section);
    const time = $('.time', section);
    const pausedIcon = $('.paused-icon', section);
    let seeking = false;
    video.addEventListener('timeupdate', () => {
      if (!seeking && video.duration) range.value = String((video.currentTime / video.duration) * 1000);
      time.textContent = video.duration > 60 ? `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}` : '';
    });
    range.addEventListener('input', () => {
      seeking = true;
      if (video.duration) video.currentTime = (Number(range.value) / 1000) * video.duration;
    });
    range.addEventListener('change', () => (seeking = false));
    video.addEventListener('click', () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    video.addEventListener('play', () => (pausedIcon.hidden = true));
    video.addEventListener('pause', () => (pausedIcon.hidden = !section.classList.contains('visible')));
    $('.mute-btn', section).addEventListener('click', () => {
      state.muted = !state.muted;
      $$('.reel video').forEach((v) => (v.muted = state.muted));
      $$('.mute-btn').forEach((b) => render(b, state.muted ? icon.muted : icon.sound));
      if (!state.muted) player.pause();
    });
  }

  const slides = $('.slides', section);
  if (slides && post.media.length > 1) {
    const dots = $$('.dots i', section);
    const pill = $('.count-pill', section);
    slides.addEventListener('scroll', () => {
      const i = Math.round(slides.scrollLeft / slides.clientWidth);
      dots.forEach((d, j) => d.classList.toggle('on', i === j));
      pill.textContent = `${i + 1}/${post.media.length}`;
    });
  }

  $('.caption', section)?.addEventListener('click', (e) => e.currentTarget.classList.toggle('open'));

  section.querySelector('.actions').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'like') {
      if (!requireLogin()) return;
      try {
        const r = await api(`/api/posts/${post.id}/like`, { method: 'POST' });
        post.liked = r.liked;
        post.likes = r.likes;
        btn.classList.toggle('liked', r.liked);
        $('span', btn).textContent = fmtCount(r.likes);
      } catch (err) {
        toast(err.message);
      }
    } else if (act === 'comments') {
      openComments(post, (n) => ($('span', btn).textContent = fmtCount(n)));
    } else if (act === 'share') {
      share(`#/p/${post.id}`, `${post.author.displayName} on Luma`);
    } else if (act === 'delete') {
      if (!confirm('Delete this reel?')) return;
      try {
        await api(`/api/posts/${post.id}`, { method: 'DELETE' });
        section.remove();
        toast('Reel deleted');
      } catch (err) {
        toast(err.message);
      }
    }
  });
}

function observeReels(container) {
  reelObserver?.disconnect();
  reelObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const section = entry.target;
        const video = $('video', section);
        const visible = entry.intersectionRatio >= 0.6;
        section.classList.toggle('visible', visible);
        if (!video) continue;
        if (visible) {
          video.muted = state.muted;
          video.play().catch(() => {
            // Autoplay with sound was blocked; fall back to muted.
            video.muted = true;
            video.play().catch(() => {});
          });
        } else {
          video.pause();
        }
      }
    },
    { root: container, threshold: [0, 0.6] },
  );
  return reelObserver;
}

function reelsList(container, loadPage, emptyHtml) {
  let cursor = null;
  let loading = false;
  let done = false;
  const posts = new Map();
  const observer = observeReels(container);

  async function more() {
    if (loading || done) return;
    loading = true;
    try {
      const data = await loadPage(cursor);
      if (!posts.size && !data.items.length) render(container, emptyHtml);
      for (const p of data.items) {
        posts.set(p.id, p);
        container.insertAdjacentHTML('beforeend', String(reelHtml(p)));
        const section = container.lastElementChild;
        setupReel(section, p);
        observer.observe(section);
      }
      cursor = data.nextCursor;
      done = !cursor;
    } catch (e) {
      if (!posts.size) render(container, html`<div class="empty">${e.message}</div>`);
      else toast(e.message);
    }
    loading = false;
  }

  container.addEventListener('scroll', () => {
    if (container.scrollTop + container.clientHeight * 3 > container.scrollHeight) more();
  });
  more();
  return () => {
    observer.disconnect();
    $$('video', container).forEach((v) => {
      v.pause();
      v.removeAttribute('src');
      v.load();
    });
  };
}

function viewReels(params) {
  const following = params.get('feed') === 'following';
  render(
    viewEl,
    html`<div class="reels-top">
        <img class="logo" src="/img/logo.png" alt="Luma">
        <button data-feed="foryou" aria-pressed="${!following}">For You</button>
        <button data-feed="following" aria-pressed="${following}">Following</button>
      </div>
      <div class="reels"></div>`,
  );
  $$('.reels-top button', viewEl).forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.feed === 'following' && !requireLogin()) return;
      location.hash = b.dataset.feed === 'following' ? '#/reels?feed=following' : '#/reels';
    }),
  );
  const container = $('.reels', viewEl);
  const empty = html`<div class="empty" style="padding-top:30vh"><img src="/img/logo.png" alt="">${
    following ? 'Nobody you follow has posted yet.' : 'No reels yet.'
  }<br><br><a class="btn primary" href="#/upload">Post the first reel</a></div>`;
  return reelsList(
    container,
    (cursor) => api(`/api/feed?${following ? 'following=1&' : ''}${cursor ? `cursor=${cursor}` : ''}`),
    empty,
  );
}

async function viewPost(id) {
  render(
    viewEl,
    html`<div class="reels-top"><a href="javascript:history.back()" class="icon-btn" style="position:absolute;left:8px;top:calc(4px + var(--safe-t))" aria-label="Back">${icon.back}</a></div><div class="reels">${spinner}</div>`,
  );
  const container = $('.reels', viewEl);
  try {
    const { post } = await api(`/api/posts/${id}`);
    render(container, '');
    return reelsList(container, async () => ({ items: [post], nextCursor: null }), '');
  } catch (e) {
    render(container, html`<div class="empty" style="padding-top:30vh">${e.message}</div>`);
  }
}

// ---------- Luma Music ----------

const player = (() => {
  const audio = new Audio();
  audio.preload = 'metadata';
  let queue = [];
  let index = -1;
  let fullSheet = null;
  const bar = $('#player');

  const current = () => queue[index];

  function renderMini() {
    const t = current();
    bar.hidden = !t;
    document.body.classList.toggle('has-player', !!t);
    if (!t) return;
    render(
      bar,
      html`<img src="${t.cover}" alt="">
        <div class="meta" data-open><div class="title">${t.title}</div><div class="sub">${t.artist}</div></div>
        <button class="icon-btn" data-toggle aria-label="${audio.paused ? 'Play' : 'Pause'}">${audio.paused ? icon.play : icon.pause}</button>
        <button class="icon-btn" data-next aria-label="Next">${icon.next}</button>
        <div class="bar"></div>`,
    );
    $$('.track').forEach((el) => el.classList.toggle('playing', Number(el.dataset.id) === t.id));
    updateBar();
  }

  function updateBar() {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    const b = $('.bar', bar);
    if (b) b.style.width = `${pct}%`;
    if (fullSheet) {
      const range = $('input[type=range]', fullSheet.el);
      if (range && !range.matches(':active')) range.value = String(pct * 10);
      $('[data-cur]', fullSheet.el).textContent = fmtTime(audio.currentTime);
      $('[data-dur]', fullSheet.el).textContent = fmtTime(audio.duration || current()?.duration);
    }
  }

  function renderFull() {
    if (!fullSheet) return;
    const t = current();
    render(
      fullSheet.body,
      html`<div class="full-player">
        <img class="cover" src="${t.cover}" alt="">
        <h2>${t.title}</h2>
        <div class="sub">${t.artist}${t.album ? ` · ${t.album}` : ''}</div>
        <input type="range" min="0" max="1000" value="0" aria-label="Seek">
        <div class="times"><span data-cur>0:00</span><span data-dur>0:00</span></div>
        <div class="controls">
          <button class="icon-btn" data-prev aria-label="Previous">${icon.prev}</button>
          <button class="icon-btn play" data-toggle aria-label="Play or pause">${audio.paused ? icon.play : icon.pause}</button>
          <button class="icon-btn" data-next aria-label="Next">${icon.next}</button>
        </div>
        <p class="hint" style="margin-top:18px">Uploaded by <a href="#/u/${t.uploader.username}">@${t.uploader.username}</a>${verifiedBadge(t.uploader.verified)}</p>
      </div>`,
    );
    $('input[type=range]', fullSheet.el).addEventListener('input', (e) => {
      if (audio.duration) audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
    });
    updateBar();
  }

  function updateMediaSession() {
    const t = current();
    if (!('mediaSession' in navigator) || !t) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album || 'Luma Music',
      artwork: [{ src: new URL(t.cover, location.href).href, sizes: '512x512' }],
    });
  }

  function load(i) {
    index = i;
    const t = current();
    if (!t) return;
    audio.src = t.audio;
    audio.play().catch(() => {});
    api(`/api/tracks/${t.id}/play`, { method: 'POST' }).catch(() => {});
    // Silence any reel that's playing with sound.
    $$('.reel video').forEach((v) => (v.muted = true));
    state.muted = true;
    $$('.mute-btn').forEach((b) => render(b, icon.muted));
    updateMediaSession();
    renderMini();
    renderFull();
  }

  const api_ = {
    play(tracks, i) {
      queue = tracks.slice();
      load(i);
    },
    toggle() {
      if (!current()) return;
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    },
    pause() {
      audio.pause();
    },
    next() {
      if (queue.length) load((index + 1) % queue.length);
    },
    prev() {
      if (audio.currentTime > 3) audio.currentTime = 0;
      else if (queue.length) load((index - 1 + queue.length) % queue.length);
    },
    openFull() {
      if (!current()) return;
      fullSheet = openSheet('Now playing', '', { onClose: () => (fullSheet = null) });
      fullSheet.el.addEventListener('click', onControl);
      renderFull();
    },
    currentId: () => current()?.id,
  };

  function onControl(e) {
    if (e.target.closest('[data-toggle]')) api_.toggle();
    else if (e.target.closest('[data-next]')) api_.next();
    else if (e.target.closest('[data-prev]')) api_.prev();
    else if (e.target.closest('[data-open]')) api_.openFull();
    else if (e.target.closest('a') && fullSheet) fullSheet.close();
  }

  bar.addEventListener('click', onControl);
  audio.addEventListener('timeupdate', updateBar);
  audio.addEventListener('loadedmetadata', updateBar);
  audio.addEventListener('play', () => {
    renderMini();
    if (fullSheet) render($('[data-toggle]', fullSheet.el), icon.pause);
  });
  audio.addEventListener('pause', () => {
    renderMini();
    if (fullSheet) render($('[data-toggle]', fullSheet.el), icon.play);
  });
  audio.addEventListener('ended', () => api_.next());

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => api_.next());
    navigator.mediaSession.setActionHandler('previoustrack', () => api_.prev());
  }

  return api_;
})();

function trackRow(t) {
  return html`<li class="track ${player.currentId() === t.id ? 'playing' : ''}" data-id="${t.id}">
    <img src="${t.cover}" alt="" loading="lazy">
    <div class="meta"><div class="title">${t.title}</div><div class="sub">${t.artist}${t.album ? ` · ${t.album}` : ''} · ${fmtCount(t.plays)} plays</div></div>
    <span class="dur">${t.duration ? fmtTime(t.duration) : ''}</span>
  </li>`;
}

function trackList(ul, tracks) {
  ul.addEventListener('click', (e) => {
    const li = e.target.closest('.track');
    if (!li) return;
    const i = tracks.findIndex((t) => t.id === Number(li.dataset.id));
    if (i > -1) player.play(tracks, i);
  });
}

async function viewMusic() {
  render(
    viewEl,
    html`<div class="page">
      <div class="page-head"><div class="brand"><img src="/img/logo.png" alt=""><h1>Luma Music</h1></div>
        <a class="btn primary small" href="#/upload?type=song">Upload a song</a></div>
      <div data-body>${spinner}</div>
    </div>`,
  );
  const body = $('[data-body]', viewEl);
  const tracks = [];
  let cursor = null;

  async function load() {
    const data = await api(`/api/tracks${cursor ? `?cursor=${cursor}` : ''}`);
    tracks.push(...data.items);
    cursor = data.nextCursor;
  }
  try {
    await load();
  } catch (e) {
    return render(body, html`<div class="empty">${e.message}</div>`);
  }
  if (!tracks.length) {
    return render(
      body,
      html`<div class="empty"><img src="/img/logo.png" alt="">No songs yet.<br><br><a class="btn primary" href="#/upload?type=song">Upload the first song</a></div>`,
    );
  }

  const featured = tracks.slice(0, 6);
  render(
    body,
    html`<h2 class="section-title">New releases</h2>
      <div class="featured">${featured.map(
        (t, i) =>
          html`<button data-i="${i}"><img src="${t.cover}" alt=""><div class="title">${t.title}</div><div class="sub">${t.artist}</div></button>`,
      )}</div>
      <h2 class="section-title">All songs</h2>
      <ul class="tracks">${tracks.map(trackRow)}</ul>
      <div data-more></div>`,
  );
  $('.featured', body).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) player.play(tracks, Number(b.dataset.i));
  });
  const ul = $('.tracks', body);
  trackList(ul, tracks);

  const moreEl = $('[data-more]', body);
  const showMore = () => {
    render(moreEl, cursor ? html`<button class="btn block">Load more</button>` : '');
  };
  moreEl.addEventListener('click', async () => {
    const before = tracks.length;
    render(moreEl, spinner);
    try {
      await load();
      ul.insertAdjacentHTML('beforeend', tracks.slice(before).map(trackRow).join(''));
    } catch (e) {
      toast(e.message);
    }
    showMore();
  });
  showMore();
}

// ---------- create ----------

function viewUpload(params) {
  if (!requireLogin()) return;
  let mode = ['video', 'photo', 'song'].includes(params.get('type')) ? params.get('type') : 'video';

  render(
    viewEl,
    html`<div class="page">
      <div class="page-head"><h1>Create</h1></div>
      <div class="segmented" role="group" aria-label="What are you posting?">
        <button data-mode="video">Reel</button>
        <button data-mode="photo">Pictures</button>
        <button data-mode="song">Song</button>
      </div>
      <form data-form novalidate></form>
    </div>`,
  );
  const form = $('[data-form]', viewEl);

  function setMode(m) {
    mode = m;
    $$('.segmented button', viewEl).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    history.replaceState(null, '', `#/upload?type=${m}`);
    ({ video: videoForm, photo: photoForm, song: songForm })[m]();
  }
  $$('.segmented button', viewEl).forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  const footer = (label) => html`<div class="progress" hidden><i></i></div>
    <p class="error" data-error></p>
    <button class="btn primary block" type="submit">${label}</button>`;

  async function submit(path, fd, label, after) {
    const btn = $('button[type=submit]', form);
    const err = $('[data-error]', form);
    const prog = $('.progress', form);
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    prog.hidden = false;
    try {
      const data = await uploadForm(path, fd, (p) => ($('i', prog).style.width = `${Math.round(p * 100)}%`));
      after(data);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
      btn.textContent = label;
      prog.hidden = true;
    }
  }

  function videoForm() {
    let file = null;
    let duration = NaN;
    render(
      form,
      html`<label class="drop" data-drop>
          <input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-m4v">
          <div><strong>Choose a video</strong><br>MP4, MOV or WebM · up to 15 minutes</div>
        </label>
        <div data-preview></div>
        <label class="field" style="margin-top:14px"><span>Caption</span><textarea class="input" name="caption" maxlength="2200" placeholder="Say something about your reel…"></textarea></label>
        ${footer('Post reel')}`,
    );
    $('input[type=file]', form).addEventListener('change', async (e) => {
      file = e.target.files[0] || null;
      const err = $('[data-error]', form);
      err.textContent = '';
      if (!file) return;
      duration = await mediaDuration(file, 'video');
      const preview = $('[data-preview]', form);
      render(preview, html`<video class="preview-video" controls playsinline src="${URL.createObjectURL(file)}"></video>
        <p class="hint">${file.name} · ${fmtTime(duration)}</p>`);
      $('[data-drop]', form).hidden = true;
      if (duration > MAX_REEL_SECONDS) {
        err.textContent = `This video is ${fmtTime(duration)} long. Reels can be up to 15 minutes.`;
      }
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      const err = $('[data-error]', form);
      if (!file) return (err.textContent = 'Choose a video first.');
      if (duration > MAX_REEL_SECONDS) return (err.textContent = 'Reels can be up to 15 minutes long.');
      const fd = new FormData();
      fd.append('media', file);
      fd.append('caption', form.caption.value);
      if (Number.isFinite(duration)) fd.append('duration', String(duration));
      submit('/api/posts', fd, 'Post reel', ({ post }) => {
        toast('Your reel is live!');
        location.hash = `#/p/${post.id}`;
      });
    };
  }

  function photoForm() {
    let files = [];
    render(
      form,
      html`<label class="drop">
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple>
          <div><strong>Choose pictures</strong><br>Up to 10 · swipe through them on Luma Reels</div>
        </label>
        <div class="thumbs" data-thumbs></div>
        <label class="field" style="margin-top:14px"><span>Caption</span><textarea class="input" name="caption" maxlength="2200" placeholder="Write a caption…"></textarea></label>
        ${footer('Post pictures')}`,
    );
    $('input[type=file]', form).addEventListener('change', (e) => {
      files = [...e.target.files].slice(0, 10);
      if (e.target.files.length > 10) toast('Only the first 10 pictures will be posted');
      render($('[data-thumbs]', form), files.map((f) => html`<img src="${URL.createObjectURL(f)}" alt="">`));
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!files.length) return ($('[data-error]', form).textContent = 'Choose at least one picture.');
      const fd = new FormData();
      files.forEach((f) => fd.append('media', f));
      fd.append('caption', form.caption.value);
      submit('/api/posts', fd, 'Post pictures', ({ post }) => {
        toast('Your pictures are live!');
        location.hash = `#/p/${post.id}`;
      });
    };
  }

  function songForm() {
    let audioFile = null;
    let cover = null;
    let duration = NaN;
    render(
      form,
      html`<div class="cover-pick">
          <label class="cover" data-cover>Add album cover<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" hidden></label>
          <label class="drop" style="flex:1;min-height:110px">
            <input type="file" accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg,.aac" data-audio>
            <div data-audio-label><strong>Choose a song</strong><br>MP3, M4A, WAV, FLAC or OGG</div>
          </label>
        </div>
        <label class="field" style="margin-top:16px"><span>Title</span><input class="input" name="title" maxlength="120" required></label>
        <label class="field"><span>Artist</span><input class="input" name="artist" maxlength="120" value="${state.me.displayName}"></label>
        <label class="field"><span>Album (optional)</span><input class="input" name="album" maxlength="120"></label>
        ${footer('Upload song')}`,
    );
    $('[data-cover] input', form).addEventListener('change', (e) => {
      cover = e.target.files[0] || null;
      const box = $('[data-cover]', form);
      if (cover) {
        box.style.backgroundImage = `url("${URL.createObjectURL(cover)}")`;
        box.firstChild.textContent = '';
      }
    });
    $('[data-audio]', form).addEventListener('change', async (e) => {
      audioFile = e.target.files[0] || null;
      if (!audioFile) return;
      duration = await mediaDuration(audioFile, 'audio');
      render($('[data-audio-label]', form), html`<strong>${audioFile.name}</strong><br>${fmtTime(duration)}`);
      if (!form.title.value) form.title.value = audioFile.name.replace(/\.[^.]+$/, '').slice(0, 120);
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      const err = $('[data-error]', form);
      if (!audioFile) return (err.textContent = 'Choose a song file.');
      if (!cover) return (err.textContent = 'Add an album cover.');
      if (!form.title.value.trim()) return (err.textContent = 'Give your song a title.');
      const fd = new FormData();
      fd.append('audio', audioFile);
      fd.append('cover', cover);
      fd.append('title', form.title.value);
      fd.append('artist', form.artist.value);
      fd.append('album', form.album.value);
      if (Number.isFinite(duration)) fd.append('duration', String(duration));
      submit('/api/tracks', fd, 'Upload song', ({ track }) => {
        toast('Your song is on Luma Music!');
        location.hash = '#/music';
        setTimeout(() => player.play([track], 0), 300);
      });
    };
  }

  setMode(mode);
}

// ---------- profiles ----------

async function viewProfile(username, params) {
  render(viewEl, html`<div class="page">${spinner}</div>`);
  let data;
  try {
    data = await api(`/api/users/${encodeURIComponent(username)}`);
  } catch (e) {
    return render(viewEl, html`<div class="page"><div class="empty">${e.message}</div></div>`);
  }
  const { user, stats, isMe } = data;
  let { isFollowing } = data;
  const tab = params.get('tab') === 'music' ? 'music' : 'reels';
  const canVerify = state.me?.isAdmin;

  render(
    viewEl,
    html`<div class="page">
      <div class="page-head">
        ${isMe ? '' : html`<button class="icon-btn" onclick="history.back()" aria-label="Back">${icon.back}</button>`}
        <h1 style="font-size:17px;text-align:center">@${user.username}</h1>
        ${isMe ? html`<a class="icon-btn" href="#/settings" aria-label="Settings">${icon.gear}</a>` : html`<span style="width:40px"></span>`}
      </div>
      <div class="profile-head">
        ${avatar(user, 'lg')}
        <h1>${user.displayName}${verifiedBadge(user.verified)}</h1>
        ${user.bio ? html`<p class="bio">${user.bio}</p>` : ''}
        ${socialBadges(user.links)}
        <div class="stats">
          <div><b data-followers>${fmtCount(stats.followers)}</b><span>Followers</span></div>
          <div><b>${fmtCount(stats.following)}</b><span>Following</span></div>
          <div><b>${fmtCount(stats.likes)}</b><span>Likes</span></div>
        </div>
        <div class="profile-actions">
          ${
            isMe
              ? html`<a class="btn" href="#/settings">Edit profile</a><button class="btn" data-share>Share profile</button>`
              : html`<button class="btn ${isFollowing ? '' : 'primary'}" data-follow>${isFollowing ? 'Following' : 'Follow'}</button><button class="btn" data-share>Share</button>`
          }
          ${canVerify ? html`<button class="btn" data-verify>${user.verified ? 'Remove verification' : 'Verify account'}</button>` : ''}
        </div>
      </div>
      <div class="segmented">
        <button data-tab="reels" aria-pressed="${tab === 'reels'}">Reels · ${stats.posts}</button>
        <button data-tab="music" aria-pressed="${tab === 'music'}">Music · ${stats.tracks}</button>
      </div>
      <div data-content>${spinner}</div>
    </div>`,
  );

  $$('[data-tab]', viewEl).forEach((b) =>
    b.addEventListener('click', () => {
      location.hash = `#/u/${user.username}${b.dataset.tab === 'music' ? '?tab=music' : ''}`;
    }),
  );
  $('[data-share]', viewEl).addEventListener('click', () => share(`#/u/${user.username}`, `${user.displayName} on Luma`));
  $('[data-follow]', viewEl)?.addEventListener('click', async (e) => {
    if (!requireLogin()) return;
    const btn = e.currentTarget;
    try {
      const r = await api(`/api/users/${user.username}/follow`, { method: 'POST' });
      isFollowing = r.following;
      stats.followers += r.following ? 1 : -1;
      btn.textContent = r.following ? 'Following' : 'Follow';
      btn.classList.toggle('primary', !r.following);
      $('[data-followers]', viewEl).textContent = fmtCount(stats.followers);
    } catch (err) {
      toast(err.message);
    }
  });
  $('[data-verify]', viewEl)?.addEventListener('click', async () => {
    try {
      const r = await api(`/api/users/${user.username}/verify`, { method: 'POST', body: { verified: !user.verified } });
      toast(r.verified ? `@${user.username} is now verified` : 'Verification removed');
      route();
    } catch (err) {
      toast(err.message);
    }
  });

  const content = $('[data-content]', viewEl);
  try {
    if (tab === 'music') {
      const { items } = await api(`/api/users/${user.username}/tracks`);
      if (!items.length) return render(content, html`<div class="empty">No songs yet.</div>`);
      render(content, html`<ul class="tracks">${items.map(trackRow)}</ul>`);
      trackList($('.tracks', content), items);
    } else {
      const { items } = await api(`/api/users/${user.username}/posts`);
      if (!items.length) {
        return render(
          content,
          html`<div class="empty">No reels yet.${isMe ? html`<br><br><a class="btn primary" href="#/upload">Post your first reel</a>` : ''}</div>`,
        );
      }
      render(
        content,
        html`<div class="grid">${items.map(
          (p) =>
            html`<a href="#/p/${p.id}">${
              p.type === 'video'
                ? html`<video src="${p.media[0]}#t=0.5" muted playsinline preload="metadata"></video><span class="badge">${icon.play}${fmtTime(p.duration)}</span>`
                : html`<img src="${p.media[0]}" alt="" loading="lazy">${p.media.length > 1 ? html`<span class="badge">${icon.photos}${p.media.length}</span>` : ''}`
            }</a>`,
        )}</div>`,
      );
    }
  } catch (e) {
    render(content, html`<div class="empty">${e.message}</div>`);
  }
}

function viewSettings() {
  if (!requireLogin()) return;
  const me = state.me;
  render(
    viewEl,
    html`<div class="page">
      <div class="page-head"><button class="icon-btn" onclick="history.back()" aria-label="Back">${icon.back}</button><h1>Settings</h1></div>

      <form class="card" data-profile>
        <h2>Profile</h2>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
          <span data-avatar>${avatar(me, 'lg')}</span>
          <label class="btn small">Change photo<input type="file" name="avatar" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" hidden></label>
        </div>
        <label class="field"><span>Display name</span><input class="input" name="displayName" maxlength="50" value="${me.displayName}" required></label>
        <label class="field"><span>Bio</span><textarea class="input" name="bio" maxlength="300">${me.bio}</textarea></label>
        <h2 style="margin-top:18px">Social badges</h2>
        <p class="hint" style="margin-top:-6px">Add a username or a link. Each one shows up as a badge on your profile.</p>
        ${SOCIALS.map(
          ([key, label]) =>
            html`<label class="social-field"><img src="/img/social/${key}.png" alt=""><input class="input" name="link_${key}" placeholder="${label} username or link" value="${me.links[key] || ''}" autocomplete="off"></label>`,
        )}
        <p class="error" data-error></p>
        <button class="btn primary block">Save profile</button>
      </form>

      <form class="card" data-password>
        <h2>Password</h2>
        <label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
        <label class="field"><span>New password</span><input class="input" type="password" name="next" minlength="8" autocomplete="new-password" required></label>
        <p class="error" data-error></p>
        <button class="btn block">Change password</button>
      </form>

      <div class="card">
        <h2>App</h2>
        <div data-install></div>
        <button class="btn danger block" data-logout style="margin-top:10px">Sign out</button>
      </div>
    </div>`,
  );

  const pf = $('[data-profile]', viewEl);
  pf.avatar.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) render($('[data-avatar]', pf), html`<img class="avatar lg" src="${URL.createObjectURL(f)}" alt="">`);
  });
  pf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('displayName', pf.displayName.value);
    fd.append('bio', pf.bio.value);
    const links = {};
    for (const [key] of SOCIALS) links[key] = pf[`link_${key}`].value;
    fd.append('links', JSON.stringify(links));
    if (pf.avatar.files[0]) fd.append('avatar', pf.avatar.files[0]);
    const btn = $('button.primary', pf);
    btn.disabled = true;
    $('[data-error]', pf).textContent = '';
    try {
      const { user } = await uploadForm('/api/me', fd, null, 'PATCH');
      state.me = user;
      toast('Profile saved');
      location.hash = `#/u/${user.username}`;
    } catch (err) {
      $('[data-error]', pf).textContent = err.message;
    }
    btn.disabled = false;
  });

  const pw = $('[data-password]', viewEl);
  pw.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/me/password', { method: 'POST', body: { current: pw.current.value, next: pw.next.value } });
      pw.reset();
      $('[data-error]', pw).textContent = '';
      toast('Password changed');
    } catch (err) {
      $('[data-error]', pw).textContent = err.message;
    }
  });

  renderInstall($('[data-install]', viewEl));

  $('[data-logout]', viewEl).addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    state.me = null;
    toast('Signed out');
    location.hash = '#/reels';
  });
}

function renderInstall(el) {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (standalone) return render(el, html`<p class="hint">Luma is installed on this device.</p>`);
  if (state.installPrompt) {
    render(el, html`<button class="btn primary block">Install Luma</button>`);
    $('button', el).addEventListener('click', async () => {
      state.installPrompt.prompt();
      await state.installPrompt.userChoice;
      state.installPrompt = null;
      renderInstall(el);
    });
  } else if (ios) {
    render(el, html`<p class="hint">To install Luma, tap the Share button in Safari, then “Add to Home Screen”.</p>`);
  } else {
    render(el, html`<p class="hint">To install Luma, use your browser's “Install app” or “Add to Home screen” option.</p>`);
  }
}

// ---------- search ----------

function viewSearch(params) {
  render(
    viewEl,
    html`<div class="page">
      <div class="page-head"><h1>Search</h1></div>
      <input class="input" type="search" placeholder="Search people and songs" value="${params.get('q') || ''}" autofocus>
      <div data-results style="margin-top:14px"></div>
    </div>`,
  );
  const input = $('input', viewEl);
  const results = $('[data-results]', viewEl);
  let timer;
  let seq = 0;
  async function run() {
    const q = input.value.trim();
    history.replaceState(null, '', q ? `#/search?q=${encodeURIComponent(q)}` : '#/search');
    if (!q) return render(results, html`<p class="hint">Find creators by name or @username, and songs by title, artist or album.</p>`);
    const mine = ++seq;
    try {
      const { users, tracks } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return;
      if (!users.length && !tracks.length) return render(results, html`<div class="empty">No results for “${q}”.</div>`);
      render(
        results,
        html`${users.length ? html`<h2 class="section-title">People</h2>${users.map(
          (u) =>
            html`<a class="user-row" href="#/u/${u.username}">${avatar(u)}<div class="meta"><div>${nameLine(u)}</div><div class="handle">@${u.username}</div></div></a>`,
        )}` : ''}
        ${tracks.length ? html`<h2 class="section-title" style="margin-top:18px">Songs</h2><ul class="tracks">${tracks.map(trackRow)}</ul>` : ''}`,
      );
      const ul = $('.tracks', results);
      if (ul) trackList(ul, tracks);
    } catch (e) {
      render(results, html`<div class="empty">${e.message}</div>`);
    }
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  run();
}

// ---------- auth ----------

function viewAuth(mode, params) {
  const next = params.get('next') || '/reels';
  if (state.me) {
    location.hash = `#${next}`;
    return;
  }
  const isLogin = mode === 'login';
  render(
    viewEl,
    html`<div class="auth">
      <img class="logo" src="/img/logo.png" alt="Luma">
      <h1>${isLogin ? 'Welcome back' : 'Join Luma'}</h1>
      <p class="hint">${isLogin ? 'Sign in to like, comment and post.' : 'Share reels, pictures and music.'}</p>
      <form>
        ${isLogin ? '' : html`<label class="field"><span>Display name</span><input class="input" name="displayName" maxlength="50" autocomplete="name"></label>`}
        <label class="field"><span>Username</span><input class="input" name="username" autocapitalize="none" autocomplete="username" required ${isLogin ? '' : html`pattern="[a-zA-Z0-9_.]{3,24}"`}></label>
        <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required ${isLogin ? '' : html`minlength="8"`}></label>
        ${isLogin ? '' : html`<p class="hint" style="margin-top:-6px">3–24 letters, numbers, dots or underscores. Passwords need 8+ characters.</p>`}
        <p class="error" data-error></p>
        <button class="btn primary block">${isLogin ? 'Sign in' : 'Create account'}</button>
      </form>
      <p class="switch">${
        isLogin
          ? html`New to Luma? <a href="#/register?next=${encodeURIComponent(next)}">Create an account</a>`
          : html`Already have an account? <a href="#/login?next=${encodeURIComponent(next)}">Sign in</a>`
      }</p>
    </div>`,
  );
  const form = $('form', viewEl);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', form);
    btn.disabled = true;
    $('[data-error]', form).textContent = '';
    try {
      const body = { username: form.username.value, password: form.password.value };
      if (!isLogin) body.displayName = form.displayName.value;
      const { user } = await api(`/api/auth/${isLogin ? 'login' : 'register'}`, { method: 'POST', body });
      state.me = user;
      toast(isLogin ? `Welcome back, ${user.displayName}` : 'Welcome to Luma!');
      location.hash = `#${next}`;
    } catch (err) {
      $('[data-error]', form).textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ---------- router ----------

async function route() {
  activeReelsCleanup?.();
  activeReelsCleanup = null;
  $('#sheet-root').replaceChildren();

  const hash = location.hash.slice(1) || '/reels';
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  const [section, arg] = parts;

  const tab = { reels: 'reels', p: 'reels', search: 'search', upload: 'upload', music: 'music', me: 'me', settings: 'me' }[section] ||
    (section === 'u' && state.me && arg === state.me.username ? 'me' : '');
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  viewEl.scrollTop = 0;

  let cleanup;
  switch (section) {
    case undefined:
    case 'reels':
      cleanup = viewReels(params);
      break;
    case 'p':
      cleanup = await viewPost(Number(arg));
      break;
    case 'music':
      await viewMusic();
      break;
    case 'upload':
      viewUpload(params);
      break;
    case 'search':
      viewSearch(params);
      break;
    case 'u':
      await viewProfile(decodeURIComponent(arg || ''), params);
      break;
    case 'me':
      if (requireLogin()) location.replace(`#/u/${state.me.username}`);
      break;
    case 'settings':
      viewSettings();
      break;
    case 'login':
    case 'register':
      viewAuth(section, params);
      break;
    default:
      render(viewEl, html`<div class="page"><div class="empty">Page not found.<br><br><a class="btn" href="#/reels">Go to Reels</a></div></div>`);
  }
  if (typeof cleanup === 'function') activeReelsCleanup = cleanup;
}

// ---------- boot ----------

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

(async function boot() {
  try {
    state.me = (await api('/api/me')).user;
  } catch {
    state.me = null;
  }
  window.addEventListener('hashchange', route);
  await route();
  $('#splash').classList.add('gone');
  setTimeout(() => $('#splash').remove(), 400);
})();
