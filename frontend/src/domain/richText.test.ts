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

function inlineText(nodes: readonly RichInlineNode[]): string {
  let text = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
        text += node.text;
        break;
      case 'mention':
        text += node.all ? '@all' : `@${node.name}`;
        break;
      case 'image':
        text += node.alt;
        break;
      default:
        text += inlineText(node.children);
        break;
    }
  }
  return text;
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

describe('extended safe markdown blocks', () => {
  it('parses ATX headings from level 1 to 6 and strips closing hashes', () => {
    const blocks = parseRichText(
      '# Один\n\n## Два\n\n### Три\n\n#### Четыре\n\n##### Пять\n\n###### Шесть',
    );
    expect(blocks.map((block) => (block.type === 'heading' ? block.level : null))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(blocks[0]).toMatchObject({
      type: 'heading',
      level: 1,
      children: [{ type: 'text', text: 'Один' }],
    });
    expect(parseRichText('## Заголовок ##')[0]).toMatchObject({
      type: 'heading',
      level: 2,
      children: [{ type: 'text', text: 'Заголовок' }],
    });
  });

  it('keeps hashtags and seven-hash lines as plain paragraphs', () => {
    for (const text of ['#хештег', '####### семь', '#без пробела']) {
      const blocks = parseRichText(text);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('paragraph');
      if (blocks[0]?.type === 'paragraph') {
        expect(inlineText(blocks[0].children)).toBe(text);
      }
    }
  });

  it('parses thematic breaks without turning emphasis or lists into rules', () => {
    expect(parseRichText('---')).toEqual([{ type: 'thematicBreak' }]);
    expect(parseRichText('***')).toEqual([{ type: 'thematicBreak' }]);
    expect(parseRichText('- - -')).toEqual([{ type: 'thematicBreak' }]);
    expect(parseRichText('до\n\n---\n\nпосле').map((block) => block.type)).toEqual([
      'paragraph',
      'thematicBreak',
      'paragraph',
    ]);
    expect(parseRichText('**жирный**')[0]?.type).toBe('paragraph');
    expect(parseRichText('- пункт')[0]?.type).toBe('list');
  });

  it('parses a GFM table with alignment, escaped pipes and inline code', () => {
    const blocks = parseRichText(
      '| Команда | Баллы | Комментарий |\n| :--- | ---: | :---: |\n| Сова | 42 | `a|b` |\n| Кот \\| пёс | 7 | **ок** |',
    );
    expect(blocks).toHaveLength(1);
    const table = blocks[0];
    expect(table).toMatchObject({
      type: 'table',
      align: ['left', 'right', 'center'],
    });
    if (table?.type !== 'table') return;
    expect(table.header.map((cell) => inlineText(cell))).toEqual([
      'Команда',
      'Баллы',
      'Комментарий',
    ]);
    expect(table.rows).toHaveLength(2);
    expect(inlineText(table.rows[0]?.[0] ?? [])).toBe('Сова');
    expect(inlineText(table.rows[1]?.[0] ?? [])).toBe('Кот | пёс');
    expect(table.rows[0]?.[2]).toEqual([{ type: 'code', text: 'a|b' }]);
    expect(table.rows[1]?.[2]?.[0]).toMatchObject({ type: 'strong' });
  });

  it('supports a single-column table and pads short rows', () => {
    const blocks = parseRichText('| Значение |\n| --- |\n| одно |\n| два | три |');
    const table = blocks[0];
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') return;
    expect(table.header).toHaveLength(1);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]).toHaveLength(1);
    expect(inlineText(table.rows[1]?.[0] ?? [])).toBe('два');
  });

  it('keeps malformed tables as paragraphs', () => {
    const blocks = parseRichText('a | b\nnot a delimiter');
    expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
    if (blocks[0]?.type === 'paragraph') {
      expect(inlineText(blocks[0].children)).toBe('a | b\nnot a delimiter');
    }
    expect(parseRichText('| a | b |\n| --- |')[0]?.type).toBe('paragraph');
  });

  it('parses nested unordered and ordered lists at two and four spaces', () => {
    const twoSpaces = parseRichText('- один\n  - вложенный\n    - глубже\n- два');
    expect(twoSpaces.map((block) => block.type)).toEqual(['list']);
    const list = twoSpaces[0];
    if (list?.type !== 'list') return;
    expect(list.items).toHaveLength(2);
    expect(inlineText(list.items[0]?.children ?? [])).toBe('один');
    const firstChild = list.items[0]?.blocks[0];
    expect(firstChild?.type).toBe('list');
    if (firstChild?.type === 'list') {
      expect(firstChild.items).toHaveLength(1);
      const deep = firstChild.items[0]?.blocks[0];
      expect(deep?.type).toBe('list');
      if (deep?.type === 'list') {
        expect(inlineText(deep.items[0]?.children ?? [])).toBe('глубже');
      }
    }

    const fourSpaces = parseRichText('- родитель\n    - ребёнок');
    const outer = fourSpaces[0];
    if (outer?.type !== 'list') return;
    expect(outer.items[0]?.blocks[0]?.type).toBe('list');

    const mixed = parseRichText('- шаг\n  1. первый\n  2. второй');
    const orderedParent = mixed[0];
    if (orderedParent?.type !== 'list') return;
    const orderedChild = orderedParent.items[0]?.blocks[0];
    expect(orderedChild).toMatchObject({ type: 'list', ordered: true, start: 1 });
    if (orderedChild?.type === 'list') expect(orderedChild.items).toHaveLength(2);
  });

  it('keeps a loose list as one list and allows extra item paragraphs', () => {
    const blocks = parseRichText('- один\n\n- два\n\n  второй абзац');
    expect(blocks).toHaveLength(1);
    const list = blocks[0];
    if (list?.type !== 'list') return;
    expect(list.items).toHaveLength(2);
    expect(list.items[1]?.blocks[0]?.type).toBe('paragraph');
  });

  it('parses multi-paragraph, nested and Markdown blockquotes', () => {
    const blocks = parseRichText(
      '> Первый абзац\n>\n> Второй **жирный**\n> > вложенная цитата\n> ## Заголовок\n> - пункт',
    );
    const quote = blocks[0];
    expect(quote?.type).toBe('quote');
    if (quote?.type !== 'quote') return;
    expect(quote.children.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'quote',
      'heading',
      'list',
    ]);
    expect(quote.children[1]?.type).toBe('paragraph');
    if (quote.children[1]?.type === 'paragraph') {
      expect(quote.children[1].children[1]).toMatchObject({ type: 'strong' });
    }
  });

  it('parses read-only task lists and leaves unknown markers as text', () => {
    const blocks = parseRichText('- [ ] сделать\n- [x] готово\n- [X] тоже готово\n- обычный');
    const list = blocks[0];
    expect(list).toMatchObject({ type: 'list', ordered: false });
    if (list?.type !== 'list') return;
    expect(list.items.map((item) => item.task)).toEqual(['unchecked', 'checked', 'checked', null]);
    expect(inlineText(list.items[0]?.children ?? [])).toBe('сделать');
    expect(inlineText(list.items[3]?.children ?? [])).toBe('обычный');
    const unknown = parseRichText('- [y] не задача');
    const unknownList = unknown[0];
    if (unknownList?.type === 'list') {
      expect(unknownList.items[0]?.task).toBeNull();
      expect(inlineText(unknownList.items[0]?.children ?? [])).toBe('[y] не задача');
    }
  });
});

