// Separate setups (account 1 = Catalyst + Turso, account 2 = Cloudflare + Turso) never mix. Each server may be given an
// ACCOUNT_ID (2–32 of a–z, 0–9, "-"). Then:
//   • every token it signs carries `acc` = that id, and a token carrying another id is refused (core/tokens.ts) — on
//     top of each setup having its own AUTH_SECRET, so even a copied secret can't sign someone into the other setup;
//   • signed file links include the id too;
//   • its platform database is labelled with the id the first time it is used ('account' in platform_settings) and a
//     server whose id differs from that label refuses every request — a Worker pointed at the other setup's Turso
//     by mistake stops at once instead of serving that setup's shops.
// Unset ACCOUNT_ID (the Catalyst setup as it runs today): nothing is checked, signed or read — exactly as before.
import type { Db } from '../db/types'
import { DuplicateError } from '../db/types'
import { ApiError } from './errors'

const ID = /^[a-z0-9-]{2,32}$/

/** This server's account id, or null when none is set. A malformed value stops the server (it would mislabel data). */
export function accountId(env: Record<string, string | undefined> = process.env): string | null {
  const v = String(env.ACCOUNT_ID ?? '').trim()
  if (!v) return null
  if (!ID.test(v)) throw new ApiError('Server is not configured (ACCOUNT_ID: 2–32 of a–z, 0–9, -)', 500, 'CONFIG')
  return v
}

/** Platform databases already checked by this instance (one read per database per instance, then nothing). */
const checked = new WeakMap<object, string>()

/** Refuses the request when this server's ACCOUNT_ID isn't the one its platform database is labelled with. */
export async function assertAccount(platform: Db): Promise<void> {
  const want = accountId()
  if (!want || checked.get(platform) === want) return
  let row = await platform.first('platform_settings', { setting_key: 'account' })
  if (!row) {
    try { await platform.insert('platform_settings', { setting_key: 'account', value_json: JSON.stringify({ id: want }) }) } catch (e) { if (!(e instanceof DuplicateError)) throw e }
    row = await platform.first('platform_settings', { setting_key: 'account' })
  }
  let have: unknown = null
  try { have = (JSON.parse(String(row?.value_json ?? '{}')) as { id?: unknown }).id } catch { /* unreadable label: refused below */ }
  if (have !== want) {
    console.error(`[account] ACCOUNT_ID "${want}" but the platform database belongs to "${String(have)}" — refusing every request`)
    throw new ApiError('Server is not configured (this server and its database belong to different accounts)', 500, 'CONFIG')
  }
  checked.set(platform, want)
}
