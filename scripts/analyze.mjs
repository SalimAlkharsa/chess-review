#!/usr/bin/env node
/**
 * analyze.mjs — run a game through Stockfish and emit analyzed game data.
 *
 * Usage:
 *   node scripts/analyze.mjs <input-file> [--depth 16] [--id my-game] [--you w|b]
 *
 * Input file formats (auto-detected):
 *   - PGN (headers optional)
 *   - Plain move list: "1. e4 e5 2. f3 Nc6 ..." (numbers optional)
 *   - Optional "TIMES:" line with comma-separated seconds per ply
 *     e.g.  TIMES: 5.5,0.1,3.6,...
 *
 * Output: prints a JSON object to stdout. Redirect it or let the
 * chess-review skill wrap it into games/games.js with commentary.
 *
 * Requires a UCI engine. Looks for, in order:
 *   $STOCKFISH_PATH, `stockfish` on PATH, /usr/games/stockfish,
 *   /opt/homebrew/bin/stockfish, /usr/local/bin/stockfish
 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { Chess } from 'chess.js';

// ---------- args ----------
const args = process.argv.slice(2);
if (!args.length || args[0].startsWith('--')) {
  console.error('Usage: node scripts/analyze.mjs <input-file> [--depth 16] [--id id] [--you w|b]');
  process.exit(1);
}
const inputPath = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const DEPTH = parseInt(opt('depth', '16'), 10);
const GAME_ID = opt('id', 'game-' + Date.now());
const YOU = opt('you', 'w');

// ---------- engine discovery ----------
function findEngine() {
  const candidates = [process.env.STOCKFISH_PATH, '/usr/games/stockfish',
    '/opt/homebrew/bin/stockfish', '/usr/local/bin/stockfish'].filter(Boolean);
  try {
    const p = execSync(process.platform === 'win32' ? 'where stockfish' : 'command -v stockfish',
      { encoding: 'utf8', shell: true }).trim().split('\n')[0];
    if (p) candidates.unshift(p);
  } catch {}
  for (const c of candidates) if (c && existsSync(c)) return c;
  console.error('No Stockfish found. Install it (apt install stockfish / brew install stockfish)\n' +
    'or set STOCKFISH_PATH=/path/to/stockfish');
  process.exit(1);
}
const ENGINE = findEngine();

// ---------- parse input ----------
const raw = readFileSync(inputPath, 'utf8');
let times = null;
const timesMatch = raw.match(/^TIMES:\s*(.+)$/m);
if (timesMatch) times = timesMatch[1].split(',').map(s => parseFloat(s.trim()));
const body = raw.replace(/^TIMES:.*$/m, '');

const chess = new Chess();
let sans = [];
try {
  chess.loadPgn(body);
  sans = chess.history();
} catch {
  // plain move list: strip numbers/results/annotations and try token by token
  const tokens = body
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, ' ')
    .split(/\s+/).filter(Boolean);
  chess.reset();
  for (const t of tokens) {
    const clean = t.replace(/[?!]+$/, '');
    const mv = chess.move(clean);
    if (!mv) { console.error(`Illegal/unparseable move: "${t}" at ply ${sans.length + 1}`); process.exit(1); }
    sans.push(mv.san);
  }
}
if (!sans.length) { console.error('No moves parsed from input.'); process.exit(1); }

// rebuild to collect FENs and uci moves
const game = new Chess();
const fens = [game.fen()];
const uciMoves = [];
for (const san of sans) {
  const mv = game.move(san);
  uciMoves.push({ san: mv.san, from: mv.from, to: mv.to });
  fens.push(game.fen());
}

// ---------- engine driver ----------
function createEngine() {
  const proc = spawn(ENGINE);
  let buf = '';
  const waiters = [];
  proc.stdout.on('data', d => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      for (const w of waiters) w.lines.push(line);
      waiters.forEach(w => { if (w.until(line)) w.done(); });
    }
  });
  const send = s => proc.stdin.write(s + '\n');
  const waitFor = until => new Promise(res => {
    const w = { lines: [], until, done: null };
    w.done = () => { waiters.splice(waiters.indexOf(w), 1); res(w.lines); };
    waiters.push(w);
  });
  return { send, waitFor, quit: () => { send('quit'); setTimeout(() => proc.kill(), 300); } };
}

/** Analyze one FEN; returns {cp, mate, bestUci} from side-to-move POV. */
async function analyzeFen(eng, fen) {
  eng.send('position fen ' + fen);
  const p = eng.waitFor(l => l.startsWith('bestmove'));
  eng.send('go depth ' + DEPTH);
  const lines = await p;
  let cp = null, mate = null, best = null;
  for (const l of lines) {
    if (l.startsWith('info') && l.includes(' pv ')) {
      const mCp = l.match(/score cp (-?\d+)/);
      const mMate = l.match(/score mate (-?\d+)/);
      if (mCp) { cp = parseInt(mCp[1], 10); mate = null; }
      if (mMate) { mate = parseInt(mMate[1], 10); cp = null; }
    }
    if (l.startsWith('bestmove')) best = l.split(/\s+/)[1];
  }
  return { cp, mate, bestUci: best && best !== '(none)' ? best : null };
}

