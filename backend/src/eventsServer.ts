// Catalyst AppSail entry: the event hub (live updates for open screens). Run ONE instance.
// Environment: AUTH_SECRET (same as the api function), EVENTS_SECRET (same as the api function), ALLOWED_ORIGINS.
// Production by default: without AUTH_SECRET the hub refuses tickets (never falls back to a development secret).
process.env.NODE_ENV ??= 'production'
import express from 'express'
import { Hub, hubRoutes } from './events/hub'

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)
const hub = new Hub()
app.use('/', hubRoutes(hub))
const port = Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT ?? process.env.PORT ?? 9000)
app.listen(port, () => console.log(`Kadai Kalanjiyam event hub on :${port}`))
