#!/bin/bash
# Remote duplicate-detection end-to-end against an sshd you control (key auth, BatchMode).
# Builds birds-eye-scan from $BE_TREE, scans $BE_ROOT on $BE_REMOTE:$BE_PORT with --refine, prints the resulting
# session/group/hash-state summary, then runs two negative paths (unreachable port; unreadable file).
# Defaults target a loopback test box; override via env: BE_REMOTE=user@host BE_PORT=22 BE_ROOT=/srv/data BE_TREE=~/birds-eye
set -u
BE_REMOTE=${BE_REMOTE:-keiken@localhost}; BE_PORT=${BE_PORT:-2222}; BE_ROOT=${BE_ROOT:-$HOME/be-bench}; BE_TREE=${BE_TREE:-$HOME/birds-eye}
cd "$BE_TREE" && cargo build --bin birds-eye-scan 2>&1 | tail -1 || exit 1
BIN="$BE_TREE/target/debug/birds-eye-scan"; OUT=$(mktemp -d)
echo "== 1. remote scan + refine =="
{ time $BIN --ssh "$BE_REMOTE" --ssh-port "$BE_PORT" --index "$OUT/e2e.sqlite" --refine "$BE_ROOT"; } 2>&1 | grep -E "started|finished|cancelled|refining|duplicate groups|error|real"
python3 - "$OUT/e2e.sqlite" << 'PY'
import sqlite3, sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True); q=lambda s: c.execute(s).fetchone()
print("session:", q("SELECT status, source, files_scanned FROM scan_sessions ORDER BY started_at DESC LIMIT 1"))
print("groups / reclaimable:", q("SELECT COUNT(*), SUM(reclaimable_bytes) FROM duplicate_groups"))
print("hash_state:", c.execute("SELECT hash_state, hash_algorithm, COUNT(*) FROM files WHERE deleted_at IS NULL GROUP BY 1,2").fetchall())
print("hash issues:", q("SELECT COUNT(*) FROM scan_issues WHERE phase=\"hash\""), c.execute("SELECT path, message FROM scan_issues WHERE phase=\"hash\" LIMIT 5").fetchall())
PY
echo "== 2. negative: unreachable port (expect cancelled, clean exit) =="
$BIN --ssh "$BE_REMOTE" --ssh-port 1 --index "$OUT/bad.sqlite" --refine "$BE_ROOT" 2>&1 | grep -E "cancelled|error" | head -3; echo "exit=${PIPESTATUS[0]}"   # $? here is head's, not the binary's
echo "== 3. negative: unreadable file (expect one hash issue, rest grouped) =="
T=$(ssh -p "$BE_PORT" -o BatchMode=yes "$BE_REMOTE" "d=\$(mktemp -d); head -c 300000 /dev/urandom > \$d/a.bin; cp \$d/a.bin \$d/b.bin; cp \$d/a.bin \$d/locked.bin; chmod 000 \$d/locked.bin; echo \$d")
$BIN --ssh "$BE_REMOTE" --ssh-port "$BE_PORT" --index "$OUT/unread.sqlite" --refine "$T" 2>&1 | grep -E "finished|cancelled|duplicate groups"
python3 -c "import sqlite3,sys; c=sqlite3.connect(f\"file:{sys.argv[1]}?mode=ro\", uri=True); print(\"groups:\", c.execute(\"SELECT COUNT(*) FROM duplicate_groups\").fetchone(), \"issues:\", c.execute(\"SELECT path, message FROM scan_issues WHERE phase=\x27hash\x27\").fetchall())" "$OUT/unread.sqlite"
ssh -p "$BE_PORT" -o BatchMode=yes "$BE_REMOTE" "chmod 644 $T/locked.bin; rm -rf $T"
