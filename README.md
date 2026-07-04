# Chess Review

A local, chess.com-style game review app that teaches you from your own games.
Stockfish provides the evals and best moves; Claude (via the bundled skill)
writes the coaching commentary.


## Quick start

```bash
npm install                 # installs chess.js (the only dependency)
open index.html             # or just double-click it — no server needed
```

The repo ships with one reviewed game so you can see the result immediately.

## Requirements for analyzing new games

A Stockfish binary:

- macOS: `brew install stockfish`
- Debian/Ubuntu: `sudo apt install stockfish`
- Windows/other: download from stockfishchess.org and set
  `STOCKFISH_PATH=C:\path\to\stockfish.exe`

## The fastest workflow: `./run.sh`

```bash
./run.sh
# > paste your chess.com HTML (or PGN / move list), then Ctrl-D
```

`run.sh` hands your paste to an interactive Claude session (your subscription,
**not** metered API), runs the full review pipeline, and pops open the viewer
the moment it's done. Your pasted text goes to a temp file and every intermediate
is deleted on exit — nothing accumulates in the repo.

## The workflow (with Claude Code, manually)

1. Open this repo in Claude Code.
2. Paste your game — chess.com move-list HTML (right-click the move list →
   inspect → copy the element), a PGN, or a plain move list — and say
   "review this game, I was white".
3. The `chess-review` skill (in `.claude/skills/chess-review/`) extracts the
   moves, runs `scripts/analyze.mjs` through Stockfish, writes coaching notes,
   and adds the game (with computed metrics) to `games/games.js`.
4. Refresh `index.html`. Your game appears in the selector, fully annotated
   with best-move arrows.

## The workflow (manual, no Claude)

```bash
# 1. Save your moves to a scratch dir (TIMES line optional — seconds per ply).
#    Keep intermediates OUT of the repo so they don't pile up.
cat > "$TMPDIR/mygame.moves" << 'MOVES'
1. e4 e5 2. Nf3 Nc6 ... 1-0
MOVES

# 2. Analyze (--you w|b marks which side you played)
node scripts/analyze.mjs "$TMPDIR/mygame.moves" --depth 16 --id mygame --you w > "$TMPDIR/a.json"

# 3. Register (notes optional). Re-running with the same --id updates in place.
node scripts/make-game.mjs "$TMPDIR/a.json" --title "My game" --summary "What happened"

# 4. Clean up
rm -f "$TMPDIR/mygame.moves" "$TMPDIR/a.json"
```

## Using the viewer

- Arrow keys / buttons step through; Space autoplays; F flips; A toggles arrows.
- **Green arrow** = what Stockfish preferred whenever the played move wasn't
  best. Try to guess it before advancing — that's the training loop.
- **Jump to issues** skips straight to your inaccuracies/mistakes/blunders.
- The game selector (top right) switches between reviewed games.
- **Metrics tab** tracks your progress across games: average accuracy and
  centipawn loss, blunders per game, an accuracy trend line, and a per-game
  table (click any row to jump into that game's review).

## How classifications work

Move quality is computed from win-probability loss (the same family of model
chess.com/lichess use), with extra rules: dropping ≥3.5 pawns of eval is always
a blunder, single-legal-move positions are "forced", and already-decided
positions don't spam blunder tags.

## Layout

```
run.sh                              paste-and-review one-liner
index.html                          the viewer (open directly, no build)
games/games.js                      all reviewed games + metrics (the ONLY data file)
scripts/analyze.mjs                 Stockfish analysis -> JSON
scripts/make-game.mjs               JSON + notes -> games.js entry (+ computes metrics)
.claude/skills/chess-review/        the Claude Code skill
```

Move inputs and analysis JSON are written to a scratch dir and deleted after
each run — the repo holds one data file (`games/games.js`), not a growing pile.
