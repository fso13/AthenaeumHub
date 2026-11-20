/**
 * Safe, dependency-free Markdown subset for managed chat messages.
 *
 * Supported blocks: paragraphs, headings (`#`..`######`), thematic breaks,
 * blockquotes (multi-paragraph, nested Markdown), ordered/unordered lists with
 * nested levels, GFM tables, task lists (read-only) and fenced code blocks.
 * Supported inline: bold, italic, strike, inline code, http(s) links and
 * images, `<https://…>`/bare http(s) autolinks and @mentions.
 *
 * Security model:
 * - the parser returns an AST, never HTML; `RichText` renders text nodes and a
 *   fixed set of React elements, so raw HTML stays visible text;
 * - links and images are allowlisted to `http:`/`https:`; invalid targets stay
 *   literal. Images additionally reject SVG URLs and never accept `data:`;
 * - unknown/malformed syntax is not "repaired" into markup: unmatched
 *   delimiters and unclosed fences remain text;
 * - code blocks and inline code never interpret Markdown or mentions;
 * - nesting depth is bounded, so hostile input cannot recurse without limit.
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

export interface RichTextImage {
  readonly type: 'image';
  /** Already validated by `safeImageUrl`: absolute http(s), not SVG. */
  readonly src: string;
  /** Plain-text alternative, never markup. */
  readonly alt: string;
}

export type RichInlineNode =
  | RichTextText
  | RichTextStrong
  | RichTextEm
  | RichTextDel
  | RichTextCode
  | RichTextLink
  | RichTextMention
  | RichTextImage;

export interface RichParagraph {
  readonly type: 'paragraph';
  readonly children: readonly RichInlineNode[];
}

export type RichHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface RichHeading {
  readonly type: 'heading';
  readonly level: RichHeadingLevel;
  readonly children: readonly RichInlineNode[];
}

export interface RichQuote {
  readonly type: 'quote';
  /** Block children, so a quote may hold several paragraphs and nested Markdown. */
  readonly children: readonly RichBlockNode[];
}

export interface RichThematicBreak {
  readonly type: 'thematicBreak';
}

export type RichTableAlign = 'left' | 'center' | 'right';

export interface RichTable {
  readonly type: 'table';
  /** Per-column alignment; `null` means the default (left). */
  readonly align: readonly (RichTableAlign | null)[];
  readonly header: readonly (readonly RichInlineNode[])[];
  readonly rows: readonly (readonly (readonly RichInlineNode[])[])[];
}

export type RichTaskState = 'checked' | 'unchecked' | null;

export interface RichListItem {
  /** Read-only task state; `null` for regular list items. */
  readonly task: RichTaskState;
  /** Inline contents of the item's first paragraph. */
  readonly children: readonly RichInlineNode[];
  /** Additional blocks inside the item (nested lists, extra paragraphs, …). */
  readonly blocks: readonly RichBlockNode[];
}

export interface RichList {
  readonly type: 'list';
  readonly ordered: boolean;
  /** First ordered number; irrelevant for unordered lists. */
  readonly start: number;
  readonly items: readonly RichListItem[];
}

export interface RichCodeBlock {
  readonly type: 'code';
  readonly lang: string | null;
  readonly code: string;
}

export type RichBlockNode =
  | RichParagraph
  | RichHeading
  | RichQuote
  | RichThematicBreak
  | RichTable
  | RichList
  | RichCodeBlock;

export interface RichTextOptions {
  /** Display names of active workspace members for mention chips. */
  readonly mentions?: readonly string[];
}