describe('extended safe markdown inline', () => {
  it('allows http(s) images and extracts plain-text alt', () => {
    expect(parseInline('![Сова **на ветке**](https://example.com/owl.png)')).toEqual([
      {
        type: 'image',
        src: 'https://example.com/owl.png',
        alt: 'Сова на ветке',
      },
    ]);
  });

  it('rejects unsafe, data, ftp and SVG images as literal text', () => {
    for (const unsafe of [
      '![x](javascript:alert(1))',
      '![x](data:image/png;base64,AAAA)',
      '![x](ftp://example.com/a.png)',
      '![x](https://example.com/a.svg)',
      '![x](https://example.com/a.SVG?raw=1)',
      '![x](https://example.com/a.svgz)',
      '![x](https://example.com/a%2Esvg)',
    ]) {
      const children = paragraphChildren(unsafe);
      expect(children.some((node) => node.type === 'image')).toBe(false);
      expect(inlineText(children)).toBe(unsafe);
    }
  });

  it('parses angle and bare http(s) autolinks safely', () => {
    const children = parseInline('Смотри <https://example.com/a> и https://example.com/b.');
    expect(children.map((node) => node.type)).toEqual(['text', 'link', 'text', 'link', 'text']);
    expect(children[1]).toMatchObject({
      type: 'link',
      href: 'https://example.com/a',
      children: [{ type: 'text', text: 'https://example.com/a' }],
    });
    expect(children[3]).toMatchObject({
      type: 'link',
      href: 'https://example.com/b',
      children: [{ type: 'text', text: 'https://example.com/b' }],
    });
    expect(children[4]).toEqual({ type: 'text', text: '.' });
  });

  it('does not autolink inside malformed links, code or raw HTML attributes', () => {
    const malformed = paragraphChildren('[x](https://example.com');
    expect(malformed.every((node) => node.type === 'text')).toBe(true);
    expect(inlineText(malformed)).toBe('[x](https://example.com');

    const code = paragraphChildren('`<https://example.com>`');
    expect(code).toEqual([{ type: 'code', text: '<https://example.com>' }]);

    const html = paragraphChildren('<a href="https://example.com">x</a>');
    expect(html.every((node) => node.type === 'text')).toBe(true);
  });

  it('keeps raw HTML and hostile image syntax as text with no image nodes', () => {
    const text = '<script>alert(1)</script> <img src=x onerror=alert(1)> ![x](javascript:alert(1))';
    const children = paragraphChildren(text);
    expect(children.some((node) => node.type === 'image')).toBe(false);
    expect(inlineText(children)).toBe(text);
  });
});
