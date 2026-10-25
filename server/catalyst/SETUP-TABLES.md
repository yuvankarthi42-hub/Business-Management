# Catalyst Data Store — table setup checklist

Generated from `server/catalyst/schema.sql` by `backend/scripts/gen-checklist.mjs` — do not edit by hand.

Create the tables **in this order** (Catalyst console → Cloud Scale → Data Store → Create table), then add the columns
exactly as listed. ROWID, CREATORID, CREATEDTIME and MODIFIEDTIME are created by Catalyst automatically.
When done, open `https://<your-function-url>/server/api/schema-check` with the header `x-setup-key: <SETUP_KEY>`
(or Admin → Schema check) — it lists anything missing or different.

**62 tables · 661 columns.**

| Setting | Meaning |
|---|---|
| Mandatory | IsMandatory validator on |
| Unique | IsUnique on (cannot be changed later — get it right first time) |
| Search | Search Index on |
| PII | PII/ePHI validator on |
| FK → table (Cascade / Null) | Foreign Key: Parent Table = table, On Delete = Cascade / Null |

## 1. `platform_admins`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `name` | Var Char | 120 | ✔ |  |  |  |  |  |
| `username` | Var Char | 40 | ✔ | ✔ |  |  |  |  |
| `email` | Var Char | 150 |  |  |  |  |  | ✔ |
| `password_hash` | Var Char | 100 | ✔ |  |  |  |  |  |
| `token_version` | Int |  | ✔ |  | 1 |  |  |  |
| `failed_logins` | Int |  | ✔ |  | 0 |  |  |  |
| `locked_until` | DateTime |  |  |  |  |  |  |  |
| `role` | Int |  | ✔ |  |  |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |
| `last_login_at` | DateTime |  |  |  |  |  |  |  |

## 2. `plans`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `code` | Var Char | 30 | ✔ | ✔ |  |  |  |  |
| `name` | Var Char | 80 | ✔ |  |  |  |  |  |
| `price_per_branch_month_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `features_json` | Text |  |  |  |  |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |

## 3. `platform_settings`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `setting_key` | Var Char | 60 | ✔ | ✔ |  |  |  |  |
| `value_json` | Text |  | ✔ |  |  |  |  |  |
| `schema_version` | Int |  | ✔ |  | 1 |  |  |  |
| `updated_by` | Foreign Key |  |  |  |  | → `platform_admins` (Null) |  |  |

## 4. `feature_flags`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `feature_key` | Var Char | 40 | ✔ | ✔ |  |  |  |  |
| `name` | Var Char | 80 | ✔ |  |  |  |  |  |
| `rollout` | Int |  | ✔ |  | 1 |  |  |  |
| `description` | Var Char | 255 |  |  |  |  |  |  |
| `updated_by` | Foreign Key |  |  |  |  | → `platform_admins` (Null) |  |  |

## 5. `businesses`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `name` | Var Char | 150 | ✔ |  |  |  | ✔ |  |
| `category` | Int |  | ✔ |  |  |  |  |  |
| `sub_type` | Var Char | 60 | ✔ |  |  |  |  |  |
| `phone` | Var Char | 16 |  |  |  |  | ✔ | ✔ |
| `email` | Var Char | 150 |  |  |  |  |  | ✔ |
| `address` | Var Char | 255 |  |  |  |  |  |  |
| `city` | Var Char | 80 |  |  |  |  |  |  |
| `state` | Var Char | 80 |  |  |  |  |  |  |
| `country_code` | Var Char | 2 | ✔ |  | IN |  |  |  |
| `currency_code` | Var Char | 3 | ✔ |  | INR |  |  |  |
| `currency_symbol` | Var Char | 5 | ✔ |  | ₹ |  |  |  |
| `timezone` | Var Char | 40 | ✔ |  | Asia/Kolkata |  |  |  |
| `gstin` | Var Char | 15 |  |  |  |  |  |  |
| `logo_media_id` | BigInt |  |  |  |  |  |  |  |
| `status` | Int |  | ✔ |  | 1 |  |  |  |
| `plan_id` | Foreign Key |  |  |  |  | → `plans` (Null) |  |  |
| `max_branches` | Int |  | ✔ |  | 1 |  |  |  |
| `subscription_start_at` | DateTime |  |  |  |  |  |  |  |
| `subscription_end_at` | DateTime |  |  |  |  |  |  |  |
| `reminders_paused` | Boolean |  | ✔ |  | false |  |  |  |
| `admin_note` | Var Char | 255 |  |  |  |  |  |  |
| `onboarded_at` | DateTime |  |  |  |  |  |  |  |
| `deleted_at` | DateTime |  |  |  |  |  |  |  |
| `owner_user_id` | BigInt |  |  |  |  |  |  |  |
| `owner_name` | Var Char | 120 |  |  |  |  |  |  |
| `owner_username` | Var Char | 40 |  |  |  |  |  |  |
| `owner_phone` | Var Char | 16 |  |  |  |  |  | ✔ |
| `owner_email` | Var Char | 150 |  |  |  |  |  | ✔ |
| `branches_used` | Int |  | ✔ |  | 1 |  |  |  |
| `last_login_at` | DateTime |  |  |  |  |  |  |  |
| `last_activity_at` | DateTime |  |  |  |  |  |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 6. `secrets`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `owner_type` | Int |  | ✔ |  |  |  |  |  |
| `business_id` | Foreign Key |  |  |  |  | → `businesses` (Cascade) |  |  |
| `kind` | Int |  | ✔ |  |  |  |  |  |
| `value` | Encrypted text |  | ✔ |  |  |  |  |  |
| `last4` | Var Char | 4 |  |  |  |  |  |  |
| `uniq_key` | Var Char | 120 | ✔ | ✔ |  |  |  |  |

## 7. `subscription_periods`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `kind` | Int |  | ✔ |  |  |  |  |  |
| `start_at` | DateTime |  | ✔ |  |  |  |  |  |
| `end_at` | DateTime |  | ✔ |  |  |  |  |  |
| `months` | Int |  |  |  |  |  |  |  |
| `branches` | Int |  | ✔ |  |  |  |  |  |
| `price_per_branch_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `amount_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `payment_ref` | Var Char | 80 |  |  |  |  |  |  |
| `note` | Var Char | 255 |  |  |  |  |  |  |
| `admin_id` | Foreign Key |  |  |  |  | → `platform_admins` (Null) |  |  |

## 8. `feature_flag_businesses`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `feature_flag_id` | Foreign Key |  | ✔ |  |  | → `feature_flags` (Cascade) |  |  |
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `uniq_key` | Var Char | 60 | ✔ | ✔ |  |  |  |  |

## 9. `branches`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `name` | Var Char | 120 | ✔ |  |  |  |  |  |
| `code` | Var Char | 10 |  |  |  |  |  |  |
| `address` | Var Char | 255 |  |  |  |  |  |  |
| `phone` | Var Char | 16 |  |  |  |  |  | ✔ |
| `gstin` | Var Char | 15 |  |  |  |  |  |  |
| `is_default` | Boolean |  | ✔ |  | false |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |
| `invoice_prefix` | Var Char | 10 |  |  |  |  |  |  |
| `printer_json` | Text |  |  |  |  |  |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 10. `roles`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `name` | Var Char | 60 | ✔ |  |  |  |  |  |
| `system_key` | Int |  |  |  |  |  |  |  |
| `is_all_access` | Boolean |  | ✔ |  | false |  |  |  |
| `uniq_key` | Var Char | 100 | ✔ | ✔ |  |  |  |  |

## 11. `tax_rates`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `name` | Var Char | 40 | ✔ |  |  |  |  |  |
| `rate_bp` | Int |  | ✔ |  |  |  |  |  |
| `is_inclusive` | Boolean |  | ✔ |  | false |  |  |  |
| `is_default` | Boolean |  | ✔ |  | false |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |

## 12. `price_lists`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `name` | Var Char | 60 | ✔ |  |  |  |  |  |
| `is_default` | Boolean |  | ✔ |  | false |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |
| `uniq_key` | Var Char | 100 | ✔ | ✔ |  |  |  |  |

## 13. `suppliers`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `name` | Var Char | 150 | ✔ |  |  |  | ✔ |  |
| `phone` | Var Char | 16 |  |  |  |  | ✔ | ✔ |
| `gstin` | Var Char | 15 |  |  |  |  |  |  |
| `address` | Var Char | 255 |  |  |  |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |
| `state_code` | Var Char | 2 |  |  |  |  |  |  |
| `opening_balance_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `notes` | Var Char | 255 |  |  |  |  |  |  |
| `name_key` | Var Char | 200 |  |  |  |  |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 14. `expense_categories`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `name` | Var Char | 60 | ✔ |  |  |  |  |  |
| `system_key` | Int |  |  |  |  |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |
| `uniq_key` | Var Char | 100 | ✔ | ✔ |  |  |  |  |

