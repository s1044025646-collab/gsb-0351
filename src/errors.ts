/** Stable error codes for the GDD service. */
export const ERR = {
  EMPTY_SERIES: "EMPTY_SERIES",
  NON_FINITE_TEMP: "NON_FINITE_TEMP",
  NON_FINITE_TIME: "NON_FINITE_TIME",
  TIME_NOT_INCREASING: "TIME_NOT_INCREASING",
  DUPLICATE_TIME: "DUPLICATE_TIME",
  INVALID_THRESHOLDS: "INVALID_THRESHOLDS",
  INVALID_STAGE: "INVALID_STAGE",
  DUPLICATE_STAGE_ID: "DUPLICATE_STAGE_ID",
  STAGE_THRESHOLD_NOT_INCREASING: "STAGE_THRESHOLD_NOT_INCREASING",
  GAP_EXCEEDED: "GAP_EXCEEDED",
  TOO_MANY_OBSERVATIONS: "TOO_MANY_OBSERVATIONS",
  RANGE_EXCEEDED: "RANGE_EXCEEDED",
  VALUE_OUT_OF_RANGE: "VALUE_OUT_OF_RANGE",
  NOT_FOUND: "NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
} as const;
export type ErrCode = (typeof ERR)[keyof typeof ERR];

export class GddError extends Error {
  code: ErrCode;
  details?: unknown;
  constructor(code: ErrCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Hard limits: no online infinite streams, bounded magnitude. */
export const LIMITS = {
  MAX_POINTS: 100_000,
  MAX_RANGE_MINUTES: 10 * 366 * 1440, // ~10 years
  MAX_ABS_TEMP: 150,
  MAX_ABS_THRESHOLD: 150,
  MAX_STAGE_THRESHOLD: 1e7,
  MAX_STAGES: 1000,
  MAX_GAP_MINUTES: 7 * 1440,
};
