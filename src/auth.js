import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { can, HttpError } from './permissions.js';

const COOKIE = 'slate_session';
const MAX_AGE = 30 * 24 * 3600 * 1000;
const LANGS = ['en', 'hi', 'te', 'ta', 'kn', 'ml'];

export function secret() {
  const s = process.env.SLATE_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('SLATE_SECRET must be set (32+ characters) in production');
  return 'dev-only-secret-change-me-dev-only-secret';
}

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, secret(), { expiresIn: '30d' });
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  });
}

const publicUser = u => ({ id: u.id, email: u.email, name: u.name, lang: u.lang });

export function authRouter(db) {
  const r = Router();

  r.post('/register', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');
    const lang = LANGS.includes(req.body.lang) ? req.body.lang : 'en';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
    if (!name) throw new HttpError(400, 'Enter your name');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email already has an account');
    const hash = bcrypt.hashSync(password, 10);
    const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, password_hash, lang) VALUES (?, ?, ?, ?)').run(email, name, hash, lang);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    setSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  });

  r.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) throw new HttpError(401, 'Wrong email or password');
    setSession(res, user);
    res.json({ user: publicUser(user) });
  });

  r.post('/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

  r.get('/me', requireUser(db), (req, res) => res.json({ user: publicUser(req.user) }));

  r.patch('/me', requireUser(db), (req, res) => {
    if (LANGS.includes(req.body.lang)) db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(req.body.lang, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  return r;
}

export function requireUser(db) {
  return (req, res, next) => {
    const token = req.cookies?.[COOKIE];
    if (!token) return next(new HttpError(401, 'Sign in first'));
    try {
      const { uid } = jwt.verify(token, secret());
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      if (!user) return next(new HttpError(401, 'Sign in first'));
      req.user = user;
      next();
    } catch {
      next(new HttpError(401, 'Session expired. Sign in again.'));
    }
  };
}

/** Loads the production from :pid and the caller's role on it; optionally requires a capability. */
export function member(db, cap) {
  return (req, res, next) => {
    const pid = Number(req.params.pid);
    const m = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND production_id = ?').get(req.user.id, pid);
    if (!m) return next(new HttpError(404, 'Production not found'));
    if (cap && !can(m.role, cap)) return next(new HttpError(403, `Your role (${m.role}) cannot do this`));
    req.role = m.role;
    req.pid = pid;
    req.production = db.prepare('SELECT * FROM productions WHERE id = ?').get(pid);
    next();
  };
}
