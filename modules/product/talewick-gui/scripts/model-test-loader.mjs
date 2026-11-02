import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

// Load the real model dependency graph into an isolated test directory.
export async function prepareModelModules(destination) {
  const root = new URL('../src/model/', import.meta.url);
  for (const name of await readdir(root)) {
    if (name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
    if (!name.endsWith('.ts') && !name.endsWith('.mjs')) continue;
    let source = await readFile(new URL(name, root), 'utf8');
    if (name.endsWith('.ts')) source = stripTypeScriptTypes(source, { mode: 'transform' });
    source = source.replace(/(from\s+['"])(\.\/[^'"]+)(['"])/g, (_, before, target, after) =>
      before + (target.endsWith('.mjs') ? target : target.replace(/\.ts$/, '') + '.mjs') + after);
    source = source.replace(/(from\s+['"])(\.\.\/[^'"]+)(['"])/g, (_, before, target, after) => before + new URL(target, new URL(name, root)).href + after);
    await writeFile(path.join(destination, name.replace(/\.ts$/, '.mjs')), source);
  }
}
