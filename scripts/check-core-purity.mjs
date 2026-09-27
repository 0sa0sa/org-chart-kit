// コア（src/core, src/index.ts）が React や DOM 部品に依存していないことを確かめる
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const files = ['src/index.ts', ...readdirSync('src/core').map((f) => join('src/core', f))];
const bad = files.filter((f) => /from ['"](react|react-dom|\.\.\/react|\.\/react)/.test(readFileSync(f, 'utf8')));
if (bad.length) {
  console.error('core must not import React:', bad);
  process.exit(1);
}
console.log('core purity: ok');
