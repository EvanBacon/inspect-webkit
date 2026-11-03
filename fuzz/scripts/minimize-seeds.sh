#!/bin/zsh
# Rebuild fuzz/seeds/<target> as a small coverage-minimal subset of one or
# more corpus dirs: libFuzzer -merge=1, then the N smallest files that are
# at most MAXB bytes. Usage: minimize-seeds.sh <target> <N> <MAXB> <corpus>...
set -e
t=$1; n=$2; maxb=$3; shift 3
here=${0:A:h}/..
tmp=$(mktemp -d)
sync=""; [[ $t == plist-* ]] && sync="--sync"
( cd $here && perl -e 'alarm ${MERGE_SECS:-600}; exec @ARGV' node node_modules/.bin/jazzer dist/$t.mjs $tmp "$@" $sync -- -merge=1 -max_len=65536 >/dev/null 2>&1 ) || true
rm -rf $here/seeds/$t && mkdir -p $here/seeds/$t
ls -S -r $tmp | while read f; do
  [[ $(stat -f %z $tmp/$f) -le $maxb ]] && cp $tmp/$f $here/seeds/$t/
done
cnt=0; for f in $(ls -S -r $here/seeds/$t); do cnt=$((cnt+1)); [[ $cnt -gt $n ]] && rm $here/seeds/$t/$f; done
rm -rf $tmp
echo "$t: $(ls $here/seeds/$t | wc -l | tr -d ' ') files, $(du -sk $here/seeds/$t | cut -f1) KB"
