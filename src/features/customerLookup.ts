// Screens that show a few customers (the bills on screen, the one on the bill, the picker's search) read only those —
// not the whole customer list, which grows with the shop (several MB at 10,000 customers) and is read again after
// every bill with a customer. Rows are the same as customers.list gives. A server without these reads (an older
// one): the whole list, as before.
import { useData } from '@/app/AppContext'
import { api } from '@/data'

export type CustomerRow = Awaited<ReturnType<typeof api.customers.list>>[number]

const older = (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND'
const BY_IDS_MAX = 100

/** These customers (≤ 100 per read). */
export async function customersByIds(ids: (string | null | undefined)[]): Promise<CustomerRow[]> {
  const want = [...new Set(ids.filter((x): x is string => !!x))].sort()
  if (!want.length) return []
  try {
    const out: CustomerRow[] = []
    for (let i = 0; i < want.length; i += BY_IDS_MAX) out.push(...(await api.customers.byIds(want.slice(i, i + BY_IDS_MAX))))
    return out
  } catch (e) {
    if (!older(e)) throw e
    const set = new Set(want)
    return (await api.customers.list()).filter((c) => set.has(c.id))
  }
}

/** The picker's search (≤ 50): name contains the text, or the phone its digits. */
export async function searchCustomers(q: string): Promise<CustomerRow[]> {
  try {
    return await api.customers.search(q)
  } catch (e) {
    if (!older(e)) throw e
    const { phoneMatches } = await import('@/core/phone')
    const s = q.trim().toLowerCase()
    return (await api.customers.list()).filter((c) => !s || c.name.toLowerCase().includes(s) || phoneMatches(c.phone, s)).slice(0, 50)
  }
}

/** For a screen showing these customers: a lookup by id (undefined while they are read, or not found). */
export function useCustomerLookup(ids: (string | null | undefined)[]): (id: string | null | undefined) => CustomerRow | undefined {
  const key = [...new Set(ids.filter(Boolean))].sort().join(',')
  const { data = [] } = useData(() => customersByIds(key ? key.split(',') : []), [key])
  const byId = new Map(data.map((c) => [c.id, c]))
  return (id) => (id ? byId.get(id) : undefined)
}

/** One customer (the bill's): the row, null without one (or not found), undefined while it is read. */
export function useCustomer(id: string | null | undefined): CustomerRow | null | undefined {
  const { data, error } = useData(async (): Promise<{ id: string | null; c: CustomerRow | null }> => ({ id: id ?? null, c: id ? await api.customers.one(id) : null }), [id])
  if (!id) return null
  if (error) return null
  return data && data.id === id ? data.c : undefined
}
