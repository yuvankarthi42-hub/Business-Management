// One holder at a time, in arrival order — SQLite's single writer, for the in-process databases.
// Waiting longer than waitMs fails with 'busy' (it also catches code that uses the wrong handle inside a
// transaction: it would wait for itself forever).
import { SqlError } from './sql/driver'

export class Lock {
  private tail: Promise<void> = Promise.resolve()
  constructor(private waitMs = Number(process.env.DB_LOCK_WAIT_MS ?? 5000)) {}
  acquire(): Promise<() => void> {
    let release!: () => void
    const mine = new Promise<void>((r) => { release = r })
    const prev = this.tail
    this.tail = prev.then(() => mine)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { reject(new SqlError('busy', 'database is locked (waited too long)')); void prev.then(() => release()) }, this.waitMs)
      void prev.then(() => { clearTimeout(t); resolve(release) })
    })
  }
}