## 15. `whatsapp_templates`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  |  |  |  | → `businesses` (Cascade) |  |  |
| `kind` | Int |  | ✔ |  |  |  |  |  |
| `language` | Var Char | 5 | ✔ |  |  |  |  |  |
| `body` | Text |  | ✔ |  |  |  |  |  |
| `attach` | Boolean |  | ✔ |  | false |  |  |  |
| `meta_template_name` | Var Char | 80 |  |  |  |  |  |  |
| `status` | Int |  | ✔ |  | 1 |  |  |  |
| `reject_reason` | Var Char | 255 |  |  |  |  |  |  |
| `submitted_at` | DateTime |  |  |  |  |  |  |  |
| `approved_at` | DateTime |  |  |  |  |  |  |  |
| `uniq_key` | Var Char | 60 | ✔ | ✔ |  |  |  |  |

## 16. `admin_audit_logs`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `admin_id` | Foreign Key |  |  |  |  | → `platform_admins` (Null) |  |  |
| `admin_name` | Var Char | 120 | ✔ |  |  |  |  |  |
| `business_id` | Foreign Key |  |  |  |  | → `businesses` (Null) |  |  |
| `business_name` | Var Char | 150 |  |  |  |  |  |  |
| `action` | Int |  | ✔ |  |  |  |  |  |
| `detail` | Var Char | 255 |  |  |  |  |  |  |
| `ip` | Var Char | 45 |  |  |  |  |  |  |

## 17. `login_names`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `login` | Var Char | 160 | ✔ | ✔ |  |  |  |  |
| `kind` | Int |  | ✔ |  |  |  |  |  |
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `user_id` | BigInt |  | ✔ |  |  |  |  |  |

## 18. `shop_databases`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ | ✔ |  | → `businesses` (Cascade) |  |  |
| `db_name` | Var Char | 64 | ✔ | ✔ |  |  |  |  |
| `db_url` | Var Char | 255 |  |  |  |  |  |  |
| `db_token` | Encrypted text |  |  |  |  |  |  |  |
| `schema_version` | Var Char | 40 |  |  |  |  |  |  |
| `status` | Int |  | ✔ |  | 1 |  |  |  |

