import bcrypt from 'bcryptjs'
import { ApiError } from './errors'

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10)
export const checkPassword = (plain: string, hash: string | null | undefined) => (hash ? bcrypt.compare(plain, hash) : Promise.resolve(false))
export function assertPassword(p: string | undefined | null) {
  if (!p || p.length < 6) throw new ApiError('Password must be at least 6 characters')
  if (p.length > 72) throw new ApiError('Password is too long (72 characters at most)')
}
