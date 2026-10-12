// Which database each table lives in when every shop has its own database (Turso).
//   platform DB : the product admin's data + the directory of shops + sign-in names
//   shop DB     : everything a shop owns (one database per shop)
//   both        : the same table in both — shop rows in the shop DB, platform rows (business_id NULL or
//                 product-admin owned) in the platform DB
// Every table not listed in PLATFORM or BOTH is a shop table. With a single database (Catalyst Data Store,
// tests) all tables are in the same place and this only decides which handle the code must use.
export const PLATFORM = [
  'platform_admins', 'platform_settings', 'plans', 'feature_flags', 'feature_flag_businesses', 'businesses',
  'subscription_periods', 'admin_audit_logs', 'support_tickets', 'ticket_messages', 'ticket_attachments',
  'login_names', 'shop_databases',
]
export const BOTH = ['media_files', 'secrets', 'whatsapp_templates', 'whatsapp_messages']