## 19. `sequences`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  |  |  |  | → `branches` (Cascade) |  |  |
| `name` | Int |  | ✔ |  |  |  |  |  |
| `prefix` | Var Char | 20 | ✔ |  |  |  |  |  |
| `next_value` | BigInt |  | ✔ |  | 1 |  |  |  |
| `fiscal_year` | Var Char | 9 |  |  |  |  |  |  |
| `uniq_key` | Var Char | 80 | ✔ | ✔ |  |  |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 20. `devices`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `name` | Var Char | 80 | ✔ |  |  |  |  |  |
| `kind` | Int |  | ✔ |  |  |  |  |  |
| `device_uuid` | Var Char | 40 | ✔ | ✔ |  |  |  |  |
| `platform` | Int |  |  |  |  |  |  |  |
| `app_version` | Var Char | 20 |  |  |  |  |  |  |
| `last_seen_at` | DateTime |  |  |  |  |  |  |  |
| `last_sync_at` | DateTime |  |  |  |  |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |

## 21. `role_permissions`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `role_id` | Foreign Key |  | ✔ |  |  | → `roles` (Cascade) |  |  |
| `permission` | Var Char | 40 | ✔ |  |  |  |  |  |
| `uniq_key` | Var Char | 80 | ✔ | ✔ |  |  |  |  |

## 22. `users`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `role_id` | Foreign Key |  |  |  |  | → `roles` (Null) |  |  |
| `default_branch_id` | Foreign Key |  |  |  |  | → `branches` (Null) |  |  |
| `name` | Var Char | 120 | ✔ |  |  |  | ✔ |  |
| `phone` | Var Char | 16 | ✔ | ✔ |  |  | ✔ | ✔ |
| `email` | Var Char | 150 |  |  |  |  |  | ✔ |
| `username` | Var Char | 40 |  | ✔ |  |  |  |  |
| `catalyst_user_id` | BigInt |  |  | ✔ |  |  |  |  |
| `password_hash` | Var Char | 100 |  |  |  |  |  |  |
| `can_login` | Boolean |  | ✔ |  | true |  |  |  |
| `must_change_password` | Boolean |  | ✔ |  | true |  |  |  |
| `password_changed_at` | DateTime |  |  |  |  |  |  |  |
| `failed_logins` | Int |  | ✔ |  | 0 |  |  |  |
| `locked_until` | DateTime |  |  |  |  |  |  |  |
| `token_version` | Int |  | ✔ |  | 1 |  |  |  |
| `language` | Var Char | 5 | ✔ |  | en |  |  |  |
| `pin_hash` | Var Char | 100 |  |  |  |  |  |  |
| `pay_type` | Int |  |  |  |  |  |  |  |
| `pay_amount_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `commission_bp` | Int |  | ✔ |  | 0 |  |  |  |
| `joined_on` | Date |  |  |  |  |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |
| `last_login_at` | DateTime |  |  |  |  |  |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 23. `customers`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `name` | Var Char | 120 | ✔ |  |  |  | ✔ | ✔ |
| `phone` | Var Char | 16 |  |  |  |  | ✔ | ✔ |
| `phone_key` | Var Char | 60 |  | ✔ |  |  |  |  |
| `email` | Var Char | 150 |  |  |  |  |  | ✔ |
| `address` | Var Char | 255 |  |  |  |  |  | ✔ |
| `gstin` | Var Char | 15 |  |  |  |  |  |  |
| `price_list_id` | Foreign Key |  |  |  |  | → `price_lists` (Null) |  |  |
| `credit_limit_minor` | BigInt |  |  |  |  |  |  |  |
| `marketing_opt_in` | Boolean |  | ✔ |  | true |  |  |  |
| `notes` | Var Char | 255 |  |  |  |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |
| `state_code` | Var Char | 2 |  |  |  |  |  |  |
| `points_balance` | Int |  | ✔ |  | 0 |  |  |  |

## 24. `dining_tables`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `label` | Var Char | 20 | ✔ |  |  |  |  |  |
| `area` | Var Char | 40 |  |  |  |  |  |  |
| `seats` | Int |  | ✔ |  | 4 |  |  |  |
| `qr_token` | Var Char | 40 |  | ✔ |  |  |  |  |
| `merged_into_id` | Foreign Key |  |  |  |  | → `dining_tables` (Null) |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |
| `uniq_key` | Var Char | 80 | ✔ | ✔ |  |  |  |  |

## 25. `whatsapp_accounts`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ | ✔ |  | → `businesses` (Cascade) |  |  |
| `provider` | Int |  | ✔ |  | 1 |  |  |  |
| `business_number` | Var Char | 16 |  |  |  |  |  |  |
| `waba_id` | Var Char | 25 |  |  |  |  |  |  |
| `phone_number_id` | Var Char | 25 |  |  |  |  |  |  |
| `secret_id` | Foreign Key |  |  |  |  | → `secrets` (Null) |  |  |
| `verified_name` | Var Char | 120 |  |  |  |  |  |  |
| `quality` | Int |  |  |  |  |  |  |  |
| `verified_at` | DateTime |  |  |  |  |  |  |  |
| `auto_send_bill` | Boolean |  | ✔ |  | false |  |  |  |
| `setup_done_at` | DateTime |  |  |  |  |  |  |  |
| `status` | Int |  | ✔ |  | 1 |  |  |  |

## 26. `business_settings`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `setting_key` | Var Char | 40 | ✔ |  |  |  |  |  |
| `value_json` | Text |  | ✔ |  |  |  |  |  |
| `schema_version` | Int |  | ✔ |  | 1 |  |  |  |
| `uniq_key` | Var Char | 80 | ✔ | ✔ |  |  |  |  |
| `updated_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |

