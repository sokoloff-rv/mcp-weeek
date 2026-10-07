import type { LoadedConfig } from '../config/project.ts';
import { Resolver } from '../resolve.ts';
import type { WeeekApi } from '../weeek/api.ts';
import type { FetchLike } from '../weeek/client.ts';
import type { Directory } from '../weeek/directory.ts';

export type Deps = {
  api: WeeekApi;
  directory: Directory;
  loadConfig: () => Promise<LoadedConfig>;
  readOnly: boolean;
  downloadDir: string;
  fetch: FetchLike;
  now: () => Date;
};

export type Scope = { loaded: LoadedConfig; resolver: Resolver };

export async function openScope(deps: Deps, signal: AbortSignal): Promise<Scope> {
  const loaded = await deps.loadConfig();
  return { loaded, resolver: new Resolver(deps.directory, loaded, signal) };
}
