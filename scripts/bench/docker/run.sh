#!/bin/sh
# Builds the benchmark image for the current HEAD (once) and runs scripts/bench/run.ts in it.
#
# Usage:
#   XBERG_REPO=<xberg checkout> XBERG_CORPUS=<xberg-io/test_documents checkout> \
#   XBERG_CLI=<unpacked xberg-cli-aarch64-unknown-linux-musl dir> \
#   [XBERG_CORPUS_BIN=<dir of binaries fetched by fetch-corpus.ts>] [BENCH_OUT=<dir>] \
#     scripts/bench/docker/run.sh [run.ts options, e.g. --cohort /xberg/cohorts/native-email-fast.json]
#
# Inside the container the harness is at /xberg, the corpus at /corpus/td (and /corpus/bin),
# results go to /out (BENCH_OUT, default artifacts/bench-xberg). The container has no network.
# The image is tagged ripstream-bench:<commit>; remove it with `docker rmi`.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
: "${XBERG_REPO:?set XBERG_REPO}" "${XBERG_CORPUS:?set XBERG_CORPUS}" "${XBERG_CLI:?set XBERG_CLI}"
out=${BENCH_OUT:-$repo/artifacts/bench-xberg}
commit=$(git -C "$repo" rev-parse --short HEAD)
image=ripstream-bench:$commit

if ! docker image inspect "$image" >/dev/null 2>&1; then
  snapshot=$(mktemp -d)
  trap 'rm -rf "$snapshot"' EXIT
  # Committed sources only: work in progress in the checkout does not leak into the numbers.
  git -C "$repo" archive HEAD | tar -x -C "$snapshot"
  echo "$commit" > "$snapshot/COMMIT"
  docker build -t "$image" \
    --build-context ripstream="$snapshot" \
    --build-context xberg="$XBERG_CLI" \
    --build-context harness="$XBERG_REPO/tools/benchmark-harness/scripts" \
    "$here"
fi

mkdir -p "$out"
if [ -n "${XBERG_CORPUS_BIN:-}" ]; then set -- --corpus /corpus/bin "$@"; fi
exec docker run --rm --init --network none --hostname bench --add-host bench:127.0.0.1 \
  -v "$repo/scripts/bench:/bench:ro" \
  -v "$XBERG_REPO/tools/benchmark-harness:/xberg:ro" \
  -v "$XBERG_CORPUS:/corpus/td:ro" \
  ${XBERG_CORPUS_BIN:+-v "$XBERG_CORPUS_BIN:/corpus/bin:ro"} \
  -v "$out:/out" \
  "$image" node /bench/run.ts --fixtures /xberg/fixtures --corpus /corpus/td --out /out "$@"