const FENCE_OPEN = /^ {0,3}(`{3,})([^`]*)$/;
const QUOTE_LINE = /^ {0,3}> ?(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HEADING_CLOSING = /[ \t]+#+[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const LIST_ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])( {1,4})(.*)$/;
const TABLE_DELIMITER_CELL = /^:?-{3,}:?$/;
const TASK_PREFIX = /^\[([ xX])\](?:[ \t]+|$)([\s\S]*)$/;
const WHITESPACE = /^\s*$/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const ESCAPABLE = '\\`*_~{}[]()#+-.!>|';
const BARE_URL_BOUNDARY = /[\s\u00a0«»„“”—–:;,!?]/;
const MAX_BLOCK_DEPTH = 8;
const MAX_AUTOLINK_LENGTH = 2048;
const TRAILING_AUTOLINK_PUNCTUATION = '.,;:!?';

function isBlank(line: string): boolean {
  return WHITESPACE.test(line);
}

function leadingSpaces(line: string): number {
  const match = /^ */.exec(line);
  return match === null ? 0 : match[0].length;
}

function isWordChar(char: string): boolean {
  return char.length > 0 && WORD_CHAR.test(char);
}

function countRun(text: string, start: number, char: string): number {
  let run = 0;
  while (text.charAt(start + run) === char) run += 1;
  return run;
}

function countChar(text: string, char: string): number {
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) === char) total += 1;
  }
  return total;
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

/** Rejects SVG images (a scriptable format) in addition to non-http(s) URLs. */
function safeImageUrl(raw: string): string | null {
  const href = safeHttpUrl(raw);
  if (href === null) return null;
  try {
    let path = new URL(href).pathname.toLocaleLowerCase('en');
    try {
      path = decodeURIComponent(path);
    } catch {
      // Malformed percent-encoding: keep the raw path, it still fails closed.
    }
    if (path.endsWith('.svg') || path.endsWith('.svgz')) return null;
  } catch {
    return null;
  }
  return href;
}

function flattenInlineText(nodes: readonly RichInlineNode[]): string {
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
        text += flattenInlineText(node.children);
        break;
    }
  }
  return text;
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

type ImageParse =
  | { readonly status: 'ok'; readonly src: string; readonly alt: string; readonly end: number }
  | { readonly status: 'rejected'; readonly end: number };

/**
 * Parses `![alt](https://…)`. A syntactically complete image whose target is
 * unsafe is consumed as literal text, so the fallback link parser cannot turn
 * `![x](javascript:…)` or `![x](https://…/a.svg)` into a visible link.
 */
function parseImageAt(
  text: string,
  start: number,
  mentionIndex: MentionIndex,
  allowLinks: boolean,
  depth: number,
): ImageParse | null {
  if (!allowLinks || !text.startsWith('![', start)) return null;
  const closeBracket = text.indexOf('](', start + 2);
  if (closeBracket < 0) return null;
  const closeParen = text.indexOf(')', closeBracket + 2);
  if (closeParen < 0) return null;
  const rawAlt = text.slice(start + 2, closeBracket);
  const rawHref = text.slice(closeBracket + 2, closeParen).trim();
  if (rawAlt.includes('\n') || rawHref.length === 0 || rawHref.includes('\n')) return null;
  const src = safeImageUrl(rawHref);
  if (src === null) return { status: 'rejected', end: closeParen + 1 };
  const alt = flattenInlineText(parseInlineRange(rawAlt, mentionIndex, false, depth + 1)).trim();
  return { status: 'ok', src, alt, end: closeParen + 1 };
}

function trimAutolinkPunctuation(raw: string): string {
  let value = raw;
  for (;;) {
    const last = value.charAt(value.length - 1);
    if (last.length === 0) return value;
    if (TRAILING_AUTOLINK_PUNCTUATION.includes(last)) {
      value = value.slice(0, -1);
      continue;
    }
    if (last === ')' && countChar(value, '(') < countChar(value, ')')) {
      value = value.slice(0, -1);
      continue;
    }
    if (last === ']' && countChar(value, '[') < countChar(value, ']')) {
      value = value.slice(0, -1);
      continue;
    }
    return value;
  }
}

