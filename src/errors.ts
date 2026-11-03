/**
 * Every error code the server can send (`docs/protocol.md`, "Error codes"). The answer helper accepts only
 * `ErrorCode`, so `tsc` keeps the codes the server sends inside this list, and the protocol document test
 * compares this list with the document.
 */
export const ERROR_CODES = [
  'BAD_FRAME',
  'BAD_PARAMS',
  'UNKNOWN_OPERATION',
  'UNSUPPORTED_VERSION',
  'NOT_AUTHENTICATED',
  'ALREADY_AUTHENTICATED',
  'AUTH_FAILED',
  'INVITE_UNKNOWN',
  'INVITE_EXPIRED',
  'INVITE_USED',
  'HANDLE_TAKEN',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** An error that becomes an error answer with this code. */
export class ProtocolError extends Error {
  readonly code: ErrorCode
  readonly detail: Record<string, unknown> | undefined
  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

export function badParams(field: string, message: string): ProtocolError {
  return new ProtocolError('BAD_PARAMS', message, { field })
}
