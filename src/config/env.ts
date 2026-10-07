export const DEFAULT_BASE_URL = 'https://api.weeek.net/public/v1';
const API_HOST = 'api.weeek.net';

export type Env = {
  token: string;
  baseUrl: string;
  readOnly: boolean;
  debug: boolean;
  configPath: string | undefined;
  problems: string[];
};

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const problems: string[] = [];
  const token = source.WEEEK_TOKEN?.trim() ?? '';
  if (!token) {
    problems.push('WEEEK_TOKEN is not set. Create a token in Weeek (Settings → API) and pass it to the server environment.');
  }
  const baseUrl = source.WEEEK_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const baseUrlProblem = checkBaseUrl(baseUrl);
  if (baseUrlProblem) problems.push(baseUrlProblem);
  return {
    token,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    readOnly: isEnabled(source.WEEEK_READ_ONLY),
    debug: isEnabled(source.WEEEK_DEBUG),
    configPath: source.WEEEK_CONFIG?.trim() || undefined,
    problems,
  };
}

function checkBaseUrl(value: string): string | undefined {
  const refusal = `WEEEK_BASE_URL must be an https URL on ${API_HOST}, so that the token cannot leak to another host.`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${refusal} The value is not a valid URL.`;
  }
  if (url.protocol !== 'https:' || url.hostname !== API_HOST || url.port !== '' || url.username || url.password) {
    return `${refusal} Got ${url.protocol}//${url.host}.`;
  }
  return undefined;
}

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}
