export type Deadline = {
  signal: AbortSignal;
  expired(): boolean;
  clear(): void;
};

export function deadline(ms: number, outer?: AbortSignal): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`Timed out after ${ms} ms`, 'TimeoutError')), ms);
  return {
    signal: outer ? AbortSignal.any([outer, controller.signal]) : controller.signal,
    expired: () => controller.signal.aborted,
    clear: () => clearTimeout(timer),
  };
}
