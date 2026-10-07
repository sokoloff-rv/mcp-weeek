import { escapeHtml } from './html.ts';

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function markdownToHtml(markdown: string): string {
  return renderBlocks(markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

function renderBlocks(lines: string[]): string {
  const html: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      index++;
      while (index < lines.length && !isClosingFence(lines[index] ?? '', marker)) body.push(lines[index++] ?? '');
      index++;
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      html.push(`<h${heading[1]?.length}>${renderInline(heading[2] ?? '')}</h${heading[1]?.length}>`);
      index++;
      continue;
    }
    if (RULE.test(line)) {
      html.push('<hr>');
      index++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) body.push((lines[index++] ?? '').replace(QUOTE, ''));
      html.push(`<blockquote>${renderBlocks(body)}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, index)) {
      const rows: string[] = [];
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) rows.push(lines[index++] ?? '');
      html.push(renderTable(rows));
      continue;
    }
    if (LIST_ITEM.test(line)) {
      index = renderList(lines, index, html);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? '').trim() && (paragraph.length === 0 || !startsBlock(lines, index))) {
      paragraph.push((lines[index++] ?? '').trim());
    }
    html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
  }
  return html.join('');
}

function renderList(lines: string[], start: number, html: string[]): number {
  const first = LIST_ITEM.exec(lines[start] ?? '');
  const baseIndent = first?.[1]?.length ?? 0;
  const ordered = /\d/.test(first?.[2] ?? '');
  const items: string[] = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index] ?? '');
    if (!match || (match[1]?.length ?? 0) !== baseIndent || /\d/.test(match[2] ?? '') !== ordered) break;
    const contentIndent = baseIndent + (match[2]?.length ?? 1) + 1;
    const body = [match[3] ?? ''];
    index++;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      const indent = next.length - next.trimStart().length;
      if (!next.trim()) {
        const following = lines[index + 1] ?? '';
        if (following.trim() && following.length - following.trimStart().length > baseIndent) {
          body.push('');
          index++;
          continue;
        }
        break;
      }
      if (indent <= baseIndent && (LIST_ITEM.test(next) || startsBlock(lines, index))) break;
      body.push(next.slice(Math.min(indent, contentIndent)));
      index++;
    }
    items.push(`<li>${renderItem(body)}</li>`);
  }
  const startNumber = ordered ? Number.parseInt(first?.[2] ?? '1', 10) : 1;
  const tag = ordered ? 'ol' : 'ul';
  html.push(`<${tag}${startNumber > 1 ? ` start="${startNumber}"` : ''}>${items.join('')}</${tag}>`);
  return index;
}

function renderItem(body: string[]): string {
  const [first = '', ...rest] = body;
  const task = /^\[([ xX])\]\s+/.exec(first);
  const lead = task ? `${task[1] === ' ' ? '☐' : '☑'} ${first.slice(task[0].length)}` : first;
  return renderBlocks([lead, ...rest]) || '<p></p>';
}

function renderTable(rows: string[]): string {
  const [header = '', , ...body] = rows;
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/(?<!\\)\|$/, '')
      .split(/(?<!\\)\|/)
      .map((cell) => renderInline(cell.trim().replace(/\\\|/g, '|')));
  const row = (row: string, tag: string) => `<tr>${cells(row).map((cell) => `<${tag}><p>${cell}</p></${tag}>`).join('')}</tr>`;
  return `<table>${row(header, 'th')}${body.map((line) => row(line, 'td')).join('')}</table>`;
}

function isTableStart(lines: string[], index: number): boolean {
  return (lines[index] ?? '').includes('|') && TABLE_DELIMITER.test(lines[index + 1] ?? '') && (lines[index + 1] ?? '').includes('-');
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || isTableStart(lines, index);
}

function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && trimmed === (marker[0] ?? '`').repeat(trimmed.length);
}

const PLACEHOLDER = (index: number) => `\u0000${index}\u0000`;

function renderInline(text: string): string {
  const stash: string[] = [];
  const keep = (html: string) => PLACEHOLDER(stash.push(html) - 1);

  let result = text
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_match, _fence: string, code: string) => keep(`<code>${escapeHtml(code.trim())}</code>`))
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt: string, url: string) =>
      safeUrl(url) ? keep(`<a href="${escapeHtml(url)}">${escapeHtml(alt || url)}</a>`) : match,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label: string, url: string) =>
      safeUrl(url) ? keep(`<a href="${escapeHtml(url)}">${renderEmphasis(escapeHtml(label))}</a>`) : match,
    )
    .replace(/<((?:https?:\/\/|mailto:)[^\s>]+)>/g, (_match, url: string) => keep(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`))
    .replace(/\bhttps?:\/\/[^\s<>()\u0000]+[^\s<>().,;:!?'"\u0000]/g, (url) => keep(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));

  result = renderEmphasis(escapeHtml(result));
  return result.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => stash[Number(index)] ?? '');
}

function renderEmphasis(html: string): string {
  return html
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, '$1<strong>$2</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>');
}

function safeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url);
}
