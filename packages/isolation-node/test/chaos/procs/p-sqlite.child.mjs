// (f, production protocol) parse a large sqlite. usage: p-sqlite.child.mjs <db> bare <sql.js path> | <db> bundle <bundle dist>
// Settings arrive as ARGUMENTS: the production wrapper passes no custom environment variables.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { ready, send } from './_common.mjs';
ready();
const [db, via, target] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(db));
let summary;
if (via === 'bundle') {
  const bundle = await import(target);
  const text = await bundle.createRipstream().parseToString(bytes);
  summary = `bundle chars=${String(text.text ?? text).length}`;
} else {
  const SQL = await createRequire(import.meta.url)(target)();
  const handle = new SQL.Database(bytes);
  const [{ values }] = handle.exec('select count(*), sum(length(a)) from t');
  summary = `sql.js rows=${values[0][0]}`;
}
send({ t: 'meta', metadata: { via: [via] } });
send({ t: 'text', chunk: summary });
send({ t: 'done' });
