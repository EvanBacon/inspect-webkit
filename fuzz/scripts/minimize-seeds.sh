#!/bin/zsh
# Rebuild fuzz/seeds/<target> as a small coverage-minimal subset of one or
# more corpus dirs: libFuzzer -merge=1, then the N smallest files that are
# at most MAXB bytes. Usage: minimize-seeds.sh <target> <N> <MAXB> <corpus>...
# The merge is limited to MERGE_SECS (default 600) seconds. If it fails or
# yields nothing, the committed seeds are left untouched.
set -eu
if (( $# < 4 )) || [[ -z $1 ]]; then
  echo "usage: minimize-seeds.sh <target> <N> <MAXB> <corpus>..." >&2
  exit 2
fi
t=$1; n=$2; maxb=$3; shift 3
here=${0:A:h}/..
seeds="$here/seeds/$t"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sync=(); [[ $t == plist-* ]] && sync=(--sync)
if ! ( cd "$here" && MERGE_SECS=${MERGE_SECS:-600} perl -e 'alarm($ENV{MERGE_SECS}); exec @ARGV' \
    node node_modules/.bin/jazzer "dist/$t.mjs" "$tmp" "$@" $sync -- -merge=1 -max_len=65536 >/dev/null 2>&1 ); then
  echo "$t: merge failed or timed out; seeds unchanged" >&2
  exit 1
fi
if [[ -z $(ls "$tmp") ]]; then
  echo "$t: merge produced no inputs; seeds unchanged" >&2
  exit 1
fi
rm -rf "$seeds" && mkdir -p "$seeds"
ls -S -r "$tmp" | while read f; do
  [[ $(stat -f %z "$tmp/$f") -le $maxb ]] && cp "$tmp/$f" "$seeds/"
done
cnt=0; for f in $(ls -S -r "$seeds"); do cnt=$((cnt+1)); [[ $cnt -gt $n ]] && rm "$seeds/$f"; done
echo "$t: $(ls "$seeds" | wc -l | tr -d ' ') files, $(du -sk "$seeds" | cut -f1) KB"
