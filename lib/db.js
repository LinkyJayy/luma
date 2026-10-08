'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'luma.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      bio           TEXT NOT NULL DEFAULT '',
      avatar        TEXT,
      links         TEXT NOT NULL DEFAULT '{}',
      verified      INTEGER NOT NULL DEFAULT 0,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    -- A reel is either a video (up to 15 minutes) or a set of pictures.
    CREATE TABLE IF NOT EXISTS posts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type       TEXT NOT NULL CHECK (type IN ('video', 'photo')),
      caption    TEXT NOT NULL DEFAULT '',
      media      TEXT NOT NULL,
      duration   REAL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id, id);

    CREATE TABLE IF NOT EXISTS likes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, post_id)
    );
    CREATE INDEX IF NOT EXISTS likes_post ON likes(post_id);

    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id, id);

    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (follower_id, followee_id)
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      artist     TEXT NOT NULL,
      album      TEXT NOT NULL DEFAULT '',
      audio      TEXT NOT NULL,
      cover      TEXT NOT NULL,
      duration   REAL,
      plays      INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tracks_user ON tracks(user_id, id);
  `);
  return db;
}

module.exports = { openDb };
