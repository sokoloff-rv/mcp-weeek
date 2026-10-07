import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flattenNestedLists } from '../../src/format/comment-markdown.ts';

const NBSP = String.fromCharCode(0xa0);
const pad = (levels: number) => NBSP.repeat(4 * levels);

describe('flattenNestedLists', () => {
  it('leaves flat text and lists alone', () => {
    const text = 'Итог:\n\n- сделано\n- проверено\n\n1. раз\n2. два';
    assert.equal(flattenNestedLists(text), text);
  });

  it('turns nested bullets into top-level items with a visible indent', () => {
    assert.equal(
      flattenNestedLists('- Пункт\n  - Подпункт\n    - Глубже\n  - Ещё подпункт\n- Пункт 2'),
      ['- Пункт', `- ${pad(1)}◦ Подпункт`, `- ${pad(2)}▪ Глубже`, `- ${pad(1)}◦ Ещё подпункт`, '- Пункт 2'].join('\n'),
    );
  });

  it('keeps the numbers of nested ordered items', () => {
    assert.equal(flattenNestedLists('1. Шаг\n   1. Подшаг\n   2. Подшаг\n2. Шаг'), ['1. Шаг', `- ${pad(1)}1. Подшаг`, `- ${pad(1)}2. Подшаг`, '2. Шаг'].join('\n'));
  });

  it('treats tabs as indentation', () => {
    assert.equal(flattenNestedLists('- a\n\t- b'), `- a\n- ${pad(1)}◦ b`);
  });

  it('pulls continuation lines of nested items to the left', () => {
    assert.equal(flattenNestedLists('- a\n  - b\n    продолжение b'), `- a\n- ${pad(1)}◦ b\nпродолжение b`);
  });

  it('does not touch code blocks', () => {
    const text = '- a\n```\n  - not a list\n```\n  - after fence';
    assert.equal(flattenNestedLists(text), text.replace('  - after fence', '- after fence'));
  });

  it('starts over after a top-level paragraph', () => {
    assert.equal(flattenNestedLists('- a\n  - b\nТекст\n  - c'), `- a\n- ${pad(1)}◦ b\nТекст\n- c`);
  });
});
