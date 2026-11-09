/**
 * setTimeout stores its delay in a signed 32-bit integer: anything larger
 * fires after about 1 ms (with a TimeoutOverflowWarning) instead of waiting.
 * Every timer whose delay comes from configuration goes through here.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export function clampTimerMs(ms: number): number {
  return Math.min(ms, MAX_TIMER_MS);
}
