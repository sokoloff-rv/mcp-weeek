export type Logger = {
  info(message: string): void;
  error(message: string): void;
  debug(message: string): void;
};

const SECRET_PATTERNS: [RegExp, string][] = [
  [/(Bearer\s+)[^\s"',]+/gi, '$1***'],
  [/([?&](?:signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s"']+/gi, '$1***'],
];

const MIN_SECRET_LENGTH = 8;

export function createMasker(secrets: readonly string[]): (text: string) => string {
  const literals = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  return (text) => {
    let masked = text;
    for (const secret of literals) masked = masked.split(secret).join('***');
    for (const [pattern, replacement] of SECRET_PATTERNS) masked = masked.replace(pattern, replacement);
    return masked;
  };
}

export type LoggerOptions = {
  secrets: readonly string[];
  debug: boolean;
  write?: (line: string) => void;
};

export function createLogger({ secrets, debug, write = (line) => process.stderr.write(line) }: LoggerOptions): Logger {
  const mask = createMasker(secrets);
  const emit = (level: string, message: string) => write(`[mcp-weeek] ${level}: ${mask(message)}\n`);
  return {
    info: (message) => emit('info', message),
    error: (message) => emit('error', message),
    debug: (message) => {
      if (debug) emit('debug', message);
    },
  };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