/**
 * `<https://…>` and bare `https://…` autolinks. Bare URLs are only recognised
 * at a safe word boundary (whitespace or ordinary punctuation) and never after
 * `(`, `[` or `<`, so malformed Markdown such as `[x](https://example.com`
 * stays literal instead of being silently repaired.
 */
function parseAutolinkAt(
  text: string,
  start: number,
  allowLinks: boolean,
): { href: string; label: string; end: number } | null {
  if (!allowLinks) return null;

  if (text.charAt(start) === '<') {
    const close = text.indexOf('>', start + 1);
    if (close < 0) return null;
    const raw = text.slice(start + 1, close);
    if (raw.includes('\n') || raw.length > MAX_AUTOLINK_LENGTH) return null;
    const href = safeHttpUrl(raw);
    if (href === null) return null;
    return { href, label: raw, end: close + 1 };
  }

  if (!text.startsWith('http://', start) && !text.startsWith('https://', start)) return null;
  if (start > 0 && !BARE_URL_BOUNDARY.test(text.charAt(start - 1))) return null;

  let end = start;
  while (end < text.length && end - start <= MAX_AUTOLINK_LENGTH) {
    const char = text.charAt(end);
    if (/\s/.test(char) || char === '<' || char === '>' || char === '"' || char === "'") break;
    if (char === '`') break;
    end += 1;
  }
  const raw = trimAutolinkPunctuation(text.slice(start, end));
  if (raw.length <= 'https://'.length) return null;
  const href = safeHttpUrl(raw);
  if (href === null) return null;
  return { href, label: raw, end: start + raw.length };
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

    if (char === '!' && text.charAt(cursor + 1) === '[' && allowLinks) {
      const image = parseImageAt(text, cursor, index, allowLinks, depth);
      if (image !== null) {
        if (image.status === 'ok') {
          flush();
          nodes.push({ type: 'image', src: image.src, alt: image.alt });
        } else {
          // Unsafe image target: keep the whole construct literal.
          buffer += text.slice(cursor, image.end);
        }
        cursor = image.end;
        continue;
      }
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

    if (allowLinks && (char === '<' || char === 'h')) {
      const autolink = parseAutolinkAt(text, cursor, allowLinks);
      if (autolink !== null) {
        flush();
        nodes.push({
          type: 'link',
          href: autolink.href,
          children: [{ type: 'text', text: autolink.label }],
        });
        cursor = autolink.end;
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

function parseHeading(line: string): { level: RichHeadingLevel; text: string } | null {
  const match = HEADING.exec(line);
  if (!match) return null;
  const hashes = match[1] ?? '';
  const level = hashes.length;
  if (level < 1 || level > 6) return null;
  const raw = (match[2] ?? '').replace(HEADING_CLOSING, '').trim();
  return { level: level as RichHeadingLevel, text: raw };
}

function isThematicBreak(line: string): boolean {
  return THEMATIC_BREAK.test(line);
}

/**
 * Splits a GFM table row into cells. Escaped pipes and pipes inside inline
 * code spans are data, not separators; a leading/trailing pipe is optional.
 */
function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !isEscaped(value, value.length - 1)) {
    value = value.slice(0, -1);
  }
  const cells: string[] = [];
  let cell = '';
  let cursor = 0;
  while (cursor < value.length) {
    const char = value.charAt(cursor);
    if (char === '\\' && cursor + 1 < value.length) {
      cell += char + value.charAt(cursor + 1);
      cursor += 2;
      continue;
    }
    if (char === '`') {
      const run = countRun(value, cursor, '`');
      const close = findClosingBackticks(value, cursor + run, run);
      if (close >= 0) {
        cell += value.slice(cursor, close + run);
        cursor = close + run;
        continue;
      }
      cell += '`'.repeat(run);
      cursor += run;
      continue;
    }
    if (char === '|') {
      cells.push(cell);
      cell = '';
      cursor += 1;
      continue;
    }
    cell += char;
    cursor += 1;
  }
  cells.push(cell);
  return cells.map((entry) => entry.trim());
}

function parseTableDelimiter(line: string): (RichTableAlign | null)[] | null {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const align: (RichTableAlign | null)[] = [];
  for (const cell of cells) {
    if (!TABLE_DELIMITER_CELL.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
}

function parseTableBlock(
  lines: readonly string[],
  start: number,
  mentionIndex: MentionIndex,
): { table: RichTable; next: number } | null {
  const headerLine = lines[start] ?? '';
  if (!headerLine.includes('|')) return null;
  // A list item or quote line with a pipe is not a table header.
  if (LIST_ITEM.test(headerLine) || QUOTE_LINE.test(headerLine)) return null;
  const align = parseTableDelimiter(lines[start + 1] ?? '');
  if (align === null) return null;
  const headerCells = splitTableRow(headerLine);
  if (headerCells.length !== align.length) return null;

  const header = headerCells.map((cell) => parseInlineRange(cell, mentionIndex, true, 0));
  const rows: RichInlineNode[][][] = [];
  let cursor = start + 2;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (isBlank(line) || !line.includes('|')) break;
    if (startsBlockAt(lines, cursor)) break;
    const cells = splitTableRow(line);
    const row: RichInlineNode[][] = [];
    for (let column = 0; column < header.length; column += 1) {
      row.push(parseInlineRange(cells[column] ?? '', mentionIndex, true, 0));
    }
    rows.push(row);
    cursor += 1;
  }

  return { table: { type: 'table', align, header, rows }, next: cursor };
}

/**
 * `startsBlockAt` is used to interrupt paragraphs and table bodies. A table
 * only starts when the next line is a valid delimiter row, so a prose line
 * with a pipe does not silently become a table.
 */
function startsBlockAt(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (parseFence(line) !== null) return true;
  if (HEADING.test(line)) return true;
  if (isThematicBreak(line)) return true;
  if (
    line.includes('|') &&
    !LIST_ITEM.test(line) &&
    !QUOTE_LINE.test(line) &&
    parseTableDelimiter(lines[index + 1] ?? '') !== null
  ) {
    return true;
  }
  if (QUOTE_LINE.test(line)) return true;
  return LIST_ITEM.test(line);
}

function dedent(line: string, width: number): string {
  const lead = leadingSpaces(line);
  return line.slice(Math.min(lead, width));
}

/**
 * Same list level means the same marker kind and at most one extra space of
 * drift. Two or more spaces relative to the item are nested content (this is
 * what makes both 2-space and 4-space nested lists work).
 */
function isSiblingMarker(match: RegExpExecArray, baseIndent: number, ordered: boolean): boolean {
  const indent = (match[1] ?? '').length;
  return (match[3] !== undefined) === ordered && indent <= baseIndent + 1;
}

function parseList(
  lines: readonly string[],
  start: number,
  mentionIndex: MentionIndex,
  depth: number,
): { list: RichList; next: number } {
  const first = LIST_ITEM.exec(lines[start] ?? '');
  if (first === null) throw new Error('parseList called without a list marker');
  const ordered = first[3] !== undefined;
  const baseIndent = (first[1] ?? '').length;
  const startNumber = ordered ? Number(first[3] ?? 1) : 1;
  const items: RichListItem[] = [];
  let cursor = start;
  let match: RegExpExecArray | null = first;

  while (match !== null) {
    const markerIndent = (match[1] ?? '').length;
    const markerWidth = (match[2] ?? '').length;
    const spaces = (match[4] ?? ' ').length;
    const contentIndent = markerIndent + markerWidth + spaces;
    const rawFirst = match[5] ?? '';
    const taskMatch = TASK_PREFIX.exec(rawFirst);
    const task: RichTaskState =
      taskMatch === null
        ? null
        : (taskMatch[1] ?? '').toLocaleLowerCase('en') === 'x'
          ? 'checked'
          : 'unchecked';
    const contentLines: string[] = [taskMatch === null ? rawFirst : (taskMatch[2] ?? '')];
    cursor += 1;

    while (cursor < lines.length) {
      const next = lines[cursor] ?? '';
      if (isBlank(next)) {
        let scan = cursor + 1;
        while (scan < lines.length && isBlank(lines[scan] ?? '')) scan += 1;
        if (scan >= lines.length) {
          cursor = scan;
          break;
        }
        const following = lines[scan] ?? '';
        const followingMarker = LIST_ITEM.exec(following);
        if (followingMarker !== null && isSiblingMarker(followingMarker, baseIndent, ordered)) {
          // A blank line between items makes a loose list, not two lists.
          cursor = scan;
          break;
        }
        if (leadingSpaces(following) > baseIndent) {
          contentLines.push('');
          cursor = scan;
          continue;
        }
        break;
      }

      const sibling = LIST_ITEM.exec(next);
      if (sibling !== null && isSiblingMarker(sibling, baseIndent, ordered)) break;
      if (sibling === null && leadingSpaces(next) <= baseIndent) break;

      contentLines.push(dedent(next, contentIndent));
      cursor += 1;
    }

    const parsed = parseBlocks(contentLines, mentionIndex, depth + 1);
    const firstBlock = parsed[0];
    const children = firstBlock?.type === 'paragraph' ? firstBlock.children : [];
    const blocks = firstBlock?.type === 'paragraph' ? parsed.slice(1) : parsed;
    items.push({ task, children, blocks });

    if (cursor >= lines.length) break;
    const candidate = LIST_ITEM.exec(lines[cursor] ?? '');
    if (candidate === null || !isSiblingMarker(candidate, baseIndent, ordered)) break;
    match = candidate;
  }

  return {
    list: {
      type: 'list',
      ordered,
      start: Number.isFinite(startNumber) && startNumber > 0 ? startNumber : 1,
      items,
    },
    next: cursor,
  };
}

/**
 * Block parser. Every branch produces a fixed AST node; HTML is never parsed.
 */
export function parseRichText(text: string, options: RichTextOptions = {}): RichBlockNode[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const mentionIndex = buildMentionIndex(options.mentions);
  return parseBlocks(lines, mentionIndex, 0);
}

function parseBlocks(
  lines: readonly string[],
  mentionIndex: MentionIndex,
  depth: number,
): RichBlockNode[] {
  if (depth > MAX_BLOCK_DEPTH) {
    return lines.length === 0
      ? []
      : [
          {
            type: 'paragraph',
            children: parseInlineRange(lines.join('\n'), mentionIndex, true, 0),
          },
        ];
  }

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

    const heading = parseHeading(line);
    if (heading !== null) {
      blocks.push({
        type: 'heading',
        level: heading.level,
        children: parseInlineRange(heading.text, mentionIndex, true, 0),
      });
      cursor += 1;
      continue;
    }

    if (isThematicBreak(line)) {
      blocks.push({ type: 'thematicBreak' });
      cursor += 1;
      continue;
    }

    const table = parseTableBlock(lines, cursor, mentionIndex);
    if (table !== null) {
      blocks.push(table.table);
      cursor = table.next;
      continue;
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
        children: parseBlocks(quoteLines, mentionIndex, depth + 1),
      });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const parsed = parseList(lines, cursor, mentionIndex, depth);
      blocks.push(parsed.list);
      cursor = parsed.next;
      continue;
    }

    const paragraphLines: string[] = [];
    const paragraphStart = cursor;
    while (cursor < lines.length) {
      const current = lines[cursor] ?? '';
      if (isBlank(current)) break;
      // The first line is always consumed, including a malformed fence; only
      // subsequent block starts terminate the paragraph.
      if (cursor > paragraphStart && startsBlockAt(lines, cursor)) break;
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
