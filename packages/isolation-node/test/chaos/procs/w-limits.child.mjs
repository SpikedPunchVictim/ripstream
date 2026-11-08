// (w) report the limits the wrapper actually applied, as seen by the wrapped node itself.
import { readFileSync } from 'node:fs';
import { ready, send } from './_common.mjs';
ready();
const lim = readFileSync('/proc/self/limits', 'utf8');
const pair = (name) => {
  const m = new RegExp(`${name}\\s+(\\S+)\\s+(\\S+)`).exec(lim);
  return { soft: m[1], hard: m[2] };
};
send({
  t: 'limits',
  cpu: pair('Max cpu time'),
  as: pair('Max address space'),
  oomAdj: readFileSync('/proc/self/oom_score_adj', 'utf8').trim(),
  arenaMax: process.env.MALLOC_ARENA_MAX,
});
send({ t: 'done' });
