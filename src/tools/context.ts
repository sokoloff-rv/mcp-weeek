import type { LoadedConfig } from '../config/project.ts';
import type { Tool } from '../mcp/tool.ts';
import type { Resolver } from '../resolve.ts';
import { memberName } from '../weeek/names.ts';
import type { Board } from '../weeek/types.ts';
import { defineTool, READ_ONLY, schema, UNTRUSTED_NOTE } from './define.ts';
import { openScope, type Deps } from './deps.ts';

export function contextTools(deps: Deps): Tool[] {
  return [
    defineTool({
      name: 'weeek_context',
      title: 'Weeek context',
      description: [
        'Call this first, before any other weeek_* tool.',
        'Shows who the token belongs to, the workspace, the project config (.weeek.json) with its boards, columns, aliases and working conventions, plus workspace members and tags.',
        'Follow the conventions it prints when you create, move or comment on tasks.',
        'Without .weeek.json it lists the projects; pass `project` to see the boards and columns of any project.',
      ].join(' '),
      properties: {
        project: schema.text('Optional project name or id to inspect instead of the configured one.'),
      },
      annotations: READ_ONLY,
      run: async (args, { signal }) => {
        const { loaded, resolver } = await openScope(deps, signal);
        const projectRef = args.ref('project');
        const [me, workspace, members, tags] = await Promise.all([
          resolver.me(),
          deps.directory.workspace.get(signal),
          deps.directory.members.get(signal),
          deps.directory.tags.get(signal),
        ]);

        const lines = [
          `User (token owner): ${memberName(me)} (${me.id})`,
          `Workspace: ${workspace.title} (${workspace.id})`,
          `Mode: ${deps.readOnly ? 'read-only (WEEEK_READ_ONLY=1): write tools are disabled' : 'read and write'}`,
          '',
          ...describeConfig(loaded, workspace.id),
        ];

        const config = loaded.status === 'ok' ? loaded.config : undefined;
        if (projectRef !== undefined || config?.projectId !== undefined || (config?.boards.length ?? 0) > 0) {
          lines.push('', ...(await describeProject(resolver, projectRef, signal, deps)));
        } else {
          const projects = await deps.directory.projects.get(signal);
          lines.push('', 'Projects (pass `project` to see boards and columns):', ...projects.map((p) => `- ${p.title} (${p.id})`));
        }

        if (config && projectRef === undefined) {
          lines.push('', `Attachments are allowed only from: ${config.attachRoots.join(', ')} (hidden files and folders excluded)`);
          if (config.conventions.length > 0) lines.push('', 'Conventions of this project:', ...config.conventions.map((c) => `- ${c}`));
        }

        lines.push(
          '',
          `Members: ${members.map((member) => `${memberName(member)} (${member.id})`).join(', ') || 'none'}`,
          `Tags: ${tags.map((tag) => `${tag.title} (${tag.id})`).join(', ') || 'none'}`,
          '',
          UNTRUSTED_NOTE,
        );
        return lines.join('\n');
      },
    }),
  ];
}

function describeConfig(loaded: LoadedConfig, workspaceId: number): string[] {
  if (loaded.status === 'missing') {
    return [`Project config: none (no .weeek.json from ${loaded.searchedFrom} upwards). Pass board/project explicitly.`];
  }
  if (loaded.status === 'invalid') {
    return [`Project config: ${loaded.path} is INVALID: ${loaded.error}. Fix it; until then pass board/project explicitly.`];
  }
  const warnings = [...loaded.warnings];
  const configured = loaded.config.workspaceId;
  if (configured !== undefined && configured !== workspaceId) {
    warnings.push(`"workspaceId" is ${configured}, but the token belongs to workspace ${workspaceId}: this token cannot see that project.`);
  }
  return [`Project config: ${loaded.path}`, ...(warnings.length > 0 ? ['Warnings:', ...warnings.map((w) => `- ${w}`)] : [])];
}

async function describeProject(resolver: Resolver, projectRef: string | number | undefined, signal: AbortSignal, deps: Deps): Promise<string[]> {
  const project = await resolver.project(projectRef);
  const boards = await deps.directory.boards.get(project.id, signal);
  const configuredIds = projectRef === undefined ? (resolver.config?.boards.map((board) => board.id) ?? []) : [];
  const defaultBoardId = configuredIds[0] ?? (boards.length === 1 ? boards[0]?.id : undefined);
  const ordered = [
    ...configuredIds.map((id) => boards.find((board) => board.id === id)).filter((board): board is Board => board !== undefined),
    ...boards.filter((board) => !configuredIds.includes(board.id)),
  ];
  const lines = [`Project: ${project.title} (${project.id})`, 'Boards:'];
  for (const board of ordered) {
    const alias = resolver.boardAlias(board);
    const isDefault = board.id === defaultBoardId;
    lines.push(`- ${board.name} (${board.id})${alias ? ` [${alias}]` : ''}${isDefault ? ' — default board' : ''}`);
    if (configuredIds.length > 0 && !configuredIds.includes(board.id)) continue;
    const columns = await resolver.columns(board);
    const defaultColumn = isDefault ? await resolver.defaultColumn(board) : undefined;
    const labels = columns.map((column) => `${resolver.columnLabel(column)}${column.id === defaultColumn?.id ? ' — default for new tasks' : ''}`);
    lines.push(`  Columns: ${labels.join(', ') || 'none'}`);
  }
  if (ordered.length === 0) lines.push('- none');
  return lines;
}
