import type { TableName } from './schema.gen'

/**
 * A row as the backend sees it: column names from schema.sql, values in JavaScript types.
 * ROWID and every foreign key are strings (Catalyst ids are longer than JavaScript numbers can hold).
 * DATETIME columns are ISO strings ('2026-10-12T09:30:00.000Z'), DATE columns 'YYYY-MM-DD'.
 */
export type Value = string | number | boolean | null
export type Row = { ROWID: string; CREATEDTIME: string; MODIFIEDTIME: string; [column: string]: Value }
export type NewRow = Record<string, Value | undefined>

/** Conditions are ANDed. A plain value means "=", null means "IS NULL". */
export type Cond =
  | Value
  | { in: Value[] }
  | { ne: Value }
  | { gt: Value } | { gte: Value } | { lt: Value } | { lte: Value }
  | { gte: Value; lt: Value } | { gte: Value; lte: Value } | { gt: Value; lt: Value }
export type Where = Record<string, Cond>

export interface SelectOptions {
  where?: Where
  orderBy?: [column: string, dir: 'ASC' | 'DESC'][]
  /** Default: every matching row (read in pages of 300). Keep it bounded on big tables. */
  limit?: number
  offset?: number
}

/** Thrown for unique-constraint violations, so callers can retry or explain. */
export class DuplicateError extends Error {
  constructor(readonly table: string, readonly column?: string) { super(`Duplicate value in ${table}${column ? `.${column}` : ''}`) }
}

export type AggFn = 'SUM' | 'COUNT' | 'MAX' | 'MIN'
export interface AggregateOptions {
  where?: Where
  groupBy?: string[]
  /** alias → [function, column]. COUNT counts rows (column is ignored). */
  fns: Record<string, [AggFn, string]>
}

/** What actually exists in the Data Store (for the schema check after setup). */
export interface SchemaInfo { tables: { name: string; columns: { name: string; type: string; mandatory: boolean; unique: boolean; maxLength?: number }[] }[] }

/** A raw SQL row (only SQL databases: Turso / SQLite). */
export type SqlRow = Record<string, string | number | null>

export interface Db {
  /**
   * Runs fn with a handle whose reads and writes are one transaction: all saved, or none if fn throws.
   * Turso / SQLite: BEGIN IMMEDIATE (one writer per database — keep it short, read what you can before).
   * Catalyst Data Store has no transactions: fn simply runs (the code keeps its own undo steps there).
   * Inside a transaction, only the handle passed to fn may be used for that database.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  /** True on the handle given to a transaction. */
  readonly inTransaction?: boolean
  /** Raw parameterised SQL for the Turso-only tables (change_log, sync_epochs). Undefined on Catalyst. */
  sql?(sql: string, args?: (string | number | null)[]): Promise<SqlRow[]>
  /** Several raw statements in one round trip (inside a transaction: part of it; otherwise all or nothing). */
  sqlMany?(stmts: { sql: string; args?: (string | number | null)[] }[]): Promise<SqlRow[][]>

  /** Tables and columns as the Data Store reports them (Catalyst metadata API). */
  describe?(): Promise<SchemaInfo>
  /** GROUP BY totals — reads one row per group instead of every row (keeps Data Store reads low). */
  aggregate(table: TableName, opts: AggregateOptions): Promise<Record<string, Value>[]>
  select(table: TableName, opts?: SelectOptions): Promise<Row[]>
  first(table: TableName, where: Where, orderBy?: SelectOptions['orderBy']): Promise<Row | null>
  get(table: TableName, id: string): Promise<Row | null>
  count(table: TableName, where?: Where): Promise<number>
  insert(table: TableName, row: NewRow): Promise<Row>
  /** Inserted in chunks of 200 (Catalyst's limit per call). */
  insertMany(table: TableName, rows: NewRow[]): Promise<Row[]>
  update(table: TableName, id: string, patch: NewRow): Promise<Row>
  updateMany(table: TableName, rows: (NewRow & { ROWID: string })[]): Promise<Row[]>
  /**
   * Optimistic update: only applies when row_version still equals `version` (then adds 1).
   * Returns false when another device changed the row first — reload and try again.
   */
  updateIfVersion(table: TableName, id: string, version: number, patch: NewRow): Promise<boolean>
  delete(table: TableName, id: string): Promise<void>
  deleteMany(table: TableName, ids: string[]): Promise<void>
}