/** Convert score to White-POV centipawns-ish number for the eval bar. */
function whitePov(score, whiteToMove) {
  if (score.mate !== null) {
    const m = whiteToMove ? score.mate : -score.mate;
    return m > 0 ? 10000 - m : -10000 - m;
  }
  return whiteToMove ? score.cp : -score.cp;
}

/** Win-probability model (same family chess.com/lichess use). */
const winProb = cp => 1 / (1 + Math.exp(-0.004 * Math.max(-1500, Math.min(1500, cp))));

function classify(lossWp, lossCp, playedIsBest, wpBefore, moveIndex, prevEvalW) {
  if (moveIndex < 8 && Math.abs(prevEvalW) < 80 && lossWp < 0.02) return 'book';
  if (playedIsBest) return 'best';
  // position already decided: cap severity, and don't award 'great' for shuffling
  if (wpBefore < 0.03 || wpBefore > 0.97) return lossWp >= 0.05 ? 'inacc' : 'good';
  if (lossCp >= 350 && lossWp >= 0.05) return 'blun'; // dropped major material
  if (lossWp >= 0.15) return 'blun';
  if (lossWp >= 0.08) return 'mist';
  if (lossWp >= 0.04) return 'inacc';
  if (lossWp >= 0.01) return 'good';
  return 'great';
}

// ---------- main ----------
const eng = createEngine();
eng.send('uci'); await eng.waitFor(l => l === 'uciok');
eng.send('setoption name Threads value 2');
eng.send('isready'); await eng.waitFor(l => l === 'readyok');

console.error(`Analyzing ${sans.length} plies at depth ${DEPTH} with ${ENGINE} ...`);
const evals = [];   // white-POV eval of each position fens[i]
const bests = [];   // best move (uci) from each position fens[i]
for (let i = 0; i < fens.length; i++) {
  const whiteToMove = fens[i].split(' ')[1] === 'w';
  const r = await analyzeFen(eng, fens[i]);
  evals.push(whitePov(r, whiteToMove));
  bests.push(r.bestUci);
  process.stderr.write(`\r  position ${i + 1}/${fens.length}   `);
}
eng.quit();
console.error('\ndone.');

// per-move records
const c2 = new Chess();
const moves = sans.map((san, i) => {
  const moverIsWhite = i % 2 === 0;
  const before = evals[i], after = evals[i + 1];
  const wpBefore = winProb(moverIsWhite ? before : -before);
  const wpAfter = winProb(moverIsWhite ? after : -after);
  const lossWp = Math.max(0, wpBefore - wpAfter);
  const lossCp = Math.max(0, (moverIsWhite ? before - after : after - before));
  const playedUci = uciMoves[i].from + uciMoves[i].to;
  const playedIsBest = bests[i] ? bests[i].startsWith(playedUci) : false;
  // best move in SAN + squares, for the arrow
  let best = null;
  if (bests[i] && !playedIsBest) {
    c2.load(fens[i]);
    const from = bests[i].slice(0, 2), to = bests[i].slice(2, 4);
    const promo = bests[i].slice(4) || undefined;
    const mv = c2.move({ from, to, promotion: promo });
    if (mv) best = { from, to, san: mv.san };
  }
  // legal-move count before this move (forced detection)
  c2.load(fens[i]);
  const forced = c2.moves().length === 1;
  let cls = forced ? 'forced' : classify(lossWp, lossCp, playedIsBest, wpBefore, i, before);
  return {
    san, from: uciMoves[i].from, to: uciMoves[i].to,
    eval: Math.round(after) / 100,
    cls, best,
    timeSec: times && times[i] != null ? times[i] : null,
    note: ''
  };
});

const result = new Chess(fens[fens.length - 1]);
const out = {
  id: GAME_ID,
  title: '',
  date: new Date().toISOString().slice(0, 10),
  youPlayed: YOU,
  result: result.isCheckmate() ? (fens.length % 2 === 0 ? '1-0' : '0-1') : '',
  summary: '',
  depth: DEPTH,
  fens,
  moves
};
console.log(JSON.stringify(out, null, 1));
