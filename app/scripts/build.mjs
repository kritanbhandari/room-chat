import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const assets = {};
for (const [filename, type] of [['index.html', 'text/html'], ['app.js', 'text/javascript'], ['style.css', 'text/css']]) {
  assets['/' + filename] = { body: readFileSync(new URL('app/public/' + filename, root), 'utf8'), type: type + '; charset=utf-8' };
}
mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/assets.json', root), JSON.stringify(assets));
console.log('Built browser assets with no third-party dependencies.');
