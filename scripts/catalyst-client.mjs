// After `npm run build:catalyst`: copies dist-catalyst into catalyst/client for Catalyst *web client hosting*
// (only needed if you host the app there instead of Slate) and writes client-package.json.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const from = join(root, 'dist-catalyst'), to = join(root, 'catalyst', 'client')
if (!existsSync(from)) throw new Error('Run the Catalyst build first (dist-catalyst is missing)')
rmSync(to, { recursive: true, force: true }); mkdirSync(to, { recursive: true })
cpSync(from, to, { recursive: true })
writeFileSync(join(to, 'client-package.json'), JSON.stringify({ name: 'billpoodum', version: '1.0.0', homepage: 'index.html' }, null, 2) + '\n')
console.log('Copied the app into catalyst/client (for web client hosting).')
