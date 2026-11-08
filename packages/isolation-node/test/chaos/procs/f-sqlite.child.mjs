// (f) parse a large sqlite. usage: f-sqlite.child.mjs <db>
//   BUNDLE_DIST set  -> full pipeline: createRipstream().parseToString (fidelity of the Opus-review banding finding)
//   else SQLJS_PATH  -> bare sql.js WASM open + query
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { ready, send } from './_common.mjs';
ready();
const bytes = new Uint8Array(readFileSync(process.argv[2]));
if (process.env.BUNDLE_DIST) {
  const bundle = await import(process.env.BUNDLE_DIST);
  const text = await bundle.createRipstream().parseToString(bytes);
  send({ t: 'done', via: 'bundle', chars: String(text.text ?? text).length, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
} else {
  const SQL = await createRequire(import.meta.url)(process.env.SQLJS_PATH)();
  const db = new SQL.Database(bytes);
  const [{ values }] = db.exec('select count(*), sum(length(a)) from t');
  send({ t: 'done', via: 'sql.js', rows: values[0][0], rssMb: Math.round(process.memoryUsage().rss / 1048576) });
}
