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
  'RECIPIENT_UNKNOWN',
  'RECIPIENT_IS_SELF',
  'HANDOFF_ID_REUSED',
  'RATE_LIMITED',
  'HANDOFF_UNKNOWN',
  'HANDOFF_EXPIRED',
  'HANDOFF_DELIVERED_ELSEWHERE',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/**
 * The codes that can answer a request before authentication, each of which is followed by close 4003. The
 * protocol document gives a client action for each of these (section 4).
 */
export const PRE_AUTH_ERROR_CODES: readonly ErrorCode[] = [
  'BAD_FRAME',
  'BAD_PARAMS',
  'UNKNOWN_OPERATION',
  'UNSUPPORTED_VERSION',
  'NOT_AUTHENTICATED',
  'AUTH_FAILED',
  'INVITE_UNKNOWN',
  'INVITE_EXPIRED',
  'INVITE_USED',
  'HANDLE_TAKEN',
  'INTERNAL',
]

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
