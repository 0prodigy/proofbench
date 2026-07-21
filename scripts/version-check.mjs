#!/usr/bin/env node
// @ts-check
/**
 * prepack gate — "version from git tag" the zero-dependency way.
 *
 * Runs before `npm pack` / `npm publish` (npm's own `prepack` lifecycle hook — no added
 * dependency, just node:child_process + node:fs). Refuses to pack/publish unless HEAD is
 * tagged `v<package.json version>` exactly, so a published tarball's version can never drift
 * from the git tag a human can audit. Not run on a consumer's `npm install` of the tarball
 * (prepack only fires for pack/publish/git-installs in the source tree), so a tagless
 * extracted tarball is never blocked by this check.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const expectedTag = `v${pkg.version}`;

let tagsOnHead = '';
try {
  tagsOnHead = execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
} catch (err) {
  console.error(`version-check: could not read git tags (${/** @type {Error} */ (err).message}) — refusing to pack/publish untagged.`);
  process.exit(1);
}

const tags = tagsOnHead.split('\n').map((t) => t.trim()).filter(Boolean);
if (!tags.includes(expectedTag)) {
  console.error(
    `version-check: HEAD is not tagged "${expectedTag}" (package.json version is ${pkg.version}).\n` +
      `  tags on HEAD: ${tags.length ? tags.join(', ') : '(none)'}\n` +
      `  fix: git tag ${expectedTag}  (or bump package.json to match an existing tag)`,
  );
  process.exit(1);
}

console.log(`version-check: HEAD tagged ${expectedTag} — matches package.json. OK.`);
