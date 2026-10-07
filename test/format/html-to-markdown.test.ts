import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { htmlToMarkdown } from '../../src/format/html-to-markdown.ts';

describe('htmlToMarkdown', () => {
  it('returns an empty string for empty descriptions', () => {
    assert.equal(htmlToMarkdown(null), '');
    assert.equal(htmlToMarkdown('<p></p>'), '');
  });

  it('converts paragraphs, line breaks and inline formatting', () => {
    assert.equal(
      htmlToMarkdown('<p>Текст с <strong>жирным</strong>, <em>курсивом</em>, <del>зачёркнутым</del>, <code>кодом</code> и <a href="https://example.com/a">ссылкой</a>.<br>Вторая строка.</p>\n<p>Второй абзац</p>'),
      'Текст с **жирным**, *курсивом*, ~~зачёркнутым~~, `кодом` и [ссылкой](https://example.com/a).\nВторая строка.\n\nВторой абзац',
    );
  });

  it('keeps spaces outside of emphasis markers and drops empty ones', () => {
    assert.equal(htmlToMarkdown('<p>a<strong> b </strong>c<em></em></p>'), 'a **b** c');
  });

  it('shows a link whose text is the URL as a bare URL, including links inside code', () => {
    assert.equal(
      htmlToMarkdown('<p><a href="https://example.com/">https://example.com/</a> и <code><a href="https://api.example.com/">https://api.example.com/</a></code></p>'),
      'https://example.com/ и `https://api.example.com/`',
    );
  });

  it('converts headings, rules, quotes and code blocks', () => {
    assert.equal(
      htmlToMarkdown('<h2>Раздел</h2>\n<blockquote><p>Цитата</p><p>Ещё</p></blockquote>\n<hr>\n<pre><code class="language-json">{\n  "a": 1\n}\n</code></pre>'),
      '## Раздел\n\n> Цитата\n>\n> Ещё\n\n---\n\n```json\n{\n  "a": 1\n}\n```',
    );
  });

  it('uses a longer fence when the code contains backticks', () => {
    assert.equal(htmlToMarkdown('<pre><code>a ``` b</code></pre>'), '````\na ``` b\n````');
  });

  it('converts nested lists the way the Weeek editor writes them', () => {
    const html =
      '<ul><li><p>Пункт 1</p>\n<ul><li><p>Подпункт 1.1</p></li><li><p>Подпункт 1.2</p>\n<ul><li><p>Глубже</p></li></ul></li></ul></li><li><p>Пункт 2</p></li></ul>\n' +
      '<ol><li value="1"><p>Первый</p></li><li value="2"><p>Второй</p></li></ol>';
    assert.equal(
      htmlToMarkdown(html),
      '- Пункт 1\n  - Подпункт 1.1\n  - Подпункт 1.2\n    - Глубже\n- Пункт 2\n\n1. Первый\n2. Второй',
    );
  });

  it('respects start and value attributes of ordered lists', () => {
    assert.equal(htmlToMarkdown('<ol start="3"><li>c</li><li value="7">g</li><li>h</li></ol>'), '3. c\n7. g\n8. h');
  });

  it('indents multi-line list items under their marker', () => {
    assert.equal(htmlToMarkdown('<ol><li><p>Строка<br>продолжение</p></li></ol>'), '1. Строка\n   продолжение');
  });

  it('converts tables without thead into GFM tables', () => {
    const html =
      '<table><tr><td><p><strong>Метод</strong></p></td>\n<td><p><strong>Путь</strong></p></td></tr>\n' +
      '<tr><td><p>GET</p></td>\n<td><p><code>/v1/items</code></p></td></tr>\n<tr><td><p>a|b</p></td></tr></table>';
    assert.equal(htmlToMarkdown(html), '| **Метод** | **Путь** |\n| --- | --- |\n| GET | `/v1/items` |\n| a\\|b |  |');
  });

  it('decodes entities and collapses whitespace', () => {
    assert.equal(htmlToMarkdown('<p>a &amp; b &lt;tag&gt; &quot;q&quot; &#8212; &#x41;&nbsp;c\n   d</p>'), 'a & b <tag> "q" — A c d');
  });

  it('ignores scripts and comments and tolerates broken markup', () => {
    assert.equal(htmlToMarkdown('<p>a<script>alert("<p>x</p>")</script><!-- note -->b</p><p>unclosed <strong>bold'), 'ab\n\nunclosed **bold**');
  });

  it('wraps bare text and images', () => {
    assert.equal(htmlToMarkdown('plain <img src="https://example.com/i.png" alt="pic"> text'), 'plain ![pic](https://example.com/i.png) text');
  });
});
