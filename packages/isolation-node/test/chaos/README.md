# Isolation chaos fixtures (P0, bead tikajs-zgg2.2)

Linux-only fixtures that pin down the OS-level behaviour the parse-isolation design (tikajs-zgg2, design v3)
depends on, **before** any production isolation code exists. The P2 harness (tikajs-zgg2.4) will replace the
stand-in pieces here (`reference.sh`, the reader/classifier logic in `cases.mjs`) and keep the expectations.

This directory is deliberately **not** a workspace package: no `package.json`, no `tsconfig`, nothing in `tsc -b`.
Files are plain `.mjs`/`.sh`/`.json`. They are not matched by the root `pnpm test` glob
(`packages/*/test/**/*.test.ts`), so `pnpm test` never runs them. `run.mjs` refuses to run on non-Linux.

## Run

```sh
# from the repo root; Docker required. Repo is mounted read-only, scratch files live in the container's /tmp
# (a fresh mkdtemp dir, removed at exit). Run it once per platform/image; containers run one at a time.
packages/isolation-node/test/chaos/run-docker.sh                              # linux/arm64 node:24-slim   (glibc, dash)
packages/isolation-node/test/chaos/run-docker.sh linux/arm64 node:24-alpine   # musl, busybox ash
packages/isolation-node/test/chaos/run-docker.sh linux/amd64 node:24-slim     # emulated, NOT authoritative
```

`pnpm build` first: fixture **f** needs `packages/bundle-standard/dist` and FAILs without it
(`CHAOS_SKIP_BUNDLE=1` turns that into a loud SKIP).

Each invocation starts three containers: the main suite; fixture **g** in a `--memory=700m --memory-swap=700m`
container (oom.group=0); fixture **g1** in a `--privileged --memory=700m --memory-swap=700m` container where
`memory.oom.group` is set to 1 (the kernel kills the whole cgroup, runner included, so `run-docker.sh` judges that
row from outside: container exit 137 after the `ARMED` line and no survivor). **The g1 step requires `--privileged` on
the runner** (cgroupfs is read-only otherwise, so oom.group cannot be set) and it is Docker-simulated Kubernetes
behaviour (we write `memory.oom.group=1` ourselves), not real Kubernetes: kubelet/cgroup-driver behaviour on a real
cluster is unproven here. Output is one
`PASS|FAIL|WARN|SKIP` line per fixture row with the observed outcome (`signal:SIGX` / `code:N` / `spawn:ENOENT` /
`rc:N`), the parent-side kill reason, whether the `ready` frame was seen, and a stderr marker. Exit status is
nonzero if any row FAILs. `*** DESIGN FINDING` lines are loud notes, tallied but not failures.

Knobs (passed through by `run-docker.sh`): `CHAOS_D_REPS` (default 10), `CHAOS_SWEEP_REPS` (default 3),
`CHAOS_SWEEP_CAPS` (comma list of MB), `CHAOS_SKIP_BUNDLE`. Run one case directly inside any Linux container
with node >= 22.18: `node .../run.mjs --only a,b` (g needs `--mode cgroup`, g1 needs `--mode group1`; both refuse
to run unless cgroup v2 `memory.max` is a finite limit <= 4 GiB, so they can never grow unbounded).

### Platform status (read this)

| Platform | Status |
| --- | --- |
| glibc-arm64 (`node:24-slim`) | observed natively (Docker Desktop linuxkit VM, THP=always) |
| musl-arm64 (`node:24-alpine`) | observed natively |
| glibc-amd64 | observed ONLY under Docker Desktop's Rosetta emulation: **emulated, not authoritative**. d and h are downgraded to WARN there; everything else still fails the suite. Native x86_64 is unproven. |
| musl-amd64 | **never observed**. Its entries in `expected.json` fall back to the glibc defaults or are explicitly marked `"unobserved": true`; `run.mjs` prints a warning when run there. |

CI wiring (`.github/workflows`) is deliberately not done: tracked as bead tikajs-zgg2.10 (needs user OK).
`run-docker.sh` is runnable per platform so a CI matrix can call it once per cell.

