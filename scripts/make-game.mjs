#!/usr/bin/env node
/**
 * make-game.mjs — wrap an analyzed JSON (from analyze.mjs) into games/games.js.
 *
 * Usage:
 *   node scripts/make-game.mjs <analyzed.json> [--notes notes.json] [--title "..."] [--summary "..."]
 *
 * notes.json: { "35": "text for ply 35", ... }  (1-based ply index)
 * Appends a GAMES.push(...) block to games/games.js (creates it if missing).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const game = JSON.parse(readFileSync(file, 'utf8'));
const notesPath = opt('notes', null);
if (notesPath) {
  const notes = JSON.parse(readFileSync(notesPath, 'utf8'));
  for (const [ply, text] of Object.entries(notes)) {
    const i = parseInt(ply, 10) - 1;
    if (game.moves[i]) game.moves[i].note = text;
  }
}
game.title = opt('title', game.title || game.id);
game.summary = opt('summary', game.summary || '');

/* ---- per-game metrics (embedded in the game object; no separate file) ---- */
game.metrics = computeMetrics(game);

/**
 * Fingerprint a game so the same game re-reviewed (even under a different id or
 * title) is recognized and REPLACED rather than duplicated. We key on the full
 * per-ply timestamp sequence joined with the moves — timestamps are effectively
 * unique per real game, and pairing them with SANs makes a collision impossible.
 * Returns null when the game has no timestamps, in which case we fall back to
 * id-based dedup (touching only the first move's time would false-merge every
 * game that happens to open with the same clock value).
 */
function fingerprint(g) {
  const times = g.moves.map(m => m.timeSec);
  if (!times.some(t => typeof t === 'number')) return null; // no clocks → no fp
  const sans = g.moves.map(m => m.san).join(',');
  const ts = times.map(t => (typeof t === 'number' ? t : '_')).join(',');
  return sans + '|' + ts;
}
game.fp = fingerprint(game);

/**
 * Compute the metrics tracked in the viewer's Metrics tab, for the side the
 * user played. All derived from per-ply cls / eval / timeSec that analyze.mjs
 * already produced — nothing hand-entered.
 */
function computeMetrics(g) {
  const you = g.youPlayed === 'b' ? 'b' : 'w';
  // your plies: white plays even indices (0-based), black plays odd.
  const yourIdx = g.moves
    .map((_, i) => i)
    .filter(i => (you === 'w' ? i % 2 === 0 : i % 2 === 1));

  const yourMoves = yourIdx.map(i => g.moves[i]);
  const n = yourMoves.length || 1;
  const count = cls => yourMoves.filter(m => m.cls === cls).length;

  // Average centipawn loss (ACPL): win%-independent, the classic engine stat.
  // We approximate per-move cp loss from the eval swing against you, floored at 0.
  // analyze.mjs uses a large sentinel (~±99) for forced-mate evals; clamp to a
  // finite window so one mate-in-N doesn't blow up the average. Per-move loss is
  // also capped at 1000cp — past "you're already lost" more loss is meaningless.
  const CLAMP = 10; // pawns
  const clampEval = e => Math.max(-CLAMP, Math.min(CLAMP, e));
  let cpLossSum = 0;
  for (const i of yourIdx) {
    const before = clampEval(g.moves[i - 1] ? g.moves[i - 1].eval : g.moves[i].eval);
    const after = clampEval(g.moves[i].eval);
    // eval is White-POV pawns; a drop for you is positive loss.
    let lossPawns = you === 'w' ? before - after : after - before;
    if (i === 0) lossPawns = Math.max(0, (you === 'w' ? 0.2 - after : after - 0.2));
    cpLossSum += Math.min(1000, Math.max(0, lossPawns) * 100);
  }
  const acpl = Math.round(cpLossSum / n);

  // Accuracy: map ACPL through a smooth curve (chess.com-style feel).
  // 103.17 * e^(-0.04354 * acpl_scaled) - 3.17, clamped to [0,100].
  const accuracy = Math.max(0, Math.min(100,
    Math.round((103.1668 * Math.exp(-0.04354 * (acpl / 5)) - 3.1669) * 10) / 10));

  const times = yourMoves.map(m => m.timeSec).filter(t => typeof t === 'number');
  const avgTime = times.length
    ? Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10
    : null;

  const goodOrBetter = count('book') + count('best') + count('great') + count('good');

  return {
    youPlayed: you,
    result: g.result || '',
    moves: n,
    accuracy,               // 0–100
    acpl,                   // avg centipawn loss (your moves)
    best: count('best') + count('great'),
    good: goodOrBetter,
    inaccuracies: count('inacc'),
    mistakes: count('mist'),
    blunders: count('blun'),
    avgTimeSec: avgTime,    // avg seconds/move (your clock), null if unknown
  };
}

const target = 'games/games.js';

// Load existing games (if any), replace any with the same id, then rewrite the
// whole file. This keeps everything in ONE file and makes re-analysis
// idempotent — re-running a game updates its block instead of duplicating it.
const HEADER = 'window.GAMES = window.GAMES || [];\n';
let games = [];
if (existsSync(target)) {
  const src = readFileSync(target, 'utf8');
  // games.js is `window.GAMES = ...` then repeated bare `GAMES.push(...)`.
  // Bind BOTH `window` and `GAMES` to the same array so every form resolves.
  const loaded = [];
  const win = {};
  Object.defineProperty(win, 'GAMES', { get: () => loaded, set: () => {}, configurable: true });
  // eslint-disable-next-line no-new-func
  new Function('window', 'GAMES', src)(win, loaded);
  games = loaded;
}
// Match an existing game by id OR by timestamp-fingerprint (so a re-review under
// a different id still replaces in place instead of adding a duplicate).
const existingIdx = games.findIndex(g =>
  g.id === game.id || (game.fp && g.fp && g.fp === game.fp)
);
const replaced = existingIdx >= 0;
if (replaced) games[existingIdx] = game; else games.push(game);

let out = HEADER;
for (const g of games) out += '\nGAMES.push(' + JSON.stringify(g, null, 1) + ');\n';
writeFileSync(target, out);

console.log(
  `${replaced ? 'Updated' : 'Added'} "${game.title}" (${game.moves.length} plies) in ${target} — ` +
  `accuracy ${game.metrics.accuracy}%, ACPL ${game.metrics.acpl}, ${game.metrics.blunders} blunders`
);
