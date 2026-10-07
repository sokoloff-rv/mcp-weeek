import type { Tool } from '../mcp/tool.ts';
import { attachmentTools } from './attachments.ts';
import { commentTools } from './comments.ts';
import { contextTools } from './context.ts';
import type { Deps } from './deps.ts';
import { taskTools } from './tasks.ts';
import { timeTools } from './time.ts';

export function createTools(deps: Deps): Tool[] {
  const tools = [...contextTools(deps), ...taskTools(deps), ...commentTools(deps), ...attachmentTools(deps), ...timeTools(deps)];
  return deps.readOnly ? tools.filter((tool) => tool.annotations.readOnlyHint) : tools;
}