## 27. `media_files`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  |  |  |  | → `businesses` (Cascade) |  |  |
| `purpose` | Int |  | ✔ |  |  |  |  |  |
| `bucket` | Var Char | 60 | ✔ |  |  |  |  |  |
| `object_key` | Var Char | 255 | ✔ | ✔ |  |  |  |  |
| `thumb_key` | Var Char | 255 |  |  |  |  |  |  |
| `content_type` | Var Char | 40 | ✔ |  |  |  |  |  |
| `bytes` | BigInt |  | ✔ |  |  |  |  |  |
| `width` | Int |  |  |  |  |  |  |  |
| `height` | Int |  |  |  |  |  |  |  |
| `original_bytes` | BigInt |  |  |  |  |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |

## 28. `user_branches`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `user_id` | Foreign Key |  | ✔ |  |  | → `users` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `uniq_key` | Var Char | 60 | ✔ | ✔ |  |  |  |  |

## 29. `purchases`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `supplier_id` | Foreign Key |  |  |  |  | → `suppliers` (Null) |  |  |
| `number` | Var Char | 30 | ✔ |  |  |  |  |  |
| `supplier_bill_no` | Var Char | 40 |  |  |  |  |  |  |
| `purchase_date` | Date |  | ✔ |  |  |  |  |  |
| `subtotal_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `tax_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `total_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `paid_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `status` | Int |  | ✔ |  | 2 |  |  |  |
| `note` | Var Char | 255 |  |  |  |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `client_uuid` | Var Char | 40 |  |  |  |  |  |  |
| `is_igst` | Boolean |  | ✔ |  | false |  |  |  |
| `round_off_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `void_reason` | Var Char | 255 |  |  |  |  |  |  |
| `voided_at` | DateTime |  |  |  |  |  |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 30. `orders`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `device_id` | Foreign Key |  |  |  |  | → `devices` (Null) |  |  |
| `client_uuid` | Var Char | 40 | ✔ | ✔ |  |  |  |  |
| `order_number` | Var Char | 30 | ✔ |  |  |  |  |  |
| `invoice_number` | Var Char | 30 |  |  |  |  |  |  |
| `invoice_key` | Var Char | 80 |  | ✔ |  |  |  |  |
| `order_type` | Int |  | ✔ |  |  |  |  |  |
| `source` | Int |  | ✔ |  | 1 |  |  |  |
| `status` | Int |  | ✔ |  |  |  |  |  |
| `table_id` | Foreign Key |  |  |  |  | → `dining_tables` (Null) |  |  |
| `customer_id` | Foreign Key |  |  |  |  | → `customers` (Null) |  |  |
| `customer_name` | Var Char | 120 |  |  |  |  |  | ✔ |
| `customer_phone` | Var Char | 16 |  |  |  |  |  | ✔ |
| `customer_address` | Var Char | 255 |  |  |  |  |  | ✔ |
| `qr_status` | Int |  |  |  |  |  |  |  |
| `fulfilment` | Int |  |  |  |  |  |  |  |
| `price_list_id` | Foreign Key |  |  |  |  | → `price_lists` (Null) |  |  |
| `guests` | Int |  |  |  |  |  |  |  |
| `subtotal_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `discount_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `discount_note` | Var Char | 100 |  |  |  |  |  |  |
| `tax_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `service_charge_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `round_off_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `total_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `paid_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `balance_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `returned_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `tax_breakup_json` | Text |  |  |  |  |  |  |  |
| `note` | Var Char | 255 |  |  |  |  |  |  |
| `billed_at` | DateTime |  |  |  |  |  |  |  |
| `cancelled_at` | DateTime |  |  |  |  |  |  |  |
| `cancel_reason` | Var Char | 255 |  |  |  |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `salesperson_id` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `customer_gstin` | Var Char | 15 |  |  |  |  |  |  |
| `place_of_supply` | Var Char | 2 |  |  |  |  |  |  |
| `is_igst` | Boolean |  | ✔ |  | false |  |  |  |
| `points_redeemed` | Int |  | ✔ |  | 0 |  |  |  |
| `points_value_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `points_earned` | Int |  | ✔ |  | 0 |  |  |  |
| `points_balance_after` | Int |  |  |  |  |  |  |  |
| `updated_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 31. `expenses`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `category_id` | Foreign Key |  |  |  |  | → `expense_categories` (Null) |  |  |
| `expense_date` | DateTime |  | ✔ |  |  |  |  |  |
| `amount_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `method` | Int |  | ✔ |  |  |  |  |  |
| `notes` | Var Char | 255 |  |  |  |  |  |  |
| `ref_type` | Int |  |  |  |  |  |  |  |
| `ref_id` | BigInt |  |  |  |  |  |  |  |
| `is_voided` | Boolean |  | ✔ |  | false |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |

## 32. `attendance`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `user_id` | Foreign Key |  | ✔ |  |  | → `users` (Cascade) |  |  |
| `work_date` | Date |  | ✔ |  |  |  |  |  |
| `status` | Int |  | ✔ |  |  |  |  |  |
| `in_time` | Var Char | 5 |  |  |  |  |  |  |
| `out_time` | Var Char | 5 |  |  |  |  |  |  |
| `note` | Var Char | 150 |  |  |  |  |  |  |
| `marked_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `uniq_key` | Var Char | 60 | ✔ | ✔ |  |  |  |  |

