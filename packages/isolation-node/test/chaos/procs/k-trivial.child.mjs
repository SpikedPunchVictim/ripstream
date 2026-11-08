// (k) healthy child: ready then clean exit.
import { ready, send } from './_common.mjs';
ready();
send({ t: 'done' });
