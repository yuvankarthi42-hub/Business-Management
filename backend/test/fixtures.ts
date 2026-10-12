import { startServer } from './helpers'

/** A server with one product admin and one customer whose owner is signed in. */
export async function withShop() {
  const s = await startServer()
  await s.call('admin.setup', 'test-setup-key-1234567890', { name: 'Admin', username: 'admin1', password: 'secret123' })
  const { token: adminToken } = await s.call<{ token: string }>('admin.login', 'admin1', 'secret123')
  s.setToken(adminToken)
  const cust = await s.call<{ id: string }>('admin.createCustomer', { businessName: 'Test Mart', ownerName: 'Lakshmi', username: 'lakshmi', password: 'shop1234', phone: '9876543210', validity: { months: 12 }, maxBranches: 3 })
  s.setToken(null)
  s.useShop(cust.id)
  const login = await s.call<{ token: string; branchId: string }>('auth.login', 'lakshmi', 'shop1234')
  s.setToken(login.token)
  return { ...s, adminToken, ownerToken: login.token, businessId: cust.id, mainBranch: login.branchId }
}
