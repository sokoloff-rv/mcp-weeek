import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { htmlToMarkdown } from '../../src/format/html-to-markdown.ts';
import { markdownToHtml } from '../../src/format/markdown-to-html.ts';

describe('markdownToHtml', () => {
  it('turns paragraphs into <p> and single line breaks into <br>', () => {
    assert.equal(markdownToHtml('Первая строка\nвторая\n\nДругой абзац'), '<p>Первая строка<br>вторая</p><p>Другой абзац</p>');
  });

  it('escapes HTML in text', () => {
    assert.equal(markdownToHtml('a <script>alert(1)</script> & "b"'), '<p>a &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;b&quot;</p>');
  });

  it('renders inline formatting', () => {
    assert.equal(
      markdownToHtml('**жирный**, __тоже__, *курсив*, _и так_, ~~нет~~, `a < b`, snake_case_name, 2*3*4'),
      '<p><strong>жирный</strong>, <strong>тоже</strong>, <em>курсив</em>, <em>и так</em>, <del>нет</del>, <code>a &lt; b</code>, snake_case_name, 2<em>3</em>4</p>',
    );
  });

  it('renders links and keeps code untouched', () => {
    assert.equal(
      markdownToHtml('[сайт](https://example.com/a?b=1&c=2), <https://example.org>, https://example.net/x. `https://not.link`'),
      '<p><a href="https://example.com/a?b=1&amp;c=2">сайт</a>, <a href="https://example.org">https://example.org</a>, <a href="https://example.net/x">https://example.net/x</a>. <code>https://not.link</code></p>',
    );
  });

  it('does not create links with unsafe schemes', () => {
    assert.equal(markdownToHtml('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  });

  it('renders headings, rules, quotes and fenced code', () => {
    assert.equal(
      markdownToHtml('## Раздел\n\n---\n\n> цитата\n> **ещё**\n\n```js\nconst a = "<b>";\n\n```'),
      '<h2>Раздел</h2><hr><blockquote><p>цитата<br><strong>ещё</strong></p></blockquote><pre><code>const a = &quot;&lt;b&gt;&quot;;\n</code></pre>',
    );
  });

  it('renders nested lists the way the Weeek editor stores them', () => {
    assert.equal(
      markdownToHtml('- Пункт 1\n  - Подпункт\n    - Глубже\n- Пункт 2\n\n1. Шаг\n   1. Подшаг\n2. Шаг 2'),
      '<ul><li><p>Пункт 1</p><ul><li><p>Подпункт</p><ul><li><p>Глубже</p></li></ul></li></ul></li><li><p>Пункт 2</p></li></ul>' +
        '<ol><li><p>Шаг</p><ol><li><p>Подшаг</p></li></ol></li><li><p>Шаг 2</p></li></ol>',
    );
  });

  it('accepts two-space nesting under numbered items and keeps the start number', () => {
    assert.equal(markdownToHtml('3. Три\n  - деталь\n4. Четыре'), '<ol start="3"><li><p>Три</p><ul><li><p>деталь</p></li></ul></li><li><p>Четыре</p></li></ol>');
  });

  it('keeps loose list items with several paragraphs together', () => {
    assert.equal(markdownToHtml('- один\n\n  продолжение\n- два'), '<ul><li><p>один</p><p>продолжение</p></li><li><p>два</p></li></ul>');
  });

  it('shows task list checkboxes as symbols', () => {
    assert.equal(markdownToHtml('- [x] готово\n- [ ] нет'), '<ul><li><p>☑ готово</p></li><li><p>☐ нет</p></li></ul>');
  });

  it('renders GFM tables with a header row', () => {
    assert.equal(
      markdownToHtml('| A | B |\n|---|:-:|\n| 1 | `x\\|y` |'),
      '<table><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p><code>x|y</code></p></td></tr></table>',
    );
  });

  it('starts a list right after a paragraph line', () => {
    assert.equal(markdownToHtml('Список:\n- a\n- b'), '<p>Список:</p><ul><li><p>a</p></li><li><p>b</p></li></ul>');
  });

  it('round-trips through htmlToMarkdown', () => {
    const markdown = [
      '## План',
      '',
      'Текст с **жирным** и [ссылкой](https://example.com).',
      '',
      '- Пункт',
      '  - Подпункт',
      '',
      '1. Шаг',
      '2. Шаг',
      '',
      '> Цитата',
      '',
      '```',
      'code()',
      '```',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    assert.equal(htmlToMarkdown(markdownToHtml(markdown)), markdown);
  });
});
