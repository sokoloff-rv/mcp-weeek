export type HtmlNode = HtmlText | HtmlElement;
export type HtmlText = { type: 'text'; text: string };
export type HtmlElement = { type: 'element'; tag: string; attrs: Record<string, string>; children: HtmlNode[] };

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['script', 'style']);

const TOKEN =
  /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+|<)/gi;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const current = () => stack[stack.length - 1] ?? root;
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(html); match; match = TOKEN.exec(html)) {
    const [, closing, rawTag, rawAttrs = '', selfClosing, text] = match;
    if (text !== undefined) {
      current().children.push({ type: 'text', text: decodeEntities(text) });
      continue;
    }
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const index = stack.findLastIndex((element) => element.tag === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    if (RAW_TEXT_TAGS.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, TOKEN.lastIndex);
      TOKEN.lastIndex = end === -1 ? html.length : html.indexOf('>', end) + 1 || html.length;
      continue;
    }
    const element: HtmlElement = { type: 'element', tag, attrs: parseAttributes(rawAttrs), children: [] };
    current().children.push(element);
    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(element);
  }
  return root.children;
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  for (let match = ATTRIBUTE.exec(source); match; match = ATTRIBUTE.exec(source)) {
    const [, name, doubleQuoted, singleQuoted, bare] = match;
    if (name) attrs[name.toLowerCase()] = decodeEntities(doubleQuoted ?? singleQuoted ?? bare ?? '');
  }
  return attrs;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  bull: '•',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function textContent(node: HtmlNode): string {
  if (node.type === 'text') return node.text;
  if (node.tag === 'br') return '\n';
  return node.children.map(textContent).join('');
}