## Layout

| File | Role |
| --- | --- |
| `reference.sh` | REFERENCE wrapper (stand-in until P2): `/bin/sh -c`, `ulimit -S -t N; ulimit -H -t N+2; ulimit -v <coarse>` each `\|\| exit 126` after a numeric validation (`REF_CPU_SECS`, `REF_VMEM_KB`, `REF_HEAP_MB` must be 1-12 digit positive decimals, else exit 126: `unlimited` is accepted by `ulimit` itself and would run node uncapped), `oom_score_adj=1000` best effort, `MALLOC_ARENA_MAX=1`, `exec node --max-old-space-size=<MB>`. Env: `REF_CPU_SECS` (60), `REF_VMEM_KB` (6 GiB), `REF_HEAP_MB` (256), `REF_NO_OOM_ADJ` (tests only). The `N+2` arithmetic happens only after `ulimit -S` validated N (dash exits 2 on `$((bogus+2))`; found by fixture w1). **The real P2 wrapper must also validate these values numerically in JS before building the command** (never interpolate unvalidated config into the shell string). |
| `expected.json` | The single EXPECTED-OUTCOME table: allowed outcomes, forbidden outcomes, stderr markers, ready-required, parent kill reason, numeric bounds, per-platform `variants` (`glibc-arm64`, `glibc-amd64`, `musl-arm64`, `musl-amd64`), `unobserved` flags. |
| `lib.mjs` | `runChild` (spawns exactly like the design: detached process group, fd-3 NDJSON with a pre-parse frame cap, 8 KiB stderr ring, statm poller using the real page size, parent timer), table checker, phase classifier. |
| `cases.mjs`, `run.mjs` | Parent-side checks per case; the runner prints results and applies the table. |
| `procs/*.child.mjs`, `procs/*.parent.mjs` | The hostile children and the doomed parents. |
| `run-docker.sh` | Docker runner. |

## Cases

