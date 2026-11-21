// ओळखा पाहू! - server-authoritative game server (Express + Socket.IO)
const express = require('express'), http = require('http'), { Server } = require('socket.io');
const { PACKS } = require('./words');
const app = express(), srv = http.createServer(app), io = new Server(srv, { maxHttpBufferSize: 2e5 });
app.use(express.static('public'));
app.get('/health', (q, r) => r.send('ok'));

const rooms = new Map();
const rnd = n => Math.floor(Math.random() * n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, n);
const norm = s => String(s || '').normalize('NFC').replace(/[\u200b-\u200d\s\-.,!?]/g, '').replace(/\u0901/g, '\u0902').toLowerCase();
const num = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, Math.round(v))) : d; };
const seg = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('mr', { granularity: 'grapheme' }) : null;
const chars = w => seg ? [...seg.segment(w)].map(x => x.segment) : Array.from(w);
const newId = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s; do { s = Array.from({ length: 5 }, () => c[rnd(c.length)]).join(''); } while (rooms.has(s)); return s; };
const clearT = r => { clearTimeout(r.tm); clearInterval(r.iv); };
const plist = r => [...r.players.values()];
const say = (r, t, k = 'sys', n = '') => io.to(r.id).emit('msg', { k, n, t });

function pub(r) {
  return { id: r.id, phase: r.phase, round: r.round, host: r.host, set: r.set, drawer: r.drawer, hint: r.hint, left: r.left,
    answer: r.phase === 'reveal' && r.word ? r.word.w : null,
    players: plist(r).map(p => ({ id: p.id, name: p.name, av: p.av, col: p.col, score: p.score, ok: p.correct, on: p.on, guessed: r.guessed.has(p.id) })) };
}
const emitState = r => io.to(r.id).emit('state', pub(r));
function sendSecret(r) {
  const d = r.players.get(r.drawer); if (!d || !d.on) return;
  if (r.phase === 'choose') io.to(d.sid).emit('secret', { choices: r.choices.map(x => x.w) });
  if (r.phase === 'draw') io.to(d.sid).emit('secret', { word: r.word.w });
}
function pick(r) {
  const P = PACKS[r.set.lang], d = r.set.diff, tiers = d === 'mix' ? ['e', 'm', 'h'] : [d, d, d], out = [];
  for (const t of tiers) {
    let c = P[t].filter(x => !r.used.has(x.w) && !out.includes(x));
    if (!c.length) c = P[t].filter(x => !out.includes(x));
    if (c.length) out.push(c[rnd(c.length)]);
  }
  const all = [...P.e, ...P.m, ...P.h];
  while (out.length < 3) { const c = all.filter(x => !out.includes(x)); out.push(c[rnd(c.length)]); }
  return out;
}
const allGuessed = r => { const g = plist(r).filter(x => x.on && x.id !== r.drawer); return g.length > 0 && g.every(x => r.guessed.has(x.id)); };
const setHint = r => { r.hint = r.ch.map((c, i) => c === ' ' ? '\u00a0\u00a0' : r.rev.has(i) ? c : '_').join(' '); };
const match = (r, t) => { const g = norm(t); return g && [r.word.w, ...r.word.alts].some(a => norm(a) === g); };

function startGame(r) {
  for (const p of plist(r)) if (!p.on) r.players.delete(p.id);
  r.order = shuffle(plist(r).map(p => p.id));
  plist(r).forEach(p => { p.score = 0; p.correct = 0; });
  r.round = 1; r.ti = -1; r.used = new Set();
  say(r, '🎮 खेळ सुरू झाला! शुभेच्छा!');
  nextTurn(r);
}
function nextTurn(r) {
  clearT(r);
  const on = plist(r).filter(x => x.on).length;
  let n = 0;
  do { r.ti++; if (r.ti >= r.order.length) { r.ti = 0; r.round++; } n++; }
  while (r.round <= r.set.rounds && n <= r.order.length + 1 && !(r.players.get(r.order[r.ti]) || {}).on);
  if (r.round > r.set.rounds || on < 2) return endGame(r);
  r.drawer = r.order[r.ti]; r.phase = 'choose'; r.word = null; r.guessed = new Set();
  r.strokes = []; r.redo = []; r.pts = 0; r.hint = ''; r.left = 0;
  r.choices = pick(r);
  io.to(r.id).emit('canvas', []);
  emitState(r); sendSecret(r);
  r.tm = setTimeout(() => pickWord(r, rnd(r.choices.length)), 15000);
}
function pickWord(r, i) {
  if (r.phase !== 'choose' || !r.choices[i]) return;
  clearT(r); r.word = r.choices[i]; r.used.add(r.word.w);
  r.phase = 'draw'; r.left = r.set.time; r.rev = new Set(); r.ch = chars(r.word.w); setHint(r);
  emitState(r); sendSecret(r);
  const t = r.set.time, marks = [Math.floor(t * .6), Math.floor(t * .35), Math.floor(t * .15)];
  r.iv = setInterval(() => {
    r.left--; io.to(r.id).emit('tick', r.left);
    if (marks.includes(r.left)) {
      const c = r.ch.map((x, i) => i).filter(i => r.ch[i] !== ' ' && !r.rev.has(i));
      if (c.length > 2) { r.rev.add(c[rnd(c.length)]); setHint(r); io.to(r.id).emit('hint', r.hint); }
    }
    if (r.left <= 0) endTurn(r);
  }, 1000);
}
function endTurn(r) {
  clearT(r); r.phase = 'reveal'; emitState(r);
  say(r, '✅ उत्तर: ' + r.word.w);
  r.tm = setTimeout(() => nextTurn(r), 5000);
}
function endGame(r) { clearT(r); r.phase = 'end'; r.drawer = null; emitState(r); }

