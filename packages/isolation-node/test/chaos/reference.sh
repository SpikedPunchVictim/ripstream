#!/bin/sh
# REFERENCE wrapper for the isolation design v3 (bead tikajs-zgg2). Stand-in used by
# the chaos fixtures until P2 (tikajs-zgg2.4) ships the real wrapper. Not production code.
#
# Production form is `/bin/sh -c '<this script>' reference.sh <child.mjs> [args...]`;
# running `sh reference.sh <child.mjs> [args...]` is equivalent.
#
# Env knobs (all optional):
#   REF_CPU_SECS    L5 soft RLIMIT_CPU seconds; hard = soft + 2          (default 60)
#   REF_VMEM_KB     L4 COARSE ulimit -v in KiB                           (default 6291456 = 6 GiB)
#   REF_HEAP_MB     L1 --max-old-space-size                              (default 256)
#   REF_NO_OOM_ADJ  non-empty: skip oom_score_adj (fixture g control only)
CPU=${REF_CPU_SECS:-60}
VMEM=${REF_VMEM_KB:-6291456}
HEAP=${REF_HEAP_MB:-256}

# Numeric validation BEFORE any ulimit/arithmetic: only 1-12 digit positive decimals pass. Rejects 'unlimited' (which
# `ulimit` itself accepts and which would run node uncapped), empty, signs, hex/octal-looking and 20-digit values, and
# keeps dash from exiting 2 (not 126) on `$((bogus + 2))`.
num() { case $1 in ''|*[!0-9]*|0*) exit 126;; esac; [ "${#1}" -le 12 ] || exit 126; }
num "$CPU"
num "$VMEM"
num "$HEAP"

# Each limit step fails closed: never run node unlimited.
ulimit -S -t "$CPU" || exit 126
# Arithmetic only after $CPU was validated (dash exits 2 on `$((bogus + 2))`; found by fixture w1).
HARD=$((CPU + 2))
ulimit -H -t "$HARD" || exit 126
ulimit -v "$VMEM" || exit 126

# Best effort: make the cgroup OOM killer prefer this child over the parent.
if [ -z "${REF_NO_OOM_ADJ:-}" ]; then
  { echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null || echo "reference.sh: oom_score_adj not set" >&2
fi

MALLOC_ARENA_MAX=1
export MALLOC_ARENA_MAX
exec node --max-old-space-size="$HEAP" "$@"
