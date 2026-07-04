---
name: chess-review
description: >
  Turn a chess game pasted by the user (chess.com move-list HTML, a PGN, or a
  plain move list) into a fully analyzed, annotated entry in this repo's game
  viewer. Trigger whenever the user pastes chess moves, a PGN, chess.com HTML,
  or asks to "review my game", "add this game", or "analyze this game".
---

# Chess Review skill

This repo is a chess game-review viewer (`index.html`) driven by `games/games.js`.
Your job: take whatever game the user pastes and produce a new reviewed game
entry with Stockfish evals, move classifications, best-move arrows, and
**coaching commentary written by you**.

## Pipeline

### 1. Extract the moves (and clock times if present)

The user may paste:
- **chess.com move-list HTML** (divs with classes like `main-line-ply`,
  `data-figurine="N"` spans, and `data-time` timestamp divs). Reconstruct SAN:
  a `data-figurine="X"` span means the move starts with that piece letter,
  concatenated with the text that follows (e.g. figurine N + "c6" = `Nc6`,
  figurine R + "xb3" = `Rxb3`, figurine N + "1a2" = `N1a2`). Moves without a
  figurine are pawn moves or castling. Timestamps: `data-time` values are in
  **tenths of a second** (`data-time="55"` = 5.5s); collect them per ply in order.
- **A PGN** — use as-is.
- **A plain move list** — use as-is.

**Anti-sprawl rule (important):** intermediate files (`.moves`, analyzed JSON,
`notes.json`) must NOT be written into the repo — they'd pile up over time. Write
them to a scratch dir instead, and delete them at the end (step 6). Use the
harness scratchpad dir if one is set in your environment, else `"$TMPDIR"`.
Define one variable at the start and reuse it:

```
SCRATCH="${CHESS_SCRATCH:-$TMPDIR}"           # or your session scratchpad path
```

Write the moves to `$SCRATCH/<name>.moves` in this format:

```
TIMES: 5.5,0.1,3.6,...        <- one float per ply, omit line if unknown
1. e4 e5 2. f3 Nc6 ... 0-1
```

The only files that persist in the repo are `games/games.js` (all games, one
file) — never a per-game file. Ask the user which color they played if it isn't
obvious. Default: white.

### 2. Run the engine analysis

```
node scripts/analyze.mjs "$SCRATCH/<name>.moves" --depth 16 --id <name> --you w > "$SCRATCH/analyzed.json"
```

- Requires Stockfish (`apt install stockfish`, `brew install stockfish`, or
  `STOCKFISH_PATH=/path/to/binary`). If missing, tell the user how to install it.
- The script validates every move; if it reports an illegal move, your SAN
  extraction in step 1 is wrong — fix it there, don't guess.
- Depth 16 is a good default; 18–20 if the user wants more precision (slower).

