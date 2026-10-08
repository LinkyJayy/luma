'use strict';

// Social profiles a user can link. Each accepts either a handle or a full
// https URL on one of the platform's own domains.
const PLATFORMS = {
  tiktok: { hosts: ['tiktok.com'], url: (h) => `https://www.tiktok.com/@${h}` },
  youtube: { hosts: ['youtube.com', 'youtu.be'], url: (h) => `https://www.youtube.com/@${h}` },
  facebook: { hosts: ['facebook.com', 'fb.com'], url: (h) => `https://www.facebook.com/${h}` },
  instagram: { hosts: ['instagram.com'], url: (h) => `https://www.instagram.com/${h}` },
  x: { hosts: ['x.com', 'twitter.com'], url: (h) => `https://x.com/${h}` },
  linktree: { hosts: ['linktr.ee'], url: (h) => `https://linktr.ee/${h}` },
};

const HANDLE = /^[A-Za-z0-9._-]{1,64}$/;

function normalizeLink(platform, value) {
  const p = PLATFORMS[platform];
  if (!p) return null;
  const v = String(value ?? '').trim();
  if (!v) return '';

  if (/^https?:\/\//i.test(v)) {
    let u;
    try {
      u = new URL(v);
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase();
    const ok = p.hosts.some((d) => host === d || host.endsWith(`.${d}`));
    if (!ok || u.protocol !== 'https:') return null;
    return u.toString();
  }

  const handle = v.replace(/^@/, '');
  return HANDLE.test(handle) ? p.url(handle) : null;
}

// Returns { links } with only valid, non-empty entries, or { error }.
function normalizeLinks(input) {
  const links = {};
  for (const [platform, value] of Object.entries(input || {})) {
    if (!PLATFORMS[platform]) continue;
    const n = normalizeLink(platform, value);
    if (n === null) return { error: `That ${platform} link doesn't look right.` };
    if (n) links[platform] = n;
  }
  return { links };
}

module.exports = { PLATFORMS, normalizeLink, normalizeLinks };
