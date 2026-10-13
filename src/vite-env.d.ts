/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'catalyst' = the real backend on Zoho Catalyst; unset = the demo app (data in this browser). */
  readonly VITE_BACKEND?: 'mock' | 'catalyst'
  /** API address (default /server/api — same site as the app on Catalyst). */
  readonly VITE_API_BASE?: string
  /** Landing page "Get your account" opens WhatsApp to this number (with country code, e.g. 919876543210). */
  readonly VITE_CONTACT_WHATSAPP?: string
}
