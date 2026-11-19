import { describe, expect, it } from 'vitest';
import { parseInline, parseMentionText, parseRichText, type RichInlineNode } from './richText';

function paragraphChildren(
  text: string,
  mentions: readonly string[] = [],
): readonly RichInlineNode[] {
  const blocks = parseRichText(text, { mentions });
  const paragraph = blocks[0];
  if (paragraph?.type !== 'paragraph')
    throw new Error(`Expected a paragraph, got ${paragraph?.type}`);
  return paragraph.children;
}

describe('safe markdown parser', () => {
  it('parses bold, italic, strike and inline code', () => {
    const children = paragraphChildren('**жирный** _курсив_ ~~зачёркнуто~~ `const a = 1`');
    expect(children.map((node) => node.type)).toEqual([
      'strong',
      'text',
      'em',
      'text',
      'del',
      'text',
      'code',
    ]);
    expect(children[0]).toMatchObject({
      type: 'strong',
      children: [{ type: 'text', text: 'жирный' }],
    });
    expect(children[6]).toMatchObject({ type: 'code', text: 'const a = 1' });
  });

  it('parses paragraphs, line breaks, quotes and lists', () => {
    const blocks = parseRichText(
      'Первая строка\nвторая\n\n> цитата\n\n- один\n- два\n\n3. три\n4. четыре',
    );
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'quote', 'list', 'list']);
    const first = blocks[0];
    expect(first?.type).toBe('paragraph');
    if (first?.type === 'paragraph') {
      expect(first.children).toEqual([{ type: 'text', text: 'Первая строка\nвторая' }]);
    }
    const ordered = blocks[3];
    expect(ordered).toMatchObject({ type: 'list', ordered: true, start: 3 });
  });

  it('parses fenced code with a language and keeps its content raw', () => {
    const code = '```ts\nconst x = "**not bold**";\n```';
    const blocks = parseRichText(code);
    expect(blocks).toEqual([{ type: 'code', lang: 'ts', code: 'const x = "**not bold**";' }]);
  });

  it('keeps an unclosed fence as text instead of inventing a code block', () => {
    const blocks = parseRichText('```ts\nconst x = 1');
    expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
    const paragraph = blocks[0];
    if (paragraph?.type === 'paragraph') {
      expect(paragraph.children).toEqual([{ type: 'text', text: '```ts\nconst x = 1' }]);
    }
  });

  it('keeps malformed emphasis and raw HTML as text', () => {
    const text = '**не закрыто и <script>alert(1)</script> <img src=x onerror=alert(1)>';
    const children = paragraphChildren(text);
    expect(children).toEqual([{ type: 'text', text }]);
  });

  it('parses http(s) links and rejects unsafe or malformed targets', () => {
    const safe = paragraphChildren('[сайт](https://example.com/a?b=1)');
    expect(safe).toEqual([
      {
        type: 'link',
        href: 'https://example.com/a?b=1',
        children: [{ type: 'text', text: 'сайт' }],
      },
    ]);

    for (const unsafe of [
      '[x](javascript:alert(1))',
      '[x](data:text/html,<script>alert(1)</script>)',
      '[x](ftp://example.com/file)',
      '[x](https://example.com',
    ]) {
      const children = paragraphChildren(unsafe);
      expect(children.some((node) => node.type === 'link')).toBe(false);
      expect(children.map((node) => (node.type === 'text' ? node.text : '')).join('')).toBe(unsafe);
    }
  });

  it('does not parse markdown or mentions inside code', () => {
    const blocks = parseRichText('```\n@all **bold** `nested`\n```', {
      mentions: ['Анна Петрова'],
    });
    expect(blocks).toEqual([{ type: 'code', lang: null, code: '@all **bold** `nested`' }]);
    const inline = paragraphChildren('`@all **bold**`', ['Анна Петрова']);
    expect(inline).toEqual([{ type: 'code', text: '@all **bold**' }]);
  });

  it('renders known mentions and @all as chips, with no email false positives', () => {
    const children = paragraphChildren(
      'Привет, @Анна Петрова и @all! Почта: dmitry@example.test, ещё @Неизвестный',
      ['Анна Петрова'],
    );
    expect(children).toEqual([
      { type: 'text', text: 'Привет, ' },
      { type: 'mention', name: 'Анна Петрова', all: false },
      { type: 'text', text: ' и ' },
      { type: 'mention', name: 'all', all: true },
      { type: 'text', text: '! Почта: dmitry@example.test, ещё @Неизвестный' },
    ]);
  });

  it('renders @all even when the member directory is empty', () => {
    expect(paragraphChildren('@all', [])).toEqual([{ type: 'mention', name: 'all', all: true }]);
    expect(parseMentionText('@all', [])).toEqual([{ type: 'mention', name: 'all', all: true }]);
  });

  it('uses the longest member name and requires word boundaries', () => {
    const children = parseInline('@Анна Петрова и @АннаПетрова', ['Анна', 'Анна Петрова']);
    expect(children).toEqual([
      { type: 'mention', name: 'Анна Петрова', all: false },
      { type: 'text', text: ' и @АннаПетрова' },
    ]);
  });

  it('parses a light mention preview without block markdown', () => {
    const nodes = parseMentionText('**не жирный** @Анна Петрова', ['Анна Петрова']);
    expect(nodes).toEqual([
      { type: 'text', text: '**не жирный** ' },
      { type: 'mention', name: 'Анна Петрова', all: false },
    ]);
  });

  it('supports escapes and nested inline emphasis', () => {
    const children = paragraphChildren('\\*не курсив\\* и **жирный _курсив_**');
    expect(children[0]).toEqual({ type: 'text', text: '*не курсив* и ' });
    expect(children[1]?.type).toBe('strong');
    if (children[1]?.type === 'strong') {
      expect(children[1].children.map((node) => node.type)).toEqual(['text', 'em']);
    }
  });
});
