/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'catalyst' = the real backend on Zoho Catalyst; unset = the demo app (data in this browser). */
  readonly VITE_BACKEND?: 'mock' | 'catalyst'
  /** API address (default /server/api — same site as the app on Catalyst). */
  readonly VITE_API_BASE?: string
}
