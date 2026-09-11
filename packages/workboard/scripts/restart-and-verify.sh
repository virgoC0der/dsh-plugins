#!/bin/sh
# Restart the Harness Web server in place so the dsh-workboard host half's
# routes get registered, then verify every route and write the evidence to a
# log. Detached on purpose: registering routes happens at boot, so the server
# that serves the GUI must be replaced, and this script must survive that.
LOG=/tmp/workboard-restart.log
: >"$LOG"
exec >>"$LOG" 2>&1

OLD_PORT_PID=$(lsof -nP -iTCP:3080 -sTCP:LISTEN -t 2>/dev/null | head -1)
echo "=== restart start $(date) ==="
echo "old pid: ${OLD_PORT_PID:-none}"

if [ -n "$OLD_PORT_PID" ]; then
  kill "$OLD_PORT_PID" 2>/dev/null
  i=0
  while [ $i -lt 60 ]; do
    if ! lsof -nP -iTCP:3080 -sTCP:LISTEN -t >/dev/null 2>&1; then break; fi
    sleep 0.5
    i=$((i + 1))
  done
  if lsof -nP -iTCP:3080 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "port still held; sending SIGKILL"
    kill -9 "$OLD_PORT_PID" 2>/dev/null
    sleep 2
  fi
fi
echo "port free: $(lsof -nP -iTCP:3080 -sTCP:LISTEN -t >/dev/null 2>&1 && echo no || echo yes)"

# The replacement server inherits the directory the current one was started from,
# so the restart does not silently change the session workspace root.
RUN_DIR="${WORKBOARD_RUN_DIR:-$(lsof -a -p "${OLD_PORT_PID:-0}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)}"
[ -n "$RUN_DIR" ] && cd "$RUN_DIR" || { echo "cannot determine the server cwd; set WORKBOARD_RUN_DIR"; exit 1; }
echo "run dir: $RUN_DIR"
DSH_BIN="$(command -v dsh || echo /opt/homebrew/bin/dsh)"
nohup "$DSH_BIN" web --no-open --port 3080 >/tmp/workboard-server.log 2>&1 &
NEW_PID=$!
echo "new pid: $NEW_PID"

i=0
while [ $i -lt 90 ]; do
  if curl -s -o /dev/null -m 2 http://127.0.0.1:3080/ 2>/dev/null; then break; fi
  sleep 1
  i=$((i + 1))
done
echo "listening: $(lsof -nP -iTCP:3080 -sTCP:LISTEN -t 2>/dev/null | head -1)"
echo

echo "--- boot graph mentions dsh-workboard (count) ---"
curl -s -m 10 http://127.0.0.1:3080/ | grep -o '"id":"dsh-workboard"' | wc -l
echo

echo "--- /workboard/health ---"
curl -s -m 20 http://127.0.0.1:3080/workboard/health
echo
echo "--- /workboard/git ---"
curl -s -m 40 http://127.0.0.1:3080/workboard/git | head -c 700
echo
echo "--- /workboard/jira ---"
curl -s -m 40 http://127.0.0.1:3080/workboard/jira | head -c 500
echo
echo "--- /workboard/calendar ---"
curl -s -m 40 http://127.0.0.1:3080/workboard/calendar | head -c 400
echo
echo "--- /workboard/github ---"
curl -s -m 90 http://127.0.0.1:3080/workboard/github | head -c 900
echo
echo "=== restart done $(date) ==="
