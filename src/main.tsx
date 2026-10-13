import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { HASH_ROUTER } from './lib/appUrl'
import './index.css'
import { AppProvider, useApp } from './app/AppContext'
import { AppLayout, useNavItems } from './app/Layout'
import { Spinner, ToastProvider } from './components/ui'
import { ChooseBranch } from './features/Branches'
import { ReadOnlyGate } from './features/SubscriptionBanner'
import { initDB } from './data/db'
import { api, BACKEND } from './data'
import { deviceLang, setLanguage } from './i18n'
import type { ModuleKey, Permission } from './core/types'

// Each page is its own chunk. Loaders are kept so the chunks can be fetched ahead of time.
const load = {
  Login: () => import('./pages/Login'),
  Landing: () => import('./pages/Landing'),
  Onboarding: () => import('./pages/Onboarding'),
  Dashboard: () => import('./pages/Dashboard'),
  Billing: () => import('./pages/Billing'),
  Orders: () => import('./pages/Orders'),
  Tables: () => import('./pages/Tables'),
  Kitchen: () => import('./pages/Kitchen'),
  MobileOrder: () => import('./pages/MobileOrder'),
  Products: () => import('./pages/Products'),
  Inventory: () => import('./pages/Inventory'),
  Customers: () => import('./pages/Customers'),
  Payments: () => import('./pages/Payments'),
  Expenses: () => import('./pages/Expenses'),
  Reports: () => import('./pages/Reports'),
  Staff: () => import('./pages/Staff'),
  Support: () => import('./pages/Support'),
  Settings: () => import('./pages/Settings'),
  Specials: () => import('./pages/Specials'),
  SpecialsDisplay: () => import('./pages/SpecialsDisplay'),
  QrOrders: () => import('./pages/QrOrders'),
  CustomerOrders: () => import('./pages/CustomerOrders'),
  CustomerMenu: () => import('./pages/CustomerMenu'),
  AdminLogin: () => import('./admin/AdminLogin'),
  AdminLayout: () => import('./admin/AdminLayout'),
  AdminCustomers: () => import('./admin/Customers'),
  AdminCustomerDetail: () => import('./admin/CustomerDetail'),
  AdminAudit: () => import('./admin/Audit'),
  AdminSettings: () => import('./admin/Settings'),
  AdminTeam: () => import('./admin/Team'),
  AdminReports: () => import('./admin/Reports'),
  AdminFeatures: () => import('./admin/Features'),
  AdminSupport: () => import('./admin/Support'),
  AdminRenewals: () => import('./admin/Renewals'),
  AdminWhatsApp: () => import('./admin/WhatsApp'),
}
const Login = lazy(load.Login)
const Landing = lazy(load.Landing)
const Onboarding = lazy(load.Onboarding)
const Dashboard = lazy(load.Dashboard)
const Billing = lazy(load.Billing)
const Orders = lazy(load.Orders)
const Tables = lazy(load.Tables)
const Kitchen = lazy(load.Kitchen)
const MobileOrder = lazy(load.MobileOrder)
const Products = lazy(load.Products)
const Inventory = lazy(load.Inventory)
const Customers = lazy(load.Customers)
const Payments = lazy(load.Payments)
const Expenses = lazy(load.Expenses)
const Reports = lazy(load.Reports)
const Staff = lazy(load.Staff)
const Support = lazy(load.Support)
const Settings = lazy(load.Settings)
const Specials = lazy(load.Specials)
const SpecialsDisplay = lazy(load.SpecialsDisplay)
const QrOrders = lazy(load.QrOrders)
const CustomerOrders = lazy(load.CustomerOrders)
const CustomerMenu = lazy(load.CustomerMenu)
const AdminLogin = lazy(load.AdminLogin)
const AdminLayout = lazy(load.AdminLayout)
const AdminCustomers = lazy(load.AdminCustomers)
const AdminCustomerDetail = lazy(load.AdminCustomerDetail)
const AdminAudit = lazy(load.AdminAudit)
const AdminSettings = lazy(load.AdminSettings)
const AdminTeam = lazy(load.AdminTeam)
const AdminReports = lazy(load.AdminReports)
const AdminFeatures = lazy(load.AdminFeatures)
const AdminSupportList = lazy(() => load.AdminSupport().then((m) => ({ default: m.AdminSupportList })))
const AdminSupportTicket = lazy(() => load.AdminSupport().then((m) => ({ default: m.AdminSupportTicket })))
const AdminRenewals = lazy(load.AdminRenewals)
const AdminWhatsApp = lazy(load.AdminWhatsApp)

