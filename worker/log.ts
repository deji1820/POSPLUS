/**
 * Structured worker logging with job correlation IDs (SPEC.md §24).
 *
 * Every line carries the job id so a job's lifecycle (queued → attempts →
 * dead-letter/operator retry) can be traced across logs. Per §24, log event
 * IDs and sanitized metadata only — never full webhook bodies or payloads
 * that may contain business/customer data.
 */
export function jobLog(
  jobId: string,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), jobId, msg, ...fields }));
}
