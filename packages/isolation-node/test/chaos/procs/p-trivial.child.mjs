// (production protocol) healthy child: ready, an empty text result, done.
import { ready, send } from './_common.mjs';
ready();
send({ t: 'meta', metadata: {} });
send({ t: 'done' });
