import { createLogger, type Logger } from '../../src/log.ts';

export type CapturedLogger = Logger & { lines: string[] };

export function captureLogger(secrets: string[] = []): CapturedLogger {
  const lines: string[] = [];
  const logger = createLogger({ secrets, debug: true, write: (line) => lines.push(line) });
  return Object.assign(logger, { lines });
}