| Id | Case | What is pinned |
| --- | --- | --- |
| a | sync `for(;;)` | only the parent timer + SIGKILL of the process group stops it |
| b | heap OOM | `--max-old-space-size` -> SIGABRT + `JavaScript heap out of memory`, and within 10 s (proves L1 bites, not the ~2 GB default heap) |
| c | string-length | RangeError `Invalid string length`, exit code 1 (not an abort) |
| d | fast page-touch of a 3 GiB reserved buffer | N=10 reps: a 20 ms statm poller kills at 512 MB (overshoot recorded); a no-kill free run records the worst per-poll RSS step. Asserts the MEASURED poller interval (median real inter-sample delta, from the poller itself, not the configured value) is <= 1.5 x the design's 20 ms and the worst step <= a data-justified bound; prints a **DESIGN FINDING** when the worst step exceeds the design's 350 MB (see below) |
| e | memory pressure then `new Worker` | dies mid-run after `ready` (SIGTRAP `Failed to reserve virtual memory`; SIGABRT/SIGSEGV also accepted); a control with a cap too small to boot dies *before* `ready` |
| f | sqlite (~28 MB) via WASM under the coarse cap | bare sql.js always; the full built pipeline REQUIRED (FAIL if `dist` is missing). The sweep (default 12 caps x 3 reps) prints a matrix with a stderr marker per failing cell (`arrbuf` = "Array buffer allocation failed", `zone` = V8 Zone OOM, ...), flags non-monotonic "banding", and asserts the reference default cap is >= the smallest cap from which every larger swept cap passed in ALL reps plus a 25% margin. A failing cell is a *benign* file: in production it would be misreported (MalformedDocument / LimitExceeded) |
| g | cgroup OOM, parent (~400 MB) larger than child, `memory.oom.group=0` | preflight prints `memory.max` and `memory.oom.group`; without `oom_score_adj` the parent is SIGKILLed; with it the parent survives and the child dies SIGKILL |
| g1 | same, `memory.oom.group=1` | the WHOLE cgroup is killed, the parent included, even with `oom_score_adj=1000` on the child |
| h | parent SIGKILLed while child sync-loops | the child is still alive 1 s later (ppid watcher cannot fire); RLIMIT_CPU (L5) bounds it. Which limit fired is inferred from the orphan's CPU TIME (the status is unobservable once the parent is gone; wall clock is unreliable under CPU contention): `/proc/<pid>/stat` utime+stime is polled and the last value before death is classified, ~N s = soft limit (default child, SIGXCPU), ~N+2 s = hard limit (a child ignoring SIGXCPU, SIGKILL). Wall-clock bounds only guard against never dying. Verified under `docker run --cpus=1` plus a concurrent busy loop |
| i | one 64 MiB fd-3 frame | naive `JSON.parse` heap amplification + event-loop block are printed; a per-frame-cap reader kills before any parse |
| j | `done` frame then linger | kill-after-grace of the process **group** reaps the child and a grandchild; leader-only kill does not (control) |
| k | no `/bin/sh` | `spawn` ENOENT (no pid) vs `exec` not-found 127 vs ulimit 126, all "unavailable" (no `ready`); mid-run abort is "crash" |
| l | RLIMIT_CPU | Through a shell: soft/hard split -> the shell's `$?` is 152; hard-only -> 137; IO sleep accrues no CPU; every failing `ulimit` step is nonzero (dash rc2 / busybox ash rc1) and the `\|\| exit 126` form exits 126. Through the exec'ing `reference.sh` the PARENT does not see rc152: it sees `signal:SIGXCPU` (152 is only a shell's `$?` encoding) |
| n | close-vs-exit hazard | a grandchild keeps the child's stdout/stderr/fd 3 open after the child exits, so `close` lags `exit` (until the grandchild dies). The reader still finishes via the terminal frame + grace kill of the group; the control shows `close` alone only ends at the safety timer. **Classification must never wait on `close` alone** |
| w | `reference.sh` itself | fails closed (`REF_CPU_SECS=bogus`/`unlimited`, `REF_VMEM_KB=bogus`/`unlimited`/20 digits -> exit 126, node never ran; and valid numbers that `ulimit` itself refuses, w7, also exit 126); `/proc/self/limits` of the wrapped child shows CPU soft=N hard=N+2, address space = the coarse cap, `oom_score_adj`=1000, `MALLOC_ARENA_MAX=1`; a child that handles SIGXCPU is still SIGKILLed at the hard limit (~3 s with N=1) |
| m | issue_cmap12 heap need | **SKIPPED**: needs the 2 KB PDF fixture (282 MB heap); TODO tikajs-zgg2.8 (P6). Not faked. |

Not covered although listed in the bead description: the 10k-entry archive timing fixture (also P6 material).

## Findings that matter for the design

* **oom_score_adj is not a complete OOM mitigation.** It only helps when `memory.oom.group=0` (Docker's default). With
  `memory.oom.group=1` (Kubernetes >= 1.28 defaults to group kill; see kubelet `singleProcessOOMKill`) the kernel kills
  the whole cgroup and fixture g1 shows the parent dies with the child. The mitigation needs one of: `oom.group=0`, the
  child in its own sub-cgroup, or kubelet `singleProcessOOMKill`. The **memory-pool gate is the PRIMARY defence**
  (never admit children whose caps could exceed `memory.max`); `oom_score_adj` is secondary.
* **L3 overshoot is larger than the design's 350 MB.** See the `d` row output: in the Docker Desktop VM (THP=always) a
  single 20 ms poll step reached several hundred MB (the free-run worst case and the kill-run overshoot are both printed;
  numbers vary run to run with host memory state, first rep of a fresh container is often much smaller). The row asserts
  a data-justified bound (1024 MB) and prints the finding; the pool gate must budget from measured data, not 350 MB.
  Note the measured step does not grow linearly with the poll interval (growth saturates), so the row asserts the poller's
  MEASURED interval stays at the design's 20 ms (a hard-coded slower poller fails it even if the config says 20).
* **L4 banding is real in the full pipeline** (bare sql.js is fine at every cap): see the f sweep matrix.