## 33. `support_tickets`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `user_id` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `number` | Var Char | 20 | ✔ | ✔ |  |  |  |  |
| `subject` | Var Char | 120 | ✔ |  |  |  | ✔ |  |
| `category` | Int |  | ✔ |  |  |  |  |  |
| `priority` | Int |  | ✔ |  | 2 |  |  |  |
| `status` | Int |  | ✔ |  | 1 |  |  |  |
| `assigned_to` | Foreign Key |  |  |  |  | → `platform_admins` (Null) |  |  |
| `page` | Var Char | 200 |  |  |  |  |  |  |
| `browser` | Var Char | 255 |  |  |  |  |  |  |
| `app_version` | Var Char | 20 |  |  |  |  |  |  |
| `device_id` | Foreign Key |  |  |  |  | → `devices` (Null) |  |  |
| `user_name` | Var Char | 120 |  |  |  |  |  |  |
| `user_phone` | Var Char | 16 |  |  |  |  |  | ✔ |
| `unread_for_admin` | Boolean |  | ✔ |  | true |  |  |  |
| `unread_for_customer` | Boolean |  | ✔ |  | false |  |  |  |
| `last_message_at` | DateTime |  | ✔ |  |  |  |  |  |
| `resolved_at` | DateTime |  |  |  |  |  |  |  |

## 34. `audit_logs`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  |  |  |  | → `branches` (Null) |  |  |
| `user_id` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `support_admin_id` | Foreign Key |  |  |  |  | → `platform_admins` (Null) |  |  |
| `entity` | Int |  | ✔ |  |  |  |  |  |
| `entity_id` | BigInt |  |  |  |  |  |  |  |
| `action` | Int |  | ✔ |  |  |  |  |  |
| `detail` | Var Char | 255 |  |  |  |  |  |  |
| `changes_json` | Text |  |  |  |  |  |  |  |

## 35. `categories`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `parent_id` | Foreign Key |  |  |  |  | → `categories` (Null) |  |  |
| `name` | Var Char | 80 | ✔ |  |  |  | ✔ |  |
| `emoji` | Var Char | 8 |  |  |  |  |  |  |
| `image_media_id` | Foreign Key |  |  |  |  | → `media_files` (Null) |  |  |
| `hsn_code` | Var Char | 10 |  |  |  |  |  |  |
| `sort_order` | Int |  | ✔ |  | 0 |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |
| `uniq_key` | Var Char | 120 | ✔ | ✔ |  |  |  |  |

## 36. `supplier_payments`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `supplier_id` | Foreign Key |  | ✔ |  |  | → `suppliers` (Cascade) |  |  |
| `purchase_id` | Foreign Key |  |  |  |  | → `purchases` (Null) |  |  |
| `client_uuid` | Var Char | 40 | ✔ | ✔ |  |  |  |  |
| `method` | Int |  | ✔ |  |  |  |  |  |
| `amount_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `paid_on` | Date |  | ✔ |  |  |  |  |  |
| `reference` | Var Char | 80 |  |  |  |  |  |  |
| `note` | Var Char | 255 |  |  |  |  |  |  |
| `is_voided` | Boolean |  | ✔ |  | false |  |  |  |
| `voided_at` | DateTime |  |  |  |  |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |

## 37. `sale_returns`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `order_id` | Foreign Key |  |  |  |  | → `orders` (Null) |  |  |
| `customer_id` | Foreign Key |  |  |  |  | → `customers` (Null) |  |  |
| `client_uuid` | Var Char | 40 | ✔ | ✔ |  |  |  |  |
| `number` | Var Char | 30 | ✔ |  |  |  |  |  |
| `number_key` | Var Char | 80 | ✔ | ✔ |  |  |  |  |
| `invoice_number` | Var Char | 30 | ✔ |  |  |  |  |  |
| `reason` | Int |  | ✔ |  |  |  |  |  |
| `settle` | Int |  | ✔ |  |  |  |  |  |
| `note` | Var Char | 255 |  |  |  |  |  |  |
| `total_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `tax_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `due_adjusted_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `refunded_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `refund_method` | Int |  |  |  |  |  |  |  |
| `credit_issued_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `credit_remaining_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `credit_expires_on` | Date |  |  |  |  |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 38. `kitchen_tickets`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `order_id` | Foreign Key |  | ✔ |  |  | → `orders` (Cascade) |  |  |
| `client_uuid` | Var Char | 40 | ✔ | ✔ |  |  |  |  |
| `number` | Var Char | 20 | ✔ |  |  |  |  |  |
| `order_number` | Var Char | 30 | ✔ |  |  |  |  |  |
| `order_type` | Int |  | ✔ |  |  |  |  |  |
| `station` | Var Char | 30 |  |  |  |  |  |  |
| `status` | Int |  | ✔ |  | 1 |  |  |  |
| `table_label` | Var Char | 20 |  |  |  |  |  |  |
| `started_at` | DateTime |  |  |  |  |  |  |  |
| `ready_at` | DateTime |  |  |  |  |  |  |  |
| `completed_at` | DateTime |  |  |  |  |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 39. `push_subscriptions`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `order_id` | Foreign Key |  | ✔ |  |  | → `orders` (Cascade) |  |  |
| `endpoint` | Var Char | 500 | ✔ |  |  |  |  |  |
| `p256dh` | Var Char | 120 | ✔ |  |  |  |  |  |
| `auth_secret` | Var Char | 40 | ✔ |  |  |  |  |  |
| `uniq_key` | Var Char | 80 | ✔ | ✔ |  |  |  |  |
| `last_stamp` | Var Char | 40 |  |  |  |  |  |  |
| `expires_at` | DateTime |  | ✔ |  |  |  |  |  |

## 40. `salary_payments`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `user_id` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `month` | Var Char | 7 | ✔ |  |  |  |  |  |
| `pay_type` | Int |  | ✔ |  |  |  |  |  |
| `rate_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `days_in_month` | Int |  | ✔ |  |  |  |  |  |
| `present_days` | Int |  | ✔ |  | 0 |  |  |  |
| `half_days` | Int |  | ✔ |  | 0 |  |  |  |
| `leave_days` | Int |  | ✔ |  | 0 |  |  |  |
| `absent_days` | Int |  | ✔ |  | 0 |  |  |  |
| `unmarked_days` | Int |  | ✔ |  | 0 |  |  |  |
| `commission_sales_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `base_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `commission_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `bonus_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `deduction_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `advances_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `net_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `method` | Int |  | ✔ |  |  |  |  |  |
| `note` | Var Char | 150 |  |  |  |  |  |  |
| `expense_id` | Foreign Key |  |  |  |  | → `expenses` (Null) |  |  |
| `paid_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `uniq_key` | Var Char | 40 | ✔ | ✔ |  |  |  |  |

