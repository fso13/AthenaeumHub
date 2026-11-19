/**
 * Safe, dependency-free Markdown subset for managed chat messages.
 *
 * Supported blocks: paragraphs, blockquotes, ordered/unordered lists and
 * fenced code blocks. Supported inline: bold, italic, strike, inline code,
 * http(s) links and @mentions.
 *
 * Security model:
 * - the parser returns an AST, never HTML; `RichText` renders text nodes and a
 *   fixed set of React elements, so raw HTML stays visible text;
 * - links are allowlisted to `http:`/`https:` and invalid targets stay literal;
 * - unknown/malformed syntax is not "repaired" into markup: unmatched
 *   delimiters and unclosed fences remain text;
 * - code blocks and inline code never interpret Markdown or mentions.
 */
import { safeHttpUrl } from '../files/format';
import { buildMentionIndex, matchMentionAt, type MentionIndex } from './mentions';

export interface RichTextText {
  readonly type: 'text';
  readonly text: string;
}

export interface RichTextStrong {
  readonly type: 'strong';
  readonly children: readonly RichInlineNode[];
}

export interface RichTextEm {
  readonly type: 'em';
  readonly children: readonly RichInlineNode[];
}

export interface RichTextDel {
  readonly type: 'del';
  readonly children: readonly RichInlineNode[];
}

export interface RichTextCode {
  readonly type: 'code';
  readonly text: string;
}

export interface RichTextLink {
  readonly type: 'link';
  readonly href: string;
  readonly children: readonly RichInlineNode[];
}

export interface RichTextMention {
  readonly type: 'mention';
  readonly name: string;
  readonly all: boolean;
}

export type RichInlineNode =
  | RichTextText
  | RichTextStrong
  | RichTextEm
  | RichTextDel
  | RichTextCode
  | RichTextLink
  | RichTextMention;

export interface RichParagraph {
  readonly type: 'paragraph';
  readonly children: readonly RichInlineNode[];
}

export interface RichQuote {
  readonly type: 'quote';
  readonly children: readonly RichInlineNode[];
}

export interface RichList {
  readonly type: 'list';
  readonly ordered: boolean;
  /** First ordered number; irrelevant for unordered lists. */
  readonly start: number;
  readonly items: readonly (readonly RichInlineNode[])[];
}

export interface RichCodeBlock {
  readonly type: 'code';
  readonly lang: string | null;
  readonly code: string;
}

export type RichBlockNode = RichParagraph | RichQuote | RichList | RichCodeBlock;

export interface RichTextOptions {
  /** Display names of active workspace members for mention chips. */
  readonly mentions?: readonly string[];
}

const FENCE_OPEN = /^ {0,3}(`{3,})([^`]*)$/;
const QUOTE_LINE = /^ {0,3}> ?(.*)$/;
const UNORDERED_ITEM = /^ {0,3}[-*+] +(.*)$/;
const ORDERED_ITEM = /^ {0,3}(\d{1,9})[.)] +(.*)$/;
const WHITESPACE = /^\s*$/;
const INDENTED = /^\s{2,}\S/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const ESCAPABLE = '\\`*_~{}[]()#+-.!>|';

function isBlank(line: string): boolean {
  return WHITESPACE.test(line);
}

function isWordChar(char: string): boolean {
  return char.length > 0 && WORD_CHAR.test(char);
}

