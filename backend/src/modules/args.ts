// Per-handler rules applied after every module is defined. What some handlers' arguments must be, checked before they run (core/registry.ts checkArgs): a missing object,
// or text where a list belongs, is a 400 "Check the request" instead of a crash (HTTP 500). Each list matches what
// the app sends; 'any' = the handler checks that one itself (ids → "not found"). Optional ones ('?') may be null.
import { setArgs, setOnce } from '../core/registry'

setArgs({
  // The main input is one object.
  'products.save': ['object'],
  'categories.save': ['object'],
  'customers.save': ['object'],
  'suppliers.save': ['object'],
  'tables.save': ['object'],
  'users.save': ['object'],
  'roles.save': ['object'],
  'branches.save': ['object'],
  'business.update': ['object'],
  'business.saveSetup': ['object'],
  'media.store': ['object'],
  'purchases.create': ['object'],
  'orders.save': ['object', 'object?'],
  'orders.list': ['object?'],
  'orders.checkout': ['object', 'any'], // payments: settle checks them ("Check the payment")
  'orders.cancel': ['any', 'text?'],
  'branches.savePrinter': ['any', 'object'],
  'staff.mark': ['any', 'any', 'object?'],
  'staff.markAll': ['any', 'list?'],
  'products.assignBarcodes': ['list?'],
  'products.page': ['number?'],
  'public.placeOrder': ['any', 'object'],
  'admin.updateCustomer': ['any', 'object'],
  'admin.renew': ['any', 'object', 'text?'],
  'admin.resetPassword': ['any', 'text'],
})

// Saved once per request id (K-7): the same request sent again gets the first answer, nothing is saved twice.
// (Bills, payments, returns, purchases and kitchen tickets already are, through their own client_uuid.)
setOnce(['inventory.adjust', 'expenses.save', 'products.save', 'staff.giveAdvance', 'customers.adjustPoints'])
