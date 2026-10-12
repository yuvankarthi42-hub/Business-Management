/** An error whose message is safe to show to the user. Anything else becomes "Something went wrong". */
export class ApiError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'BAD_REQUEST') {
    super(message)
  }
}
export const notSignedIn = () => new ApiError('Please sign in again', 401, 'UNAUTHORIZED')
export const forbidden = (msg = 'You do not have permission to do this') => new ApiError(msg, 403, 'FORBIDDEN')
export const notFound = (msg = 'Not found') => new ApiError(msg, 404, 'NOT_FOUND')
/** Someone else changed the same record first — the user should reload and try again. */
export const conflict = (msg = 'This was changed on another device. Please try again.') => new ApiError(msg, 409, 'CONFLICT')