function countRun(text: string, start: number, char: string): number {
  let run = 0;
  while (text.charAt(start + run) === char) run += 1;
  return run;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Finds the next unescaped occurrence of `delimiter`, ignoring escaped ones. */
function findDelimiter(text: string, from: number, delimiter: string): number {
  let cursor = text.indexOf(delimiter, from);
  while (cursor >= 0) {
    if (!isEscaped(text, cursor)) return cursor;
    cursor = text.indexOf(delimiter, cursor + delimiter.length);
  }
  return -1;
}

function findClosingBackticks(text: string, from: number, run: number): number {
  const delimiter = '`'.repeat(run);
  let cursor = text.indexOf(delimiter, from);
  while (cursor >= 0) {
    // The close run must not be part of a longer run: ``` inside `code` is text.
    if (text.charAt(cursor + run) !== '`' && !isEscaped(text, cursor)) return cursor;
    cursor = text.indexOf(delimiter, cursor + 1);
  }
  return -1;
}

function findItalicClose(text: string, from: number, char: string): number {
  let cursor = text.indexOf(char, from);
  while (cursor >= 0) {
    if (isEscaped(text, cursor)) {
      cursor = text.indexOf(char, cursor + 1);
      continue;
    }
    // `**` is handled by the strong branch; a single `*` must not close inside it.
    if (text.charAt(cursor + 1) === char) {
      cursor = text.indexOf(char, cursor + 2);
      continue;
    }
    if (char === '_' && isWordChar(text.charAt(cursor + 1))) {
      cursor = text.indexOf(char, cursor + 1);
      continue;
    }
    return cursor;
  }
  return -1;
}

function validEmphasisInner(inner: string): boolean {
  return inner.length > 0 && !/^\s/.test(inner) && !/\s$/.test(inner);
}

function parseLinkAt(
  text: string,
  start: number,
  allowLinks: boolean,
): { href: string; label: string; end: number } | null {
  if (!allowLinks || text.charAt(start) !== '[') return null;
  const closeBracket = text.indexOf('](', start + 1);
  if (closeBracket < 0) return null;
  const label = text.slice(start + 1, closeBracket);
  if (label.length === 0 || label.includes('\n')) return null;
  const closeParen = text.indexOf(')', closeBracket + 2);
  if (closeParen < 0) return null;
  const rawHref = text.slice(closeBracket + 2, closeParen).trim();
  if (rawHref.length === 0 || rawHref.includes('\n')) return null;
  const href = safeHttpUrl(rawHref);
  if (href === null) return null;
  return { href, label, end: closeParen + 1 };
}

function parseInlineRange(
  text: string,
  index: MentionIndex,
  allowLinks: boolean,
  depth: number,
): RichInlineNode[] {
  if (text.length === 0) return [];
  // Deep nesting is not useful in a chat message; degrade to text instead of
  // recursing without a bound.
  if (depth > 6) return [{ type: 'text', text }];

  const nodes: RichInlineNode[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer.length > 0) {
      nodes.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  let cursor = 0;
  while (cursor < text.length) {
    const char = text.charAt(cursor);

    if (char === '\\' && ESCAPABLE.includes(text.charAt(cursor + 1))) {
      buffer += text.charAt(cursor + 1);
      cursor += 2;
      continue;
    }

    if (char === '`') {
      const run = countRun(text, cursor, '`');
      const close = findClosingBackticks(text, cursor + run, run);
      if (close >= 0) {
        flush();
        let code = text.slice(cursor + run, close).replace(/\r\n?/g, '\n');
        // Markdown code spans trim one padding space on both sides.
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) {
          code = code.slice(1, -1);
        }
        nodes.push({ type: 'code', text: code });
        cursor = close + run;
        continue;
      }
      buffer += char;
      cursor += 1;
      continue;
    }

    if (char === '@') {
      const mention = matchMentionAt(text, cursor, index);
      if (mention !== null) {
        flush();
        nodes.push({ type: 'mention', name: mention.name, all: mention.all });
        cursor += mention.length;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const pair = char + char;
      if (text.startsWith(pair, cursor)) {
        const openingOk = char !== '_' || cursor === 0 || !isWordChar(text.charAt(cursor - 1));
        const close = openingOk ? findDelimiter(text, cursor + 2, pair) : -1;
        const inner = close >= 0 ? text.slice(cursor + 2, close) : '';
        const closingOk =
          close < 0 ||
          char !== '_' ||
          close + 2 >= text.length ||
          !isWordChar(text.charAt(close + 2));
        if (openingOk && close >= 0 && closingOk && validEmphasisInner(inner)) {
          flush();
          nodes.push({
            type: 'strong',
            children: parseInlineRange(inner, index, allowLinks, depth + 1),
          });
          cursor = close + 2;
          continue;
        }
      }
      if (char === '*' || cursor === 0 || !isWordChar(text.charAt(cursor - 1))) {
        const close = findItalicClose(text, cursor + 1, char);
        if (close > cursor + 1) {
          const inner = text.slice(cursor + 1, close);
          const closingOk =
            char !== '_' || close + 1 >= text.length || !isWordChar(text.charAt(close + 1));
          if (closingOk && validEmphasisInner(inner)) {
            flush();
            nodes.push({
              type: 'em',
              children: parseInlineRange(inner, index, allowLinks, depth + 1),
            });
            cursor = close + 1;
            continue;
          }
        }
      }
      buffer += char;
      cursor += 1;
      continue;
    }

    if (char === '~' && text.startsWith('~~', cursor)) {
      const close = findDelimiter(text, cursor + 2, '~~');
      if (close >= 0) {
        const inner = text.slice(cursor + 2, close);
        if (validEmphasisInner(inner)) {
          flush();
          nodes.push({
            type: 'del',
            children: parseInlineRange(inner, index, allowLinks, depth + 1),
          });
          cursor = close + 2;
          continue;
        }
      }
      buffer += char;
      cursor += 1;
      continue;
    }

    if (char === '[' && allowLinks) {
      const link = parseLinkAt(text, cursor, allowLinks);
      if (link !== null) {
        flush();
        nodes.push({
          type: 'link',
          href: link.href,
          children: parseInlineRange(link.label, index, false, depth + 1),
        });
        cursor = link.end;
        continue;
      }
    }

    buffer += char;
    cursor += 1;
  }

  flush();
  return nodes;
}

/** Parses inline Markdown (no block structure). Used by previews and tests. */
export function parseInline(text: string, mentions: readonly string[] = []): RichInlineNode[] {
  return parseInlineRange(text, buildMentionIndex(mentions), true, 0);
}

/**
 * Plain-text + mention chips only. Used for quote bars and thread previews,
 * where block Markdown would break the single-line layout.
 */
export function parseMentionText(text: string, mentions: readonly string[] = []): RichInlineNode[] {
  const index = buildMentionIndex(mentions);
  const nodes: RichInlineNode[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer.length > 0) {
      nodes.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  let cursor = 0;
  while (cursor < text.length) {
    const char = text.charAt(cursor);
    if (char === '@') {
      const mention = matchMentionAt(text, cursor, index);
      if (mention !== null) {
        flush();
        nodes.push({ type: 'mention', name: mention.name, all: mention.all });
        cursor += mention.length;
        continue;
      }
    }
    buffer += char;
    cursor += 1;
  }
  flush();
  return nodes;
}

function normalizeLanguage(raw: string | null): string | null {
  if (!raw) return null;
  const token = raw.trim().toLocaleLowerCase('en');
  if (token.length === 0) return null;
  const match = /^[a-z0-9+#._-]{1,32}/.exec(token);
  return match?.[0] ?? null;
}

function parseFence(line: string): { marker: string; lang: string | null } | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const marker = match[1] ?? '';
  if (marker.length === 0) return null;
  const info = (match[2] ?? '').trim();
  const first = info.split(/\s+/)[0] ?? '';
  return { marker, lang: normalizeLanguage(first) };
}

function isFenceClose(line: string, marker: string): boolean {
  if (!/^ {0,3}`+\s*$/.test(line)) return false;
  return countRun(line.trim(), 0, '`') >= marker.length;
}

function startsBlock(line: string): boolean {
  return (
    parseFence(line) !== null ||
    QUOTE_LINE.test(line) ||
    UNORDERED_ITEM.test(line) ||
    ORDERED_ITEM.test(line)
  );
}

/**
 * Block parser. It intentionally does not implement headings, tables, images
 * or embedded HTML: those are out of scope and would only widen the attack
 * surface.
 */
export function parseRichText(text: string, options: RichTextOptions = {}): RichBlockNode[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const mentionIndex = buildMentionIndex(options.mentions);
  const blocks: RichBlockNode[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (isBlank(line)) {
      cursor += 1;
      continue;
    }

    const fence = parseFence(line);
    if (fence !== null) {
      let close = -1;
      for (let scan = cursor + 1; scan < lines.length; scan += 1) {
        if (isFenceClose(lines[scan] ?? '', fence.marker)) {
          close = scan;
          break;
        }
      }
      if (close >= 0) {
        blocks.push({
          type: 'code',
          lang: fence.lang,
          code: lines.slice(cursor + 1, close).join('\n'),
        });
        cursor = close + 1;
        continue;
      }
      // Unclosed fence: malformed Markdown stays text. Fall through to the
      // paragraph branch, which starts with the fence line itself.
    }

    if (QUOTE_LINE.test(line)) {
      const quoteLines: string[] = [];
      while (cursor < lines.length) {
        const match = QUOTE_LINE.exec(lines[cursor] ?? '');
        if (!match) break;
        quoteLines.push(match[1] ?? '');
        cursor += 1;
      }
      blocks.push({
        type: 'quote',
        children: parseInlineRange(quoteLines.join('\n'), mentionIndex, true, 0),
      });
      continue;
    }

    const unordered = UNORDERED_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (unordered !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? Number(ordered[1] ?? 1) : 1;
      const items: RichInlineNode[][] = [];

      while (cursor < lines.length) {
        const current = lines[cursor] ?? '';
        const item = isOrdered ? ORDERED_ITEM.exec(current) : UNORDERED_ITEM.exec(current);
        if (!item) break;
        const itemLines = [isOrdered ? (item[2] ?? '') : (item[1] ?? '')];
        cursor += 1;

        // Continuation lines (two or more spaces) belong to the current item.
        while (cursor < lines.length) {
          const next = lines[cursor] ?? '';
          if (isBlank(next) || startsBlock(next)) break;
          if (!INDENTED.test(next)) break;
          itemLines.push(next.trim());
          cursor += 1;
        }

        items.push(parseInlineRange(itemLines.join('\n'), mentionIndex, true, 0));
      }

      blocks.push({
        type: 'list',
        ordered: isOrdered,
        start: Number.isFinite(start) && start > 0 ? start : 1,
        items,
      });
      continue;
    }

    const paragraphLines: string[] = [];
    const paragraphStart = cursor;
    while (cursor < lines.length) {
      const current = lines[cursor] ?? '';
      if (isBlank(current)) break;
      // The first line is always consumed, including a malformed fence; only
      // subsequent block starts terminate the paragraph.
      if (cursor > paragraphStart && startsBlock(current)) break;
      paragraphLines.push(current);
      cursor += 1;
    }
    blocks.push({
      type: 'paragraph',
      children: parseInlineRange(paragraphLines.join('\n'), mentionIndex, true, 0),
    });
  }

  return blocks;
}
