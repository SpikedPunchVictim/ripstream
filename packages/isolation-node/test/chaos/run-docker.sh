#!/bin/sh
# Run the chaos suite inside Docker (Linux), repo mounted READ-ONLY. One container at a time.
# usage: run-docker.sh [platform] [image]    default: linux/arm64 node:24-slim
#   platform: linux/arm64 | linux/amd64      image: node:24-slim (glibc) | node:24-alpine (musl)
# Run it once per platform/image you care about (CI wiring is bead tikajs-zgg2.10, not done here):
#   run-docker.sh linux/arm64 node:24-slim; run-docker.sh linux/arm64 node:24-alpine; run-docker.sh linux/amd64 node:24-slim
# amd64 on an arm64 host is emulated (Docker Desktop: Rosetta/QEMU): labelled "emulated, not authoritative".
# The g1 step runs the container with --privileged (needed to write memory.oom.group); it is Docker-simulated K8s behaviour.
# Passes through CHAOS_SWEEP_REPS, CHAOS_SWEEP_CAPS, CHAOS_D_REPS, CHAOS_SKIP_BUNDLE when set.
# Exit status is nonzero if any fixture FAILs.
set -u
PLATFORM=${1:-linux/arm64}
IMAGE=${2:-node:24-slim}
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
SUITE=/repo/packages/isolation-node/test/chaos

HOST_ARCH=$(uname -m)
case "$HOST_ARCH:$PLATFORM" in
  arm64:linux/arm64|aarch64:linux/arm64|x86_64:linux/amd64) EMU=0 ;;
  *) EMU=1 ;;
esac
[ "$EMU" = 1 ] && echo "NOTE: $PLATFORM on host $HOST_ARCH is emulated, not authoritative (d and h downgrade to WARN)."

# --init: reap orphans so zombies cannot masquerade as live processes (fixture h).
# usage: dr [extra docker options...] IMAGE command...
dr() {
  for v in CHAOS_SWEEP_REPS CHAOS_SWEEP_CAPS CHAOS_D_REPS CHAOS_SKIP_BUNDLE; do
    eval "val=\${$v-}"
    [ -n "$val" ] && set -- -e "$v=$val" "$@"
  done
  docker run --rm --init --platform "$PLATFORM" -v "$REPO:/repo:ro" \
    -e "CHAOS_EMULATED=$EMU" -e CHAOS_SCRATCH=/tmp -w /tmp "$@"
}
RC=0

echo "##### main suite: $PLATFORM $IMAGE"
dr "$IMAGE" node "$SUITE/run.mjs" || RC=1

# Fixture g needs a finite cgroup memory limit (parent larger than child), so it gets its own container.
echo "##### cgroup OOM (g, oom.group=0): $PLATFORM $IMAGE --memory=700m --memory-swap=700m"
dr --memory=700m --memory-swap=700m "$IMAGE" node "$SUITE/run.mjs" --mode cgroup || RC=1

# Fixture g1: memory.oom.group=1 (Kubernetes default). The kernel kills the whole cgroup INCLUDING the runner,
# so the verdict is made here from outside: container exit 137 after the ARMED line, never a "PARENT SURVIVED".
echo "##### cgroup OOM (g1, oom.group=1): $PLATFORM $IMAGE --privileged --memory=700m --memory-swap=700m"
OUT=$(mktemp)
dr --privileged --memory=700m --memory-swap=700m "$IMAGE" node "$SUITE/run.mjs" --mode group1 >"$OUT" 2>&1
GRC=$?
cat "$OUT"
if grep -q '^FAIL g-cgroup-oom-group1' "$OUT"; then
  RC=1
elif [ "$GRC" = 137 ] && grep -q '^ARMED' "$OUT" && ! grep -q 'PARENT SURVIVED' "$OUT"; then
  echo "PASS g-cgroup-oom-group1     whole cgroup killed: container exit 137 after ARMED, parent died too (oom_score_adj did NOT save it)"
else
  echo "FAIL g-cgroup-oom-group1     expected container exit 137 after ARMED and no survivor; got exit $GRC"
  RC=1
fi
rm -f "$OUT"

[ "$RC" = 0 ] && echo "ALL PASS ($PLATFORM $IMAGE)" || echo "FAILURES ($PLATFORM $IMAGE)"
exit $RC
