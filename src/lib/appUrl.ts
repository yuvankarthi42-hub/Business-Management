// The app's own addresses. On hosts that only serve real files (Catalyst Slate), the build uses hash links
// (VITE_ROUTER=hash → https://site/#/login) so a refresh or a typed address never hits a missing file.
export const HASH_ROUTER = import.meta.env.VITE_ROUTER === 'hash'

/** https://site[/base][/#] — add a path like '/login'. */
export const appRoot = () => `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}${HASH_ROUTER ? '/#' : ''}`
export const appUrl = (path: string) => `${appRoot()}${path.startsWith('/') ? path : `/${path}`}`
