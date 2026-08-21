#!/bin/bash
# Remote-hash helper conformance: both helpers must match independent sha256sum vectors for the
# wire protocol (full digest, framed partial/sample, ERR, truncated-since-scan clamp).
# Run on any POSIX host with python3, perl, coreutils:
#   scripts/remote-hash-conformance.sh src/index/algorithms/helpers/remote_hash.py src/index/algorithms/helpers/remote_hash.pl
set -u
PY="$1"; PL="$2"; D=$(mktemp -d); cd "$D"
le64() { perl -e 'print pack("Q<", $ARGV[0])' "$1"; }   # LE encoding only; sha256sum stays the oracle
printf 'abc' > abc.txt
head -c 1048576 /dev/urandom > one.bin
head -c 3145728 /dev/urandom > three.bin
S1=1048576; S3=3145728; B=65536; MID=$(( (S3 - B) / 2 )); LAST3=$(( S3 - B )); LAST1=$(( S1 - B ))
frame() { f=$1; sz=$2; shift 2; { le64 $sz; for c in "$@"; do o=${c%%:*}; l=${c##*:}; n=$(dd if="$f" bs=65536 skip=$o count=$l iflag=skip_bytes,count_bytes status=none | wc -c); le64 $o; le64 $n; dd if="$f" bs=65536 skip=$o count=$l iflag=skip_bytes,count_bytes status=none; done; } | sha256sum | cut -d' ' -f1; }
E_ABC=$(sha256sum abc.txt | cut -d' ' -f1)
E_ONE_P=$(frame one.bin $S1 0:$B $LAST1:$B)
E_THREE_S=$(frame three.bin $S3 0:$B $MID:$B $LAST3:$B)
E_THREE_FULL=$(sha256sum three.bin | cut -d' ' -f1)
# truncated-since-scan case: index claims 3 MiB but file is 2 MiB -> clamp rules must apply identically
head -c 2097152 three.bin > trunc.bin
E_TRUNC_S=$(frame trunc.bin $S3 0:$B $MID:$B $LAST3:$B)   # LAST3 >= actual size -> chunk skipped? no: offset < claimed size, read returns 0 bytes -> len 0 recorded
{ printf '1:f\t3\tfull\t%s/abc.txt\0' "$D"; printf '2:p\t%s\t0:%s,%s:%s\t%s/one.bin\0' $S1 $B $LAST1 $B "$D"; printf '3:s\t%s\t0:%s,%s:%s,%s:%s\t%s/three.bin\0' $S3 $B $MID $B $LAST3 $B "$D"; printf '4:f\t%s\tfull\t%s/three.bin\0' $S3 "$D"; printf '5:f\t1\tfull\t%s/missing.bin\0' "$D"; printf '6:s\t%s\t0:%s,%s:%s,%s:%s\t%s/trunc.bin\0' $S3 $B $MID $B $LAST3 $B "$D"; } > req.bin
OUT_PY=$(python3 "$PY" < req.bin | tr '\0' '\n'); OUT_PL=$(perl "$PL" < req.bin | tr '\0' '\n')
echo "== python =="; echo "$OUT_PY"; echo "== perl =="; echo "$OUT_PL"
fail=0
chk() { key=$1; exp=$2; for impl in PY PL; do out=$([ $impl = PY ] && echo "$OUT_PY" || echo "$OUT_PL"); got=$(echo "$out" | awk -F'\t' -v k="$key" '$1==k{print $2}'); if [ "$got" = "$exp" ]; then echo "ok   $impl $key"; else echo "FAIL $impl $key got=$got exp=$exp"; fail=1; fi; done; }
chk 1:f "$E_ABC"; chk 2:p "$E_ONE_P"; chk 3:s "$E_THREE_S"; chk 4:f "$E_THREE_FULL"; chk 5:f ERR; chk 6:s "$E_TRUNC_S"
PYT=$(echo "$OUT_PY" | awk -F'\t' '$1=="6:s"{print $2}'); PLT=$(echo "$OUT_PL" | awk -F'\t' '$1=="6:s"{print $2}'); [ -n "$PYT" ] && [ "$PYT" = "$PLT" ] && echo "ok   py==pl on truncated file" || { echo "FAIL py/pl differ on truncated file: $PYT vs $PLT"; fail=1; }
[ $fail = 0 ] && echo "CONFORMANCE PASS" || { echo "CONFORMANCE FAIL"; exit 1; }
