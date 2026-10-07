import { UserError } from '../errors.ts';
import { flattenNestedLists } from '../format/comment-markdown.ts';
import type { Tool } from '../mcp/tool.ts';
import { WeeekError } from '../weeek/client.ts';
import { memberName } from '../weeek/names.ts';
import type { Comment } from '../weeek/types.ts';
import { defineTool, schema, WRITE } from './define.ts';
import type { Deps } from './deps.ts';

const CLOCK_SKEW_MS = 2 * 60_000;
const RECENT_COMMENTS = 20;

export function commentTools(deps: Deps): Tool[] {
  return [
    defineTool({
      name: 'weeek_add_comment',
      title: 'Comment on a task',
      description: [
        'Adds a Markdown comment to a task, optionally as a reply to another comment.',
        'Weeek flattens nested lists in comments, so nested items are sent as top-level items with a visible indent and ◦/▪ markers.',
        'Comments cannot be edited: to fix one, delete it with weeek_delete_comment and write it again.',
        'If Weeek fails while saving, the server checks whether the comment appeared, so it is never posted twice.',
      ].join(' '),
      properties: {
        id: schema.id('Task id.'),
        text: schema.text('Comment text in Markdown.'),
        replyTo: schema.id('Id of the comment to reply to.'),
      },
      required: ['id', 'text'],
      annotations: WRITE,
      run: async (args, { signal }) => {
        const id = args.id('id', { required: true });
        const text = args.string('text', { required: true });
        const replyTo = args.id('replyTo');
        const me = await deps.directory.me.get(signal);
        const started = deps.now().getTime();
        let comment: Comment;
        let recovered = false;
        try {
          comment = await deps.api.addComment(id, flattenNestedLists(text.trim()), replyTo, signal);
        } catch (error) {
          if (!(error instanceof WeeekError) || !error.transient) throw error;
          const recent = await deps.api.latestComments(id, RECENT_COMMENTS, signal);
          const found = recent.find(
            (candidate) =>
              candidate.authorId === me.id &&
              candidate.parentId === (replyTo ?? null) &&
              Date.parse(candidate.createdAt) >= started - CLOCK_SKEW_MS,
          );
          if (!found) throw new UserError(`${error.message} The comment was not added: checked the task. It is safe to retry.`);
          comment = found;
          recovered = true;
        }
        return [
          `Comment #${comment.id} added to task #${id}${replyTo === undefined ? '' : ` as a reply to #${replyTo}`}.`,
          ...(recovered ? ['Weeek answered with an error, but the comment had been saved: it was not posted twice.'] : []),
        ].join('\n');
      },
    }),

    defineTool({
      name: 'weeek_delete_comment',
      title: 'Delete a comment',
      description: [
        'Deletes a comment from a task. Only comments written by the token owner can be deleted, never other people\'s.',
        'Use it to fix your own comment: delete it and add a corrected one.',
      ].join(' '),
      properties: {
        id: schema.id('Task id.'),
        commentId: schema.id('Comment id, as shown by weeek_get_task.'),
      },
      required: ['id', 'commentId'],
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      run: async (args, { signal }) => {
        const id = args.id('id', { required: true });
        const commentId = args.id('commentId', { required: true });
        const [me, comments] = await Promise.all([deps.directory.me.get(signal), deps.api.comments(id, signal)]);
        const comment = comments.find((candidate) => candidate.id === commentId);
        if (!comment) throw new UserError(`Comment #${commentId} not found on task #${id}.`);
        if (comment.authorId !== me.id) {
          const members = await deps.directory.members.get(signal);
          const author = members.find((member) => member.id === comment.authorId);
          throw new UserError(
            `Comment #${commentId} was written by ${author ? memberName(author) : comment.authorId}. Only comments of the token owner (${memberName(me)}) can be deleted.`,
          );
        }
        try {
          await deps.api.deleteComment(id, commentId, signal);
        } catch (error) {
          const gone = error instanceof WeeekError && error.status === 404 && !(await deps.api.comments(id, signal)).some((c) => c.id === commentId);
          if (!gone) throw error;
        }
        return `Deleted comment #${commentId} from task #${id}.`;
      },
    }),
  ];
}
