'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');

const MAX_REEL_SECONDS = 15 * 60;

// Accepted upload types, mapped to the extension we store them under.
// The stored name never uses the client's filename.
const TYPES = {
  video: {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-m4v': '.m4v',
  },
  image: {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
  },
  audio: {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/wave': '.wav',
    'audio/ogg': '.ogg',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/webm': '.weba',
  },
};

function kindOf(mimetype) {
  for (const [kind, map] of Object.entries(TYPES)) {
    if (map[mimetype]) return kind;
  }
  return null;
}

// Reads the movie duration from an MP4/MOV container's moov/mvhd box
// without loading the file into memory. Returns seconds, or null.
function mp4Duration(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);

    const findBox = (start, end, type) => {
      let pos = start;
      while (pos + 8 <= end) {
        head.fill(0);
        fs.readSync(fd, head, 0, 16, pos);
        let len = head.readUInt32BE(0);
        const t = head.toString('latin1', 4, 8);
        let hdr = 8;
        if (len === 1) {
          len = Number(head.readBigUInt64BE(8));
          hdr = 16;
        } else if (len === 0) {
          len = end - pos;
        }
        if (len < hdr) return null;
        if (t === type) return { start: pos + hdr, end: Math.min(pos + len, end) };
        pos += len;
      }
      return null;
    };

    const moov = findBox(0, size, 'moov');
    if (!moov) return null;
    const mvhd = findBox(moov.start, moov.end, 'mvhd');
    if (!mvhd) return null;

    const b = Buffer.alloc(32);
    fs.readSync(fd, b, 0, 32, mvhd.start);
    let timescale, duration;
    if (b[0] === 1) {
      timescale = b.readUInt32BE(20);
      duration = Number(b.readBigUInt64BE(24));
    } else {
      timescale = b.readUInt32BE(12);
      duration = b.readUInt32BE(16);
    }
    return timescale ? duration / timescale : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Uses ffprobe when it is installed; works for every container.
function ffprobeDuration(file) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const d = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(d) ? d : null);
      },
    );
  });
}

async function probeDuration(file, mimetype) {
  const d = await ffprobeDuration(file);
  if (d !== null) return d;
  if (/mp4|quicktime|m4v|m4a|audio\/mp4/.test(mimetype)) return mp4Duration(file);
  return null;
}

module.exports = { TYPES, MAX_REEL_SECONDS, kindOf, mp4Duration, probeDuration };
