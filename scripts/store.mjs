// The build for the Chrome Web Store: the production build, except that it trusts no
// local server as the Nesty website (WXT_STORE, read by src/shared/nesty-site.ts).
// `pnpm build:store` writes .output/chrome-mv3-store; `pnpm zip:store` also zips it, to
// .output/nesty-<version>-chrome-store.zip. Either fails, and leaves no zip, when the
// output still mentions the local server, or asks for notifications without the website.
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { build, zip } from 'wxt';

process.env.WXT_STORE = 'true';
const config = {
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}-store',
  zip: { artifactTemplate: '{{name}}-{{packageVersion}}-{{browser}}-store.zip' },
};
const zips = [];
if (process.argv[2] === 'zip') zips.push(...(await zip(config)));
else await build(config);

const out = path.resolve('.output', 'chrome-mv3-store');
const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
// Price alerts, and so notifications, come from the Nesty website only.
const site = manifest.content_scripts?.some((s) => s.js?.some((f) => f.includes('nesty-site')));
const problems =
  !site && manifest.permissions.includes('notifications')
    ? ['asks for notifications without the Nesty website']
    : [];
for (const file of await readdir(out, { recursive: true })) {
  if (!/\.(js|html|json)$/.test(file)) continue;
  const text = await readFile(path.join(out, file), 'utf8');
  if (/localhost|127\.0\.0\.1/.test(text)) problems.push(`${file} mentions the local server`);
}
if (problems.length) {
  await Promise.all(zips.map((z) => rm(z, { force: true })));
  throw new Error(`Not a store build: ${problems.join('; ')}.`);
}
