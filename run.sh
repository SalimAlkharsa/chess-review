#!/usr/bin/env bash
#
# run.sh — one-command chess game review.
#
#   ./run.sh
#   > paste your chess.com move-list HTML (or a PGN / move list), then Ctrl-D
#
# It hands the paste to a Claude session running the chess-review skill fully
# autonomously (no permission prompts), waits for the analysis to finish (via a
# sentinel file the skill touches), opens the viewer, and shuts the session down
# so you land back at your prompt. Uses interactive `claude` — NOT `claude -p` —
# so it runs on your Claude subscription, not metered API billing.
#
# Anti-sprawl: your pasted text goes to a temp file in $TMPDIR (never the repo),
# and every intermediate is deleted on exit — win or fail — by the trap below.

set -uo pipefail
cd "$(dirname "$0")"

MODEL="${CHESS_MODEL:-sonnet}"

# --- scratch files (outside the repo; auto-cleaned) ---
SCRATCH="${TMPDIR:-/tmp}"
INPUT="$(mktemp "${SCRATCH%/}/chess_input_XXXXXX.html")"
SENTINEL="$(mktemp -u "${SCRATCH%/}/chess_done_XXXXXX")"   # -u: name only, not created

CLAUDE_PID=""
WATCHER_PID=""
cleanup() {
  [ -n "$CLAUDE_PID" ] && kill "$CLAUDE_PID" 2>/dev/null
  [ -n "$WATCHER_PID" ] && kill "$WATCHER_PID" 2>/dev/null
  rm -f "$INPUT" "$SENTINEL"
}
trap cleanup EXIT INT TERM

# --- read the pasted game from stdin ---
echo "Paste your game (chess.com move-list HTML, a PGN, or a plain move list)."
echo "When you're done, press Ctrl-D on a new line:"
echo "----------------------------------------------------------------------"
cat > "$INPUT"

if [ ! -s "$INPUT" ]; then
  echo "Nothing pasted — aborting." >&2
  exit 1
fi
echo "----------------------------------------------------------------------"
echo "Got $(wc -c < "$INPUT" | tr -d ' ') bytes. Analyzing with Claude ($MODEL)…"
echo

# --- the prompt handed to Claude ---
# Spell out the allowed toolset so the session doesn't waste turns on commands the
# sandbox will silently auto-deny. This mirrors .claude/review-sandbox.json.
PROMPT="Review the chess game whose raw input is in the file $INPUT using the \
chess-review skill. I played White unless the input clearly shows otherwise. \
Follow the skill's full pipeline: extract the moves, run the Stockfish analysis, \
write chatty coaching commentary, register the game with make-game.mjs, and \
verify. Write all intermediate files to \$TMPDIR (not the repo) and clean them up. \
\
This session runs under a permission sandbox. You may ONLY use these Bash commands: \
node (e.g. node scripts/analyze.mjs, node scripts/make-game.mjs, node -e for chess.js \
verification), python3, which, touch, mkdir, rm -f, ls, cat, echo, grep, head, tail — \
plus the Read, Write, and Edit tools. Everything else is auto-denied, so do NOT attempt \
network access (curl/wget/ssh/scp/nc), rm -rf, or reading ~/.ssh, ~/.aws, ~/.gnupg, or \
any .env file — you don't need them for this task. If you find yourself wanting a \
command outside that list, there's a simpler in-scope way to do the step. \
\
As the very last step, run: touch \"$SENTINEL\"  — this signals my launcher \
that you're done. Do not ask me any questions; work autonomously."

# --- launch Claude autonomously in the background ---
# This session is hardened by .claude/review-sandbox.json (via --settings) — a
# file that applies ONLY here, NOT to your normal interactive sessions in this
# repo (those follow your global ~/.claude config, like the rest of your machine).
#   --settings .claude/review-sandbox.json : liberal allowlist so the pipeline
#     (incl. its node -e verify) never stalls, but denies the vectors that matter
#     for untrusted pasted HTML — network egress, reads outside repo/tmp, rm -rf.
#     It also sets advisor off + effort medium for this run.
#   --permission-mode dontAsk : no prompts; anything outside the allowlist is
#     AUTO-DENIED (never hangs, never runs an injected command).
#   --model sonnet (override with CHESS_MODEL). Interactive = subscription billing.
SANDBOX="$(dirname "$0")/.claude/review-sandbox.json"
export CHESS_DONE_SENTINEL="$SENTINEL"
# Turn the advisor tool off for this session (the canonical mechanism — an empty
# advisorModel does not disable it). Scoped to this subshell's launch.
CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 \
claude --settings "$SANDBOX" --permission-mode dontAsk --effort medium \
       --model "$MODEL" "$PROMPT" </dev/null &
CLAUDE_PID=$!

# --- watcher: when the skill signals done, open the viewer and stop Claude ---
(
  while [ ! -f "$SENTINEL" ]; do
    # bail out early if Claude died before signaling (error, crash)
    kill -0 "$CLAUDE_PID" 2>/dev/null || exit 0
    sleep 1
  done
  echo
  echo "✅ Analysis complete — opening the viewer."
  if command -v open >/dev/null 2>&1; then open index.html
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open index.html
  else echo "Open index.html in your browser to see the review."; fi
  # end the Claude session so run.sh returns to the prompt
  kill "$CLAUDE_PID" 2>/dev/null
) &
WATCHER_PID=$!

# Wait for Claude to finish (or be killed by the watcher). Then make sure the
# watcher has done its job before we exit.
wait "$CLAUDE_PID" 2>/dev/null
CLAUDE_PID=""            # already reaped; don't let cleanup re-kill a recycled PID

if [ -f "$SENTINEL" ]; then
  wait "$WATCHER_PID" 2>/dev/null
  echo "Done."
else
  # Claude exited without signaling — analysis didn't complete.
  kill "$WATCHER_PID" 2>/dev/null
  WATCHER_PID=""
  echo "Claude exited before analysis finished — nothing was opened." >&2
  echo "Check the output above, or paste your game directly into a Claude session." >&2
  exit 1
fi
