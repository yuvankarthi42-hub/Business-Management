// Bundles src/worker/index.ts (the Cloudflare setup) into backend/dist-worker/worker.js for `wrangler deploy`.
// The Catalyst build (scripts/build.mjs) is separate and unchanged. Node built-ins (node:crypto) come from the
// Workers runtime ("nodejs_compat" in wrangler.toml); nothing else is left outside the bundle.
import { build } from 'esbuild'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const out = join(here, '..', 'dist-worker', 'worker.js')
mkdirSync(dirname(out), { recursive: true })

const r = await build({
  entryPoints: [join(here, '..', 'src', 'worker', 'index.ts')],
  bundle: true, platform: 'neutral', target: 'es2022', format: 'esm', outfile: out,
  conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'],
  alias: { '@': join(root, 'src') },
  external: ['node:*', 'cloudflare:*'],
  legalComments: 'none', sourcemap: false, minify: false, logLevel: 'warning', metafile: true,
})

// The Catalyst-only parts must never end up in the Worker.
const inputs = Object.keys(r.metafile.inputs)
const banned = inputs.filter((f) => /zcatalyst|node_modules\/express\/|src\/(index|cron|catalystEnv|local|app)\.ts$|src\/core\/files\.ts$|src\/db\/(catalyst|local|memory)\.ts$/.test(f))
if (banned.length) { console.error('Not allowed in the Worker bundle:\n  ' + banned.join('\n  ')); process.exit(1) }
console.log(`Built dist-worker/worker.js (${Math.round(statSync(out).size / 1024)} KB, ${inputs.length} files)`)
