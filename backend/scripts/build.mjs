// Bundles src/index.ts (+ the shared app code in ../src/core) into catalyst/functions/api/index.js.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

/** One Catalyst function folder: bundled index.js + package.json + catalyst-config.json. */
async function fn(name, entry, type) {
  const out = join(root, 'catalyst', 'functions', name)
  mkdirSync(out, { recursive: true })
  await build({
    entryPoints: [join(here, '..', 'src', entry)],
    bundle: true, platform: 'node', target: 'node18', format: 'cjs', outfile: join(out, 'index.js'),
    alias: { '@': join(root, 'src') },
    external: ['zcatalyst-sdk-node'], // installed by Catalyst from package.json below
    legalComments: 'none', sourcemap: false, minify: false, logLevel: 'warning',
  })
  writeFileSync(join(out, 'package.json'), JSON.stringify({
    name, version: pkg.version, main: 'index.js', private: true,
    dependencies: { 'zcatalyst-sdk-node': pkg.dependencies['zcatalyst-sdk-node'] },
  }, null, 2) + '\n')
  // Environment variables are set in the Catalyst console (never committed); keep any set locally.
  const cfgPath = join(out, 'catalyst-config.json')
  const prev = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}
  writeFileSync(cfgPath, JSON.stringify({
    deployment: { name, stack: 'node18', type, env_variables: { ...(prev.deployment?.env_variables ?? {}) } },
    execution: { main: 'index.js' },
  }, null, 2) + '\n')
  console.log(`Built catalyst/functions/${name} (${type})`)
}

await fn('api', 'index.ts', 'advancedio')
await fn('daily', 'cron.ts', 'cron')