## 41. `campaigns`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `channel` | Int |  | ✔ |  | 1 |  |  |  |
| `campaign_date` | Date |  | ✔ |  |  |  |  |  |
| `message` | Text |  | ✔ |  |  |  |  |  |
| `product_ids_json` | Text |  |  |  |  |  |  |  |
| `poster_media_id` | Foreign Key |  |  |  |  | → `media_files` (Null) |  |  |
| `sent_count` | Int |  | ✔ |  | 0 |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |

## 42. `ticket_messages`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `ticket_id` | Foreign Key |  | ✔ |  |  | → `support_tickets` (Cascade) |  |  |
| `from_side` | Int |  | ✔ |  |  |  |  |  |
| `user_id` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `admin_id` | Foreign Key |  |  |  |  | → `platform_admins` (Null) |  |  |
| `author_name` | Var Char | 120 | ✔ |  |  |  |  |  |
| `body` | Text |  |  |  |  |  |  |  |

## 43. `products`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `category_id` | Foreign Key |  |  |  |  | → `categories` (Null) |  |  |
| `tax_rate_id` | Foreign Key |  |  |  |  | → `tax_rates` (Null) |  |  |
| `name` | Var Char | 150 | ✔ |  |  |  | ✔ |  |
| `name_local` | Var Char | 150 |  |  |  |  | ✔ |  |
| `kind` | Int |  | ✔ |  | 1 |  |  |  |
| `sku` | Var Char | 40 |  |  |  |  |  |  |
| `barcode` | Var Char | 40 |  |  |  |  | ✔ |  |
| `barcode_key` | Var Char | 80 |  | ✔ |  |  |  |  |
| `hsn_code` | Var Char | 10 |  |  |  |  |  |  |
| `unit` | Var Char | 10 | ✔ |  | pc |  |  |  |
| `price_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `mrp_minor` | BigInt |  |  |  |  |  |  |  |
| `cost_minor` | BigInt |  |  |  |  |  |  |  |
| `is_veg` | Boolean |  |  |  |  |  |  |  |
| `sends_to_kitchen` | Boolean |  | ✔ |  | true |  |  |  |
| `track_stock` | Boolean |  | ✔ |  | false |  |  |  |
| `track_batches` | Boolean |  | ✔ |  | false |  |  |  |
| `low_stock_milli` | BigInt |  | ✔ |  | 0 |  |  |  |
| `image_media_id` | Foreign Key |  |  |  |  | → `media_files` (Null) |  |  |
| `emoji` | Var Char | 8 |  |  |  |  |  |  |
| `details_json` | Text |  |  |  |  |  |  |  |
| `sort_order` | Int |  | ✔ |  | 0 |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 44. `customer_points`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  |  |  |  | → `branches` (Null) |  |  |
| `customer_id` | Foreign Key |  | ✔ |  |  | → `customers` (Cascade) |  |  |
| `order_id` | Foreign Key |  |  |  |  | → `orders` (Null) |  |  |
| `return_id` | Foreign Key |  |  |  |  | → `sale_returns` (Null) |  |  |
| `kind` | Int |  | ✔ |  |  |  |  |  |
| `points` | Int |  | ✔ |  |  |  |  |  |
| `balance_after` | Int |  | ✔ |  |  |  |  |  |
| `remaining` | Int |  | ✔ |  | 0 |  |  |  |
| `expires_on` | Date |  |  |  |  |  |  |  |
| `note` | Var Char | 150 |  |  |  |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |

## 45. `payments`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `order_id` | Foreign Key |  |  |  |  | → `orders` (Null) |  |  |
| `customer_id` | Foreign Key |  |  |  |  | → `customers` (Null) |  |  |
| `return_id` | Foreign Key |  |  |  |  | → `sale_returns` (Null) |  |  |
| `client_uuid` | Var Char | 40 | ✔ | ✔ |  |  |  |  |
| `kind` | Int |  | ✔ |  |  |  |  |  |
| `method` | Int |  | ✔ |  |  |  |  |  |
| `amount_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `reference` | Var Char | 80 |  |  |  |  |  |  |
| `is_voided` | Boolean |  | ✔ |  | false |  |  |  |
| `voided_at` | DateTime |  |  |  |  |  |  |  |
| `void_reason` | Var Char | 255 |  |  |  |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |

## 46. `staff_advances`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `user_id` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |
| `amount_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `method` | Int |  | ✔ |  |  |  |  |  |
| `given_on` | Date |  | ✔ |  |  |  |  |  |
| `note` | Var Char | 150 |  |  |  |  |  |  |
| `expense_id` | Foreign Key |  |  |  |  | → `expenses` (Null) |  |  |
| `salary_payment_id` | Foreign Key |  |  |  |  | → `salary_payments` (Null) |  |  |
| `given_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |

## 47. `whatsapp_messages`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  |  |  |  | → `businesses` (Cascade) |  |  |
| `sender` | Int |  | ✔ |  |  |  |  |  |
| `kind` | Int |  | ✔ |  |  |  |  |  |
| `to_number` | Var Char | 16 | ✔ |  |  |  |  | ✔ |
| `customer_id` | Foreign Key |  |  |  |  | → `customers` (Null) |  |  |
| `order_id` | Foreign Key |  |  |  |  | → `orders` (Null) |  |  |
| `campaign_id` | Foreign Key |  |  |  |  | → `campaigns` (Null) |  |  |
| `template_id` | Foreign Key |  |  |  |  | → `whatsapp_templates` (Null) |  |  |
| `body` | Text |  | ✔ |  |  |  |  |  |
| `attachment_media_id` | Foreign Key |  |  |  |  | → `media_files` (Null) |  |  |
| `meta_message_id` | Var Char | 80 |  | ✔ |  |  |  |  |
| `status` | Int |  | ✔ |  | 1 |  |  |  |
| `error` | Var Char | 255 |  |  |  |  |  |  |
| `status_at` | DateTime |  |  |  |  |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |

## 48. `ticket_attachments`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `message_id` | Foreign Key |  | ✔ |  |  | → `ticket_messages` (Cascade) |  |  |
| `media_id` | Foreign Key |  | ✔ |  |  | → `media_files` (Cascade) |  |  |
| `sort_order` | Int |  | ✔ |  | 0 |  |  |  |

## 49. `product_variants`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `product_id` | Foreign Key |  | ✔ |  |  | → `products` (Cascade) |  |  |
| `name` | Var Char | 60 | ✔ |  |  |  |  |  |
| `price_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `barcode` | Var Char | 40 |  |  |  |  |  |  |
| `barcode_key` | Var Char | 80 |  | ✔ |  |  |  |  |
| `sort_order` | Int |  | ✔ |  | 0 |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |

## 50. `product_addons`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `product_id` | Foreign Key |  | ✔ |  |  | → `products` (Cascade) |  |  |
| `name` | Var Char | 60 | ✔ |  |  |  |  |  |
| `price_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `sort_order` | Int |  | ✔ |  | 0 |  |  |  |
| `is_active` | Boolean |  | ✔ |  | true |  |  |  |

## 51. `daily_specials`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  |  |  |  | → `branches` (Cascade) |  |  |
| `product_id` | Foreign Key |  | ✔ |  |  | → `products` (Cascade) |  |  |
| `special_date` | Date |  | ✔ |  |  |  |  |  |
| `offer_price_minor` | BigInt |  |  |  |  |  |  |  |
| `tag` | Var Char | 40 |  |  |  |  |  |  |
| `sort_order` | Int |  | ✔ |  | 0 |  |  |  |

## 52. `branch_stock`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `product_id` | Foreign Key |  | ✔ |  |  | → `products` (Cascade) |  |  |
| `qty_milli` | BigInt |  | ✔ |  | 0 |  |  |  |
| `uniq_key` | Var Char | 60 | ✔ | ✔ |  |  |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 53. `purchase_items`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `purchase_id` | Foreign Key |  | ✔ |  |  | → `purchases` (Cascade) |  |  |
| `product_id` | Foreign Key |  |  |  |  | → `products` (Null) |  |  |
| `product_name` | Var Char | 150 | ✔ |  |  |  |  |  |
| `qty_milli` | BigInt |  | ✔ |  |  |  |  |  |
| `cost_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `tax_bp` | Int |  | ✔ |  | 0 |  |  |  |
| `batch_no` | Var Char | 40 |  |  |  |  |  |  |
| `expiry_date` | Date |  |  |  |  |  |  |  |
| `unit` | Var Char | 10 |  |  |  |  |  |  |
| `hsn_code` | Var Char | 10 |  |  |  |  |  |  |
| `taxable_minor` | BigInt |  |  |  |  |  |  |  |
| `tax_minor` | BigInt |  |  |  |  |  |  |  |
| `sort_order` | Int |  | ✔ |  | 0 |  |  |  |

## 54. `payment_allocations`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `payment_id` | Foreign Key |  | ✔ |  |  | → `payments` (Cascade) |  |  |
| `order_id` | Foreign Key |  |  |  |  | → `orders` (Null) |  |  |
| `amount_minor` | BigInt |  | ✔ |  |  |  |  |  |

## 55. `product_prices`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `price_list_id` | Foreign Key |  | ✔ |  |  | → `price_lists` (Cascade) |  |  |
| `product_id` | Foreign Key |  | ✔ |  |  | → `products` (Cascade) |  |  |
| `variant_id` | Foreign Key |  |  |  |  | → `product_variants` (Cascade) |  |  |
| `price_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `uniq_key` | Var Char | 80 | ✔ | ✔ |  |  |  |  |