/**
 * After the first screen is up, quietly download the other pages so the first click on a menu item
 * doesn't wait for the network. Admin pages only when the admin area is open.
 */
function preloadPages() {
  const admin = location.pathname.startsWith('/admin')
  // Most-used screens first; public / sign-in pages last.
  const LAST = ['Login', 'Landing', 'Onboarding', 'CustomerMenu', 'SpecialsDisplay']
  const names = (Object.keys(load) as (keyof typeof load)[])
    .filter((n) => n.startsWith('Admin') === admin)
    .sort((a, b) => Number(LAST.includes(a)) - Number(LAST.includes(b)))
  const idle = (cb: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(cb, { timeout: 1500 }) : setTimeout(cb, 300))
  const batch = async () => {
    for (let i = 0; i < names.length; i += 4) await Promise.all(names.slice(i, i + 4).map((n) => load[n]().catch(() => {})))
  }
  idle(() => { void batch() })
}

const isInstalledApp = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading } = useApp()
  const loc = useLocation()
  if (loading) return <Spinner />
  // Signed out at the home address: the landing page (the installed app goes straight to sign-in).
  if (!me && loc.pathname === '/' && !isInstalledApp()) return <Landing />
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />
  if (!me.business.onboarded && loc.pathname !== '/onboarding') return <Navigate to="/onboarding" replace />
  return <>{children}</>
}

/** Route-level guard: module must be enabled and the user must hold the permission. */
function Gate({ module, perm, branch, children }: { module?: ModuleKey; perm?: Permission | Permission[]; branch?: string; children: React.ReactNode }) {
  const { mod, can, me } = useApp()
  const ok = (!module || mod(module)) && (!perm || (Array.isArray(perm) ? perm.some(can) : can(perm)))
  if (!ok) return <Home />
  // Day-to-day pages work in one branch; "All branches" is a combined, read-only view.
  if (branch && me?.isAll) return <ChooseBranch what={branch} />
  return <>{children}</>
}

function Home() {
  const items = useNavItems()
  const { me } = useApp()
  // Waiters on a phone land straight in order-taking; everyone else on their first allowed page.
  const small = typeof window !== 'undefined' && window.innerWidth < 768
  const target = me?.role.name === 'Waiter' && small && items.some((i) => i.to === '/m/order') ? '/m/order' : items[0]?.to
  return target ? <Navigate to={target} replace /> : <div className="p-10 text-center text-slate-500">No modules are available for your role.</div>
}

function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/welcome" element={<Landing />} />
        {/* No public sign-up: the product admin creates customer accounts. */}
        <Route path="/signup" element={<Navigate to="/login" replace state={{ signup: true }} />} />
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminCustomers />} />
          <Route path="customers/:id" element={<AdminCustomerDetail />} />
          <Route path="audit" element={<AdminAudit />} />
          <Route path="settings" element={<AdminSettings />} />
          <Route path="team" element={<AdminTeam />} />
          <Route path="features" element={<AdminFeatures />} />
          <Route path="support" element={<AdminSupportList />} />
          <Route path="support/:id" element={<AdminSupportTicket />} />
          <Route path="renewals" element={<AdminRenewals />} />
          <Route path="whatsapp" element={<AdminWhatsApp />} />
          <Route path="reports" element={<AdminReports />} />
        </Route>
        {/* Public pages — no staff login */}
        <Route path="/q/:businessId" element={<CustomerMenu />} />
        <Route path="/display/:businessId" element={<SpecialsDisplay />} />
        <Route path="/onboarding" element={<RequireAuth><Onboarding /></RequireAuth>} />
        <Route path="/m/order" element={<RequireAuth><ReadOnlyGate><Gate module="mobileOrders" perm="tables.manage" branch="taking orders"><MobileOrder /></Gate></ReadOnlyGate></RequireAuth>} />
        <Route element={<RequireAuth><ReadOnlyGate><AppLayout /></ReadOnlyGate></RequireAuth>}>
          <Route path="/" element={<Home />} />
          <Route path="/dashboard" element={<Gate perm="dashboard.view"><Dashboard /></Gate>} />
          <Route path="/billing" element={<Gate branch="billing" module="billing" perm="billing.create"><Billing /></Gate>} />
          <Route path="/orders" element={<Gate module="orders" perm="orders.view"><Orders /></Gate>} />
          <Route path="/tables" element={<Gate branch="tables" module="tables" perm="tables.manage"><Tables /></Gate>} />
          <Route path="/customer-orders" element={<Gate branch="customer orders" module="customerOrders" perm="orders.view"><CustomerOrders /></Gate>} />
          <Route path="/qr-orders" element={<Gate branch="QR orders" module="qrOrdering" perm="tables.manage"><QrOrders /></Gate>} />
          <Route path="/specials" element={<Gate module="specials" perm="products.manage"><Specials /></Gate>} />
          <Route path="/kitchen" element={<Gate branch="the kitchen display" module="kitchen" perm="kitchen.view"><Kitchen /></Gate>} />
          <Route path="/products" element={<Gate perm="products.manage"><Products /></Gate>} />
          <Route path="/inventory" element={<Gate branch="stock" module="inventory" perm="inventory.manage"><Inventory /></Gate>} />
          <Route path="/customers" element={<Gate module="customers" perm="customers.manage"><Customers /></Gate>} />
          <Route path="/payments" element={<Gate module="payments" perm="payments.view"><Payments /></Gate>} />
          <Route path="/expenses" element={<Gate module="expenses" perm="expenses.manage"><Expenses /></Gate>} />
          <Route path="/reports" element={<Gate module="reports" perm="reports.view"><Reports /></Gate>} />
          <Route path="/staff" element={<Gate module="employees" perm="users.manage"><Staff /></Gate>} />
          <Route path="/support" element={<Support />} />
          <Route path="/settings/*" element={<Gate perm={['settings.manage', 'users.manage']}><Settings /></Gate>} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

