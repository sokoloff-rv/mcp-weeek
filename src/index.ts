import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { readEnv } from './config/env.ts';
import { createLogger } from './log.ts';

const env = readEnv();
const log = createLogger({ secrets: [env.token], debug: env.debug });
for (const problem of env.problems) log.error(problem);

const server = createApp({
  env,
  log,
  cwd: () => process.cwd(),
  homeDir: homedir(),
  downloadDir: join(tmpdir(), 'mcp-weeek'),
});
log.info(`started in ${process.cwd()}${env.readOnly ? ', read-only' : ''}`);
await server.listen(process.stdin, process.stdout);
process.exit(0);
