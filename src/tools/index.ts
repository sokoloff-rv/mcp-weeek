import type { Tool } from '../mcp/tool.ts';
import { attachmentTools } from './attachments.ts';
import { contextTools } from './context.ts';
import type { Deps } from './deps.ts';
import { taskTools } from './tasks.ts';

export function createTools(deps: Deps): Tool[] {
  const tools = [...contextTools(deps), ...taskTools(deps), ...attachmentTools(deps)];
  return deps.readOnly ? tools.filter((tool) => tool.annotations.readOnlyHint) : tools;
}