// Slate and other file-only hosts: hash links (/#/login). An address typed without the hash (/login) is moved
// into it, and a hash link opened on a normal host is moved out of it — old links keep working both ways.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
if (HASH_ROUTER && !location.hash.startsWith('#/') && location.pathname !== `${BASE}/` && location.pathname !== BASE) {
  location.replace(`${location.origin}${BASE}/#${location.pathname.slice(BASE.length) || '/'}${location.search}`)
} else if (!HASH_ROUTER && location.hash.startsWith('#/')) {
  history.replaceState(null, '', `${BASE}${location.hash.slice(1)}`)
}
const FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true }
function Router({ children }: { children: React.ReactNode }) {
  return HASH_ROUTER
    ? <HashRouter future={FUTURE}>{children}</HashRouter>
    : <BrowserRouter basename={BASE || undefined} future={FUTURE}>{children}</BrowserRouter>
}

// Load the (mock) database first; every screen reads it synchronously after this.
// Demo app: load the in-browser database first. Catalyst: nothing to load — data comes from the server.
Promise.all([BACKEND === 'mock' ? initDB() : Promise.resolve(), setLanguage(deviceLang(), false)]).then(() => { if (BACKEND === 'mock') void api.system.runDailyJobs() /* on the server: a 9 AM cron */ }).then(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* v7_startTransition: keep the current page on screen while the next one loads (no blank flash). */}
    <Router>
      <ToastProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </ToastProvider>
    </Router>
  </React.StrictMode>,
))

// The app renders after the database loads, which can be after window 'load' — handle both.
if (document.readyState === 'complete') setTimeout(preloadPages, 500)
else window.addEventListener('load', () => setTimeout(preloadPages, 500))

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' }))
}

// A new version on the server while this browser still runs an old one (hosts like Slate tell browsers to keep
// files for a year): compare the app file named in the live index.html with ours, and reload once if different.
async function checkForNewVersion() {
  if (import.meta.env.DEV) return
  const mine = [...document.scripts].map((x) => x.src).find((src) => /\/assets\/index-[^/]+\.js$/.test(src))
  if (!mine) return
  const html = await fetch(`${BASE}/index.html`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null)).catch(() => null)
  const live = html?.match(/assets\/index-[^"']+\.js/)?.[0]
  if (!live || mine.endsWith(live)) return
  try { if (sessionStorage.getItem('billpoodum.reloadedFor') === live) return; sessionStorage.setItem('billpoodum.reloadedFor', live) } catch { return }
  location.reload()
}
window.addEventListener('load', () => { void checkForNewVersion() })
let lastCheck = Date.now()
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastCheck > 30 * 60_000) { lastCheck = Date.now(); void checkForNewVersion() }
})
