import { parseHtml, textContent, type HtmlElement, type HtmlNode } from './html.ts';

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'table',
]);

export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return '';
  return renderBlocks(parseHtml(html))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderBlocks(nodes: HtmlNode[], separator = '\n\n'): string {
  const blocks: string[] = [];
  let inline: HtmlNode[] = [];
  const flush = () => {
    const text = renderInline(inline).trim();
    if (text) blocks.push(text);
    inline = [];
  };
  for (const node of nodes) {
    if (node.type === 'element' && BLOCK_TAGS.has(node.tag)) {
      flush();
      const block = renderBlock(node);
      if (block.trim()) blocks.push(block);
    } else {
      inline.push(node);
    }
  }
  flush();
  return blocks.join(separator);
}

function renderBlock(element: HtmlElement): string {
  const { tag } = element;
  if (/^h[1-6]$/.test(tag)) {
    const text = renderInline(element.children).trim();
    return text ? `${'#'.repeat(Number(tag[1]))} ${text}` : '';
  }
  switch (tag) {
    case 'hr':
      return '---';
    case 'pre':
      return renderCodeBlock(element);
    case 'blockquote':
      return prefixLines(renderBlocks(element.children), '> ', '>');
    case 'ul':
    case 'ol':
      return renderList(element);
    case 'table':
      return renderTable(element);
    case 'li':
      return renderList({ ...element, tag: 'ul', children: [element] });
    default:
      return renderBlocks(element.children);
  }
}

function renderCodeBlock(element: HtmlElement): string {
  const code = element.children.find((child): child is HtmlElement => child.type === 'element' && child.tag === 'code');
  const language = /language-([\w+-]+)/.exec(code?.attrs.class ?? '')?.[1] ?? '';
  const text = textContent(element).replace(/\n$/, '');
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function renderList(list: HtmlElement): string {
  const ordered = list.tag === 'ol';
  let number = Number(list.attrs.start) || 1;
  const items = list.children.filter((child): child is HtmlElement => child.type === 'element' && child.tag === 'li');
  return items
    .map((item) => {
      if (ordered && item.attrs.value && Number(item.attrs.value)) number = Number(item.attrs.value);
      const marker = ordered ? `${number++}.` : '-';
      const body = renderBlocks(item.children, '\n') || '';
      return prefixLines(body, ' '.repeat(marker.length + 1), '', `${marker} `);
    })
    .join('\n');
}

function renderTable(table: HtmlElement): string {
  const rows = collect(table, 'tr').map((row) =>
    row.children
      .filter((cell): cell is HtmlElement => cell.type === 'element' && (cell.tag === 'td' || cell.tag === 'th'))
      .map((cell) => renderBlocks(cell.children, ' ').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()),
  );
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return '';
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`;
  const [header = [], ...body] = rows;
  return [line(header), line(Array.from({ length: width }, () => '---')), ...body.map(line)].join('\n');
}

function renderInline(nodes: HtmlNode[]): string {
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(node: HtmlNode): string {
  if (node.type === 'text') return node.text.replace(/\s+/g, ' ');
  switch (node.tag) {
    case 'br':
      return '\n';
    case 'strong':
    case 'b':
      return wrap(renderInline(node.children), '**');
    case 'em':
    case 'i':
      return wrap(renderInline(node.children), '*');
    case 'del':
    case 's':
    case 'strike':
      return wrap(renderInline(node.children), '~~');
    case 'code':
      return inlineCode(textContent(node));
    case 'a': {
      const text = renderInline(node.children).trim();
      const href = node.attrs.href ?? '';
      if (!href) return text;
      return !text || text === href ? href : `[${text}](${href})`;
    }
    case 'img':
      return node.attrs.src ? `![${node.attrs.alt ?? ''}](${node.attrs.src})` : '';
    default:
      return BLOCK_TAGS.has(node.tag) ? ` ${renderBlocks(node.children, ' ')} ` : renderInline(node.children);
  }
}

function wrap(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [, before = '', inner = '', after = ''] = match ?? [];
  return inner ? `${before}${marker}${inner}${marker}${after}` : text;
}

function inlineCode(text: string): string {
  const fence = '`'.repeat(longestRun(text, '`') + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function prefixLines(text: string, prefix: string, emptyPrefix: string, firstPrefix = prefix): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? firstPrefix + line : line ? prefix + line : emptyPrefix))
    .join('\n');
}

function collect(element: HtmlElement, tag: string): HtmlElement[] {
  const found: HtmlElement[] = [];
  for (const child of element.children) {
    if (child.type !== 'element') continue;
    if (child.tag === tag) found.push(child);
    else found.push(...collect(child, tag));
  }
  return found;
}

function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const symbol of text) {
    current = symbol === char ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}
