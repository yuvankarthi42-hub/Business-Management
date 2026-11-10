// Zoho Catalyst Advanced I/O function entry. Catalyst calls the exported Express app for every request
// to /server/api/… ; the SDK is initialised per request so it uses that request's project credentials.
import catalyst from 'zcatalyst-sdk-node'
import type { Request } from 'express'
import { createApp } from './app'
import { catalystEnv } from './catalystEnv'
import { warnIfNoPepper } from './core/passwords'

process.env.NODE_ENV ||= 'production' // unset or empty → production (never the development secrets)
warnIfNoPepper()

const app = createApp((req: Request) => catalystEnv(catalyst.initialize(req as never)))

module.exports = app
