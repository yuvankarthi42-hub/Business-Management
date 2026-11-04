/**
 * Outgoing requests made by this process (database round trips, WhatsApp sends), counted where they are sent.
 * The hourly daily-jobs run reads it to stop before a platform's per-run request limit (Cloudflare free: 50).
 * It counts every request in the process, so other work at the same moment only makes the run stop sooner.
 */
export const outgoing = { n: 0 }
export const countRequest = () => { outgoing.n++ }