The output JSON contains per-ply: `san`, `eval` (White POV, pawns), `cls`
(book/best/great/good/inacc/mist/blun/forced), `best` ({from,to,san} — the
engine's preferred move, used for the green arrow), `timeSec`, and an empty `note`.

### 3. Write the coaching commentary (this is your real job)

Read the analyzed JSON (`$SCRATCH/analyzed.json`) and write
`$SCRATCH/notes.json` mapping **1-based ply numbers** to coaching notes:

```json
{ "3": "Weakens the king and blocks the knight's best square...", "35": "..." }
```

Write like an engaged coach talking the player through the game, not a terse
engine log. Be chatty and instructive — teach the ideas, don't just flag errors.

Guidelines for good notes:
- **Name the opening and its plans early.** In the first several moves, identify
  the opening ("This is the Ruy Lopez Exchange"), what each side is playing FOR
  (pawn majorities, the bishop pair, a specific pawn break, king safety), and the
  typical middlegame this structure leads to. This is the chattiest part — set
  the strategic scene even when the moves are objectively fine.
- **Talk structure and plans, not just tactics.** Point out pawn-structure
  features (isolated/doubled/backward pawns, majorities, weak color complexes,
  outposts), which pieces are good vs. bad, and the plan each side should follow.
  When a quiet move subtly helps or hurts a plan, say so.
- Annotate every `blun` and `mist`, most `inacc`, and any move that carries a
  lesson (great finds, missed tactics, key plans, instructive quiet moves). Truly
  routine moves can stay blank — the viewer auto-shows "Stockfish preferred X"
  for un-noted bad moves — but lean toward saying something when there's a plan
  or structural point to teach.
- Explain **why**, not just what: name the tactic, the weak square, the
  undeveloped piece, the plan it serves. Connect recurring themes across the game
  (e.g. "the d4 knight the engine wanted traded for six straight moves").
- **Coach the endgame.** When the game simplifies, explain the technique: which
  side the king should go, how to shepherd a passed pawn, the winning/drawing
  method, key squares. Endgames are where players learn the most — be generous.
- Use 1–3 sentences per note (a touch longer for opening/plan/endgame teaching
  moments). Address the user as "you" for their moves. Warm and encouraging, but
  honest about mistakes.
- When `best` exists, reference it so the arrow makes sense ("Bxd4 was the move").
- Write a fuller `--summary` (3–5 sentences): name the opening, trace the arc of
  the game (opening plan → the turning point → how it was decided), and land the
  top 1–2 lessons the player should take away.

### 4. Register the game

```
node scripts/make-game.mjs "$SCRATCH/analyzed.json" --notes "$SCRATCH/notes.json" \
  --title "Blitz vs. <opponent> — <result>" \
  --summary "<your game summary>"
```

This writes the game into `games/games.js` (the single file for all games) and
**computes the per-game metrics** (accuracy, ACPL, blunder/mistake/inaccuracy
counts, avg time/move) that power the viewer's Metrics tab — you don't compute
those by hand. Re-running with the same `--id` **updates** that game in place
instead of duplicating it, so re-analysis is safe. The viewer picks it up on
reload — no other edits needed.

### 5. Verify

- Confirm the game registered: `make-game.mjs` prints `Added`/`Updated "<title>"
  … accuracy X%, ACPL Y, Z blunders` on success. That line is your confirmation.
- Sanity-check 2–3 of your notes against the actual position before describing any
  tactic — replay the FENs (from `$SCRATCH/analyzed.json`, the `fens` array) with
  chess.js via `node -e`. Never claim a tactic works without confirming the squares.

**Permissions note:** when launched from `run.sh`, this session runs under a
hardened settings file (`.claude/review-sandbox.json`, `--permission-mode dontAsk`).
The pipeline's commands — `node …`, `python3`, temp reads/writes, `touch`, `rm -f`,
`ls`/`cat`/`grep` — are all allowed and run without prompts. Only genuinely risky
things (network: curl/wget/ssh; reads of `~/.ssh`/`~/.aws`/`.env`; `rm -rf`) are
denied, so an injected command hidden in the pasted HTML is blocked. You shouldn't
hit a denial doing the normal pipeline; if you do, it's a signal the command wasn't
part of the intended flow.

### 6. Clean up scratch files (and signal run.sh if launched from it)

Delete the intermediates so nothing accumulates:

```
rm -f "$SCRATCH/<name>.moves" "$SCRATCH/analyzed.json" "$SCRATCH/notes.json"
```

Also delete any raw pasted-HTML temp file if one was created. Then tell the user
to open `index.html` (or refresh) and check the **Metrics** tab.

**If (and only if) you were launched by `run.sh`** — the environment variable
`CHESS_DONE_SENTINEL` will be set — touch it as the very last step so the script
knows analysis is complete and can open the viewer:

```
[ -n "$CHESS_DONE_SENTINEL" ] && touch "$CHESS_DONE_SENTINEL"
```

## Editing existing games

Game objects live in `games/games.js` as `GAMES.push({...})` blocks. To revise
commentary, edit the `note` fields in place, or re-run steps 2–4 with the same
`--id` (make-game.mjs replaces that game in place — no manual deletion needed).

## Don'ts

- Don't hand-write evals or classifications — they must come from analyze.mjs.
- Don't invent clock times; omit TIMES if the user didn't provide them.
- Don't claim a tactic works without replaying it on the board.
