// (w, production protocol) report the limits the production wrapper applied, as seen by the wrapped node, in a meta frame.
import { readFileSync } from 'node:fs';
import { ready, send } from './_common.mjs';
ready();
const lim = readFileSync('/proc/self/limits', 'utf8');
const pair = (name) => {
  const m = new RegExp(`${name}\\s+(\\S+)\\s+(\\S+)`).exec(lim);
  return [m[1], m[2]];
};
const [cpuSoft, cpuHard] = pair('Max cpu time');
const [asSoft, asHard] = pair('Max address space');
send({
  t: 'meta',
  metadata: {
    cpuSoft: [cpuSoft], cpuHard: [cpuHard], asSoft: [asSoft], asHard: [asHard],
    oomAdj: [readFileSync('/proc/self/oom_score_adj', 'utf8').trim()],
    arenaMax: [String(process.env.MALLOC_ARENA_MAX)],
  },
});
send({ t: 'done' });
