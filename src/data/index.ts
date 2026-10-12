// Single switch-point for the data source.
//   VITE_BACKEND unset / 'mock' → the demo app: everything in this browser (src/data/api.ts), demo shops.
//   VITE_BACKEND = 'catalyst'   → the real backend on Zoho Catalyst (backend/), same `api` shape.
import { api as mockApi } from './api'
import { subscribe as mockSubscribe, getChangeVersion as mockVersion } from './db'
import { createRemoteApi } from './remote/api'
import { subscribe as remoteSubscribe, getChangeVersion as remoteVersion } from './remote/cache'

export const BACKEND: 'mock' | 'catalyst' = import.meta.env.VITE_BACKEND === 'catalyst' ? 'catalyst' : 'mock'
const remote = BACKEND === 'catalyst'

export const api = remote ? createRemoteApi(mockApi) : mockApi
export const subscribe = remote ? remoteSubscribe : mockSubscribe
export const getChangeVersion = remote ? remoteVersion : mockVersion

export { session, adminSession, ApiError, APP_VERSION } from './api'
export type { Api, OrderDraft, PaymentInput, Summary, CustomerStats, Session, CustomerRow, Validity, ExportBundle } from './api'