## 56. `stock_batches`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `product_id` | Foreign Key |  | ✔ |  |  | → `products` (Cascade) |  |  |
| `purchase_item_id` | Foreign Key |  |  |  |  | → `purchase_items` (Null) |  |  |
| `batch_no` | Var Char | 40 |  |  |  |  |  |  |
| `expiry_date` | Date |  |  |  |  |  |  |  |
| `qty_in_milli` | BigInt |  | ✔ |  |  |  |  |  |
| `qty_left_milli` | BigInt |  | ✔ |  |  |  |  |  |
| `cost_minor` | BigInt |  |  |  |  |  |  |  |
| `row_version` | Int |  | ✔ |  | 1 |  |  |  |

## 57. `order_items`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `order_id` | Foreign Key |  | ✔ |  |  | → `orders` (Cascade) |  |  |
| `product_id` | Foreign Key |  |  |  |  | → `products` (Null) |  |  |
| `variant_id` | Foreign Key |  |  |  |  | → `product_variants` (Null) |  |  |
| `product_name` | Var Char | 150 | ✔ |  |  |  |  |  |
| `variant_name` | Var Char | 60 |  |  |  |  |  |  |
| `unit` | Var Char | 10 | ✔ |  |  |  |  |  |
| `qty_milli` | BigInt |  | ✔ |  |  |  |  |  |
| `unit_price_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `hsn_code` | Var Char | 10 |  |  |  |  |  |  |
| `list_price_minor` | BigInt |  |  |  |  |  |  |  |
| `taxable_minor` | BigInt |  |  |  |  |  |  |  |
| `mrp_minor` | BigInt |  |  |  |  |  |  |  |
| `price_list_id` | Foreign Key |  |  |  |  | → `price_lists` (Null) |  |  |
| `discount_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `tax_bp` | Int |  | ✔ |  | 0 |  |  |  |
| `tax_minor` | BigInt |  | ✔ |  | 0 |  |  |  |
| `line_total_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `cost_minor` | BigInt |  |  |  |  |  |  |  |
| `note` | Var Char | 150 |  |  |  |  |  |  |
| `kot_qty_milli` | BigInt |  | ✔ |  | 0 |  |  |  |
| `sort_order` | Int |  | ✔ |  | 0 |  |  |  |

## 58. `stock_movements`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `branch_id` | Foreign Key |  | ✔ |  |  | → `branches` (Cascade) |  |  |
| `product_id` | Foreign Key |  | ✔ |  |  | → `products` (Cascade) |  |  |
| `batch_id` | Foreign Key |  |  |  |  | → `stock_batches` (Null) |  |  |
| `reason` | Int |  | ✔ |  |  |  |  |  |
| `qty_milli` | BigInt |  | ✔ |  |  |  |  |  |
| `balance_milli` | BigInt |  | ✔ |  |  |  |  |  |
| `ref_type` | Int |  |  |  |  |  |  |  |
| `ref_id` | BigInt |  |  |  |  |  |  |  |
| `note` | Var Char | 255 |  |  |  |  |  |  |
| `created_by` | Foreign Key |  |  |  |  | → `users` (Null) |  |  |

## 59. `order_item_addons`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `order_item_id` | Foreign Key |  | ✔ |  |  | → `order_items` (Cascade) |  |  |
| `addon_id` | Foreign Key |  |  |  |  | → `product_addons` (Null) |  |  |
| `name` | Var Char | 60 | ✔ |  |  |  |  |  |
| `price_minor` | BigInt |  | ✔ |  |  |  |  |  |

## 60. `order_item_batches`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `order_item_id` | Foreign Key |  | ✔ |  |  | → `order_items` (Cascade) |  |  |
| `batch_id` | Foreign Key |  |  |  |  | → `stock_batches` (Null) |  |  |
| `qty_milli` | BigInt |  | ✔ |  |  |  |  |  |

## 61. `sale_return_items`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `return_id` | Foreign Key |  | ✔ |  |  | → `sale_returns` (Cascade) |  |  |
| `order_item_id` | Foreign Key |  |  |  |  | → `order_items` (Null) |  |  |
| `product_id` | Foreign Key |  |  |  |  | → `products` (Null) |  |  |
| `product_name` | Var Char | 150 | ✔ |  |  |  |  |  |
| `unit` | Var Char | 10 | ✔ |  |  |  |  |  |
| `qty_milli` | BigInt |  | ✔ |  |  |  |  |  |
| `unit_price_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `amount_minor` | BigInt |  | ✔ |  |  |  |  |  |
| `restock` | Boolean |  | ✔ |  | true |  |  |  |

## 62. `kitchen_ticket_items`

| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |
|---|---|---|---|---|---|---|---|---|
| `business_id` | Foreign Key |  | ✔ |  |  | → `businesses` (Cascade) |  |  |
| `ticket_id` | Foreign Key |  | ✔ |  |  | → `kitchen_tickets` (Cascade) |  |  |
| `order_item_id` | Foreign Key |  |  |  |  | → `order_items` (Null) |  |  |
| `name` | Var Char | 150 | ✔ |  |  |  |  |  |
| `qty_milli` | BigInt |  | ✔ |  |  |  |  |  |
| `is_veg` | Boolean |  |  |  |  |  |  |  |
| `note` | Var Char | 150 |  |  |  |  |  |  |
