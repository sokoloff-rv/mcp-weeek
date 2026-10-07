const NBSP = String.fromCharCode(0xa0);
const INDENT_PER_LEVEL = 4;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Weeek схлопывает вложенные списки в комментариях: отступ теряется, подпункты становятся пунктами верхнего уровня.
 * Поэтому вложенность передаём видимо: подпункт — отдельный пункт с отступом из неразрывных пробелов и своим маркером.
 */
export function flattenNestedLists(markdown: string): string {
  const output: string[] = [];
  const openItems: number[] = [];
  let fence: string | undefined;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      output.push(line);
      if (line.trim().startsWith(fence)) fence = undefined;
      continue;
    }
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      fence = fenceMatch[1];
      openItems.length = 0;
      output.push(line);
      continue;
    }
    const expanded = line.replace(/\t/g, '    ');
    const item = ITEM.exec(expanded);
    if (!item) {
      if (expanded.trim() && !/^\s/.test(expanded)) openItems.length = 0;
      output.push(openItems.length > 0 ? expanded.trimStart() : line);
      continue;
    }
    const indent = item[1]?.length ?? 0;
    while (openItems.length > 0 && indent <= (openItems[openItems.length - 1] ?? 0)) openItems.pop();
    const depth = openItems.length;
    openItems.push(indent);
    output.push(depth === 0 ? expanded.trimStart() : nestedItem(depth, item[2] ?? '-', item[3] ?? ''));
  }
  return output.join('\n');
}

function nestedItem(depth: number, marker: string, text: string): string {
  const symbol = /\d/.test(marker) ? marker : depth === 1 ? '◦' : '▪';
  return `- ${NBSP.repeat(INDENT_PER_LEVEL * depth)}${symbol} ${text}`;
}
