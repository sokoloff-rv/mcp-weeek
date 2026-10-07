import type { Tool } from '../mcp/tool.ts';
import { contextTools } from './context.ts';
import type { Deps } from './deps.ts';

export function createTools(deps: Deps): Tool[] {
  const tools = [...contextTools(deps)];
  return deps.readOnly ? tools.filter((tool) => tool.annotations.readOnlyHint) : tools;
}
