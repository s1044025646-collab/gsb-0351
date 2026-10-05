/** 稳定错误码：所有校验/业务失败均抛出 DomainError 并携带机器可读 code */

export type ErrorCode =
  | "EMPTY_SEQUENCE"
  | "NON_FINITE_TEMP"
  | "NON_INTEGER_MINUTE"
  | "TIME_NOT_STRICTLY_INCREASING"
  | "DUPLICATE_TIME"
  | "TIME_OUT_OF_RANGE"
  | "TOO_MANY_OBSERVATIONS"
  | "TEMP_OUT_OF_RANGE"
  | "INVALID_BASE_TEMP"
  | "INVALID_UPPER_TEMP"
  | "UPPER_NOT_ABOVE_BASE"
  | "DUPLICATE_STAGE_ID"
  | "STAGE_THRESHOLD_NOT_POSITIVE"
  | "STAGES_NOT_STRICTLY_INCREASING"
  | "TOO_MANY_STAGES"
  | "STAGE_THRESHOLD_OUT_OF_RANGE"
  | "INVALID_GAP_RULE"
  | "GAP_VIOLATION"
  | "INVALID_ORIGIN"
  | "NOT_FOUND"
  | "CONFIG_VERSION_MISMATCH"
  | "BAD_REQUEST"
  | "INTERNAL";

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}