function fixHost(r) {
  const h = r.players.get(r.host); if (h && h.on) return;
  const n = plist(r).find(x => x.on);
  if (n) { r.host = n.id; say(r, n.name + ' आता होस्ट आहे 👑'); }
}
function gone(r, p, del) {
  p.on = false; clearTimeout(p.rm);
  if (del) r.players.delete(p.id);
  else if (r.phase === 'lobby') p.rm = setTimeout(() => { if (!p.on) { r.players.delete(p.id); fixHost(r); emitState(r); } }, 30000);
  if (!r.players.size) { clearT(r); rooms.delete(r.id); return; }
  fixHost(r);
  const on = plist(r).filter(x => x.on);
  if (!on.length) { clearT(r); r.kill = setTimeout(() => { if (!plist(r).some(x => x.on)) rooms.delete(r.id); }, 300000); return; }
  say(r, p.name + ' बाहेर गेला');
  if (r.phase === 'choose' || r.phase === 'draw') {
    if (on.length < 2) return endGame(r);
    if (r.drawer === p.id) { say(r, 'चित्रकार बाहेर गेला, पुढचा खेळाडू...'); return r.phase === 'draw' ? endTurn(r) : nextTurn(r); }
    if (r.phase === 'draw' && allGuessed(r)) return endTurn(r);
  }
  emitState(r);
}
function enter(sock, r, d, cb) {
  const token = clean(d.token, 60); if (!token) return cb({ err: 'अवैध विनंती' });
  let p = plist(r).find(x => x.token === token);
  if (!p) {
    if (r.phase !== 'lobby') return cb({ err: 'खेळ आधीच सुरू झाला आहे' });
    if (r.players.size >= r.set.max) return cb({ err: 'खोली भरली आहे' });
    p = { id: Math.random().toString(36).slice(2, 8), token, name: clean(d.name, 14) || 'खेळाडू', av: clean(d.av, 4) || '🦁',
      col: /^#[0-9a-f]{6}$/i.test(d.col) ? d.col : '#ff6b6b', score: 0, correct: 0, on: true, sid: sock.id, last: 0 };
    r.players.set(p.id, p); if (!r.host) r.host = p.id;
    say(r, p.name + ' खोलीत आला 👋');
  } else { clearTimeout(p.rm); p.on = true; p.sid = sock.id; }
  if (sock.data.rid && sock.data.rid !== r.id) sock.leave(sock.data.rid);
  sock.data.rid = r.id; sock.data.pid = p.id; sock.join(r.id);
  clearTimeout(r.kill);
  cb({ ok: 1, me: p.id, room: r.id });
  emitState(r); sock.emit('canvas', r.strokes);
  if (r.drawer === p.id) sendSecret(r);
}
const ctx = s => { const r = rooms.get(s.data.rid); return [r, r && r.players.get(s.data.pid)]; };
const isDrawer = (r, p) => r && p && r.phase === 'draw' && r.drawer === p.id;
const okStroke = s => s && /^#[0-9a-f]{6}$/i.test(s.c);
const pt = a => Array.isArray(a) && a.length === 2 ? [num(a[0], 0, 800, 0), num(a[1], 0, 600, 0)] : null;

io.on('connection', sock => {
  sock.on('create', (d, cb) => {
    if (typeof cb !== 'function' || !d) return;
    if (rooms.size > 2000) return cb({ err: 'सर्व्हर व्यस्त आहे' });
    const lang = ['mr', 'hi', 'en'].includes(d.lang) ? d.lang : 'mr';
    const r = { id: newId(), players: new Map(), host: null, set: { time: 80, rounds: 3, max: 12, diff: 'mix', lang }, phase: 'lobby',
      round: 0, ti: 0, order: [], drawer: null, word: null, choices: [], used: new Set(), guessed: new Set(), strokes: [], redo: [], hint: '', left: 0, pts: 0 };
    rooms.set(r.id, r);
    enter(sock, r, d, res => { if (res.err) rooms.delete(r.id); cb(res); });
  });
  sock.on('join', (d, cb) => {
    if (typeof cb !== 'function' || !d) return;
    const r = rooms.get(clean(d.room, 8).toUpperCase());
    if (!r) return cb({ err: 'खोली सापडली नाही' });
    enter(sock, r, d, cb);
  });
  sock.on('set', d => {
    const [r, p] = ctx(sock); if (!r || !p || r.host !== p.id || r.phase !== 'lobby' || !d) return;
    r.set.time = num(d.time, 30, 180, 80); r.set.rounds = num(d.rounds, 1, 10, 3);
    r.set.max = Math.max(num(d.max, 3, 12, 12), r.players.size);
    if (['mix', 'e', 'm', 'h'].includes(d.diff)) r.set.diff = d.diff;
    if (['mr', 'hi', 'en'].includes(d.lang)) r.set.lang = d.lang;
    emitState(r);
  });
  sock.on('start', () => {
    const [r, p] = ctx(sock); if (!r || !p || r.host !== p.id || r.phase !== 'lobby') return;
    if (plist(r).filter(x => x.on).length < 3) return sock.emit('msg', { k: 'sys', t: 'किमान ३ खेळाडू हवेत' });
    startGame(r);
  });
  sock.on('pick', i => { const [r, p] = ctx(sock); if (r && p && r.drawer === p.id) pickWord(r, num(i, 0, 2, -1)); });
  sock.on('st', s => {
    const [r, p] = ctx(sock); if (!isDrawer(r, p) || !okStroke(s) || r.pts > 60000) return;
    const a = pt(s.p); if (!a) return;
    const o = { c: s.c, s: num(s.s, 1, 60, 6), e: !!s.e, p: [a] };
    r.strokes.push(o); r.redo = []; r.pts++;
    sock.to(r.id).emit('st', o);
  });
  sock.on('sp', pts => {
    const [r, p] = ctx(sock); if (!isDrawer(r, p) || !Array.isArray(pts) || !r.strokes.length || r.pts > 60000) return;
    const l = r.strokes[r.strokes.length - 1], a = pts.slice(0, 100).map(pt).filter(Boolean);
    l.p.push(...a); r.pts += a.length; sock.to(r.id).emit('sp', a);
  });
  const canvasOp = f => () => { const [r, p] = ctx(sock); if (!isDrawer(r, p)) return; f(r); io.to(r.id).emit('canvas', r.strokes); };
  sock.on('undo', canvasOp(r => { const s = r.strokes.pop(); if (s) r.redo.push(s); }));
  sock.on('redo', canvasOp(r => { const s = r.redo.pop(); if (s) r.strokes.push(s); }));
  sock.on('clear', canvasOp(r => { r.strokes = []; r.redo = []; r.pts = 0; }));
  sock.on('guess', t => {
    const [r, p] = ctx(sock); if (!r || !p) return;
    t = clean(t, 60); if (!t) return;
    const now = Date.now(); if (now - p.last < 600) return; p.last = now;
    if (r.phase === 'draw') {
      if (p.id === r.drawer) return;
      if (r.guessed.has(p.id)) {
        for (const q of plist(r)) if (q.on && (r.guessed.has(q.id) || q.id === r.drawer)) io.to(q.sid).emit('msg', { k: 'chat', n: p.name, t: '🤫 ' + t });
        return;
      }
      if (match(r, t)) {
        const pts = [100, 80, 60][r.guessed.size] || 40;
        p.score += pts; p.correct++; r.guessed.add(p.id);
        const d = r.players.get(r.drawer); if (d) d.score += 30;
        sock.emit('right', { pts });
        say(r, '🎉 ' + p.name + ' ने शब्द ओळखला! (+' + pts + ')', 'ok');
        emitState(r); if (allGuessed(r)) endTurn(r);
        return;
      }
    }
    say(r, t, 'chat', p.name);
  });
  sock.on('again', () => {
    const [r, p] = ctx(sock); if (!r || !p || r.host !== p.id || r.phase !== 'end') return;
    for (const q of plist(r)) { if (!q.on) r.players.delete(q.id); else { q.score = 0; q.correct = 0; } }
    r.phase = 'lobby'; r.strokes = []; r.guessed = new Set(); r.word = null;
    io.to(r.id).emit('canvas', []); emitState(r);
  });
  sock.on('leave', () => {
    const [r, p] = ctx(sock); if (!r || !p) return;
    sock.leave(r.id); sock.data.rid = null; gone(r, p, true);
  });
  sock.on('disconnect', () => { const [r, p] = ctx(sock); if (r && p && p.sid === sock.id) gone(r, p, false); });
});

const PORT = process.env.PORT || 3000;
srv.listen(PORT, () => console.log('ओळखा पाहू! running on port ' + PORT));
