/**
 * Lightweight, dependency-free syntax highlighting for the fenced code blocks
 * that appear in managed messages.
 *
 * The output is a flat token list. Tokens are rendered as React text nodes
 * inside `<span className="tok tok--…">`; nothing here produces HTML. Every
 * character of the input is represented exactly once, so the copy button can
 * always use the raw source string.
 *
 * Unknown languages return one plain token (the block still renders as a
 * monospace block with a label, just without colours).
 */

export type HighlightKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'type'
  | 'function'
  | 'property'
  | 'boolean'
  | 'punctuation'
  | 'variable'
  | 'tag'
  | 'attr';

export interface HighlightToken {
  readonly text: string;
  readonly kind: HighlightKind;
}

type RuleKind = HighlightKind | 'ident';

interface Rule {
  readonly kind: RuleKind;
  readonly re: RegExp;
  readonly guard?: (code: string, index: number) => boolean;
}

interface LanguageSpec {
  readonly rules: readonly Rule[];
  readonly keywords: ReadonlySet<string>;
  readonly booleans: ReadonlySet<string>;
  readonly functions?: ReadonlySet<string>;
  readonly caseInsensitive?: boolean;
  readonly isType?: (word: string) => boolean;
}

const WS = /[ \t\r\n]+/y;
const IDENT_JS = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const IDENT = /[A-Za-z_]\w*/y;
const NUMBER = /0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y;
const PUNCTUATION = /[{}()[\];,.:?~^%*/+\-=<>!&|\\]+/y;

const LINE_COMMENT = (prefix: string): Rule => ({
  kind: 'comment',
  re: new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*`, 'y'),
});
const BLOCK_COMMENT: Rule = { kind: 'comment', re: /\/\*[\s\S]*?(?:\*\/|$)/y };
const DOUBLE_STRING: Rule = { kind: 'string', re: /"(?:\\[\s\S]|[^"\\])*"/y };
const SINGLE_STRING: Rule = { kind: 'string', re: /'(?:\\[\s\S]|[^'\\])*'/y };
const TEMPLATE_STRING: Rule = { kind: 'string', re: /`(?:\\[\s\S]|[^`\\])*`/y };

const JS_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'keyof',
  'let',
  'namespace',
  'new',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'type',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);
const JS_BOOLEANS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

const JS_SPEC: LanguageSpec = {
  rules: [
    { kind: 'plain', re: WS },
    LINE_COMMENT('//'),
    BLOCK_COMMENT,
    TEMPLATE_STRING,
    DOUBLE_STRING,
    SINGLE_STRING,
    { kind: 'number', re: NUMBER },
    { kind: 'ident', re: IDENT_JS },
    { kind: 'punctuation', re: PUNCTUATION },
  ],
  keywords: JS_KEYWORDS,
  booleans: JS_BOOLEANS,
  isType: (word) => /^[A-Z]/.test(word),
};

const JAVA_KEYWORDS = new Set([
  'abstract',
  'assert',
  'break',
  'case',
  'catch',
  'class',
  'continue',
  'default',
  'do',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'for',
  'if',
  'implements',
  'import',
  'instanceof',
  'interface',
  'native',
  'new',
  'non-sealed',
  'package',
  'permits',
  'private',
  'protected',
  'public',
  'record',
  'return',
  'sealed',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'var',
  'volatile',
  'while',
  'yield',
]);
const JAVA_BOOLEANS = new Set(['true', 'false', 'null']);

const JAVA_SPEC: LanguageSpec = {
  rules: [
    { kind: 'plain', re: WS },
    LINE_COMMENT('//'),
    BLOCK_COMMENT,
    { kind: 'string', re: /"""[\s\S]*?(?:"""|$)/y },
    DOUBLE_STRING,
    { kind: 'string', re: /'(?:\\.|[^'\\\n])'/y },
    { kind: 'attr', re: /@[A-Za-z_]\w*/y },
    { kind: 'number', re: NUMBER },
    { kind: 'ident', re: IDENT_JS },
    { kind: 'punctuation', re: PUNCTUATION },
  ],
  keywords: JAVA_KEYWORDS,
  booleans: JAVA_BOOLEANS,
  isType: (word) => /^[A-Z]/.test(word),
};

const PYTHON_KEYWORDS = new Set([
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);
const PYTHON_BOOLEANS = new Set(['True', 'False', 'None']);

const PYTHON_SPEC: LanguageSpec = {
  rules: [
    { kind: 'plain', re: WS },
    LINE_COMMENT('#'),
    { kind: 'string', re: /"""[\s\S]*?(?:"""|$)/y },
    { kind: 'string', re: /'''[\s\S]*?(?:'''|$)/y },
    DOUBLE_STRING,
    SINGLE_STRING,
    { kind: 'attr', re: /@[A-Za-z_]\w*/y },
    { kind: 'number', re: NUMBER },
    { kind: 'ident', re: IDENT },
    { kind: 'punctuation', re: PUNCTUATION },
  ],
  keywords: PYTHON_KEYWORDS,
  booleans: PYTHON_BOOLEANS,
  isType: (word) => /^[A-Z]/.test(word),
};

const JSON_SPEC: LanguageSpec = {
  rules: [
    { kind: 'plain', re: WS },
    { kind: 'comment', re: /\/\/[^\n]*/y },
    { kind: 'comment', re: /\/\*[\s\S]*?(?:\*\/|$)/y },
    {
      kind: 'property',
      re: /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/y,
    },
    DOUBLE_STRING,
    { kind: 'number', re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y },
    { kind: 'boolean', re: /\b(?:true|false|null)\b/y },
    { kind: 'punctuation', re: /[{}[\],:]+/y },
  ],
  keywords: new Set(),
  booleans: new Set(),
};

const SQL_KEYWORDS = new Set([
  'all',
  'alter',
  'and',
  'as',
  'asc',
  'between',
  'by',
  'case',
  'cast',
  'coalesce',
  'create',
  'cross',
  'default',
  'delete',
  'desc',
  'distinct',
  'drop',
  'else',
  'end',
  'exists',
  'foreign',
  'from',
  'full',
  'group',
  'having',
  'in',
  'index',
  'inner',
  'insert',
  'into',
  'is',
  'join',
  'key',
  'left',
  'like',
  'limit',
  'not',
  'null',
  'offset',
  'on',
  'or',
  'order',
  'outer',
  'primary',
  'references',
  'right',
  'select',
  'set',
  'table',
  'then',
  'union',
  'unique',
  'update',
  'values',
  'view',
  'when',
  'where',
  'with',
]);
const SQL_BOOLEANS = new Set(['true', 'false', 'null']);

const SQL_SPEC: LanguageSpec = {
  rules: [
    { kind: 'plain', re: WS },
    LINE_COMMENT('--'),
    BLOCK_COMMENT,
    SINGLE_STRING,
    { kind: 'string', re: /"(?:""|[^"])*"/y },
    { kind: 'number', re: NUMBER },
    { kind: 'ident', re: IDENT },
    { kind: 'punctuation', re: PUNCTUATION },
  ],
  keywords: SQL_KEYWORDS,
  booleans: SQL_BOOLEANS,
  caseInsensitive: true,
};

const BASH_KEYWORDS = new Set([
  'case',
  'coproc',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
]);
const BASH_FUNCTIONS = new Set([
  'alias',
  'cd',
  'declare',
  'echo',
  'eval',
  'exec',
  'exit',
  'export',
  'local',
  'printf',
  'pwd',
  'read',
  'readonly',
  'return',
  'set',
  'shift',
  'source',
  'test',
  'trap',
  'umask',
  'unset',
  'wait',
]);
const BASH_BOOLEANS = new Set(['true', 'false']);

const BASH_SPEC: LanguageSpec = {
  rules: [
    { kind: 'plain', re: WS },
    {
      kind: 'comment',
      re: /#[^\n]*/y,
      // `#` is a comment only at the start of a word/line; `foo#bar` is text.
      guard: (code, index) => index === 0 || /\s/.test(code.charAt(index - 1)),
    },
    DOUBLE_STRING,
    SINGLE_STRING,
    { kind: 'variable', re: /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9@#?$!*-])/y },
    { kind: 'number', re: NUMBER },
    { kind: 'ident', re: IDENT },
    { kind: 'punctuation', re: PUNCTUATION },
  ],
  keywords: BASH_KEYWORDS,
  booleans: BASH_BOOLEANS,
  functions: BASH_FUNCTIONS,
};

const CSS_KEYWORDS = new Set([
  '@charset',
  '@container',
  '@font-face',
  '@import',
  '@keyframes',
  '@layer',
  '@media',
  '@supports',
  '!important',
  'auto',
  'block',
  'currentcolor',
  'flex',
  'grid',
  'inherit',
  'initial',
  'inline',
  'none',
  'revert',
  'transparent',
  'unset',
]);

const CSS_SPEC: LanguageSpec = {
  rules: [
    { kind: 'plain', re: WS },
    BLOCK_COMMENT,
    DOUBLE_STRING,
    SINGLE_STRING,
    { kind: 'keyword', re: /@[A-Za-z-]+/y },
    { kind: 'number', re: /#[0-9a-fA-F]{3,8}\b/y },
    {
      kind: 'number',
      re: /-?(?:\d*\.)?\d+(?:px|rem|em|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex)?\b/y,
    },
    { kind: 'property', re: /(?:--)?[A-Za-z-]+(?=\s*:)/y },
    { kind: 'ident', re: /-?[A-Za-z_]\w*/y },
    { kind: 'punctuation', re: PUNCTUATION },
  ],
  keywords: CSS_KEYWORDS,
  booleans: new Set(),
};

const SPECS: Readonly<Record<string, LanguageSpec>> = {
  ts: JS_SPEC,
  js: JS_SPEC,
  java: JAVA_SPEC,
  python: PYTHON_SPEC,
  json: JSON_SPEC,
  sql: SQL_SPEC,
  bash: BASH_SPEC,
  css: CSS_SPEC,
};

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: 'ts',
  tsx: 'ts',
  typescript: 'ts',
  js: 'js',
  jsx: 'js',
  javascript: 'js',
  mjs: 'js',
  cjs: 'js',
  node: 'js',
  java: 'java',
  py: 'python',
  python: 'python',
  python3: 'python',
  json: 'json',
  jsonc: 'json',
  sql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  sh: 'bash',
  shell: 'bash',
  bash: 'bash',
  zsh: 'bash',
  console: 'bash',
  css: 'css',
  scss: 'css',
  less: 'css',
  xml: 'xml',
  html: 'xml',
  svg: 'xml',
  htm: 'xml',
  xhtml: 'xml',
};

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  js: 'JavaScript',
  java: 'Java',
  python: 'Python',
  json: 'JSON',
  sql: 'SQL',
  bash: 'Bash',
  xml: 'XML',
  css: 'CSS',
};

/** First info-string token, lower-cased and trimmed to a safe length. */
export function normalizeLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const token = raw.trim().toLocaleLowerCase('en');
  if (token.length === 0) return null;
  const match = /^[a-z0-9+#._-]{1,32}/.exec(token);
  return match?.[0] ?? null;
}

/** Canonical language id used to select a lexer. */
function languageId(raw: string | null | undefined): string | null {
  const normalized = normalizeLanguage(raw);
  if (normalized === null) return null;
  return LANGUAGE_ALIASES[normalized] ?? null;
}

/**
 * Human label for the code-block header. Unknown languages keep their raw
 * (sanitized, length-limited) name, so a block never claims to be something it
 * is not.
 */
export function languageLabel(raw: string | null | undefined): string | null {
  const normalized = normalizeLanguage(raw);
  if (normalized === null) return null;
  return (
    LANGUAGE_LABELS[LANGUAGE_ALIASES[normalized] ?? normalized] ?? raw?.trim().slice(0, 24) ?? null
  );
}

function nextNonSpace(code: string, from: number): string {
  for (let index = from; index < code.length; index += 1) {
    const char = code.charAt(index);
    if (!/\s/.test(char)) return char;
  }
  return '';
}

function previousNonSpace(code: string, from: number): string {
  for (let index = from - 1; index >= 0; index -= 1) {
    const char = code.charAt(index);
    if (!/\s/.test(char)) return char;
  }
  return '';
}

function pushToken(tokens: HighlightToken[], text: string, kind: HighlightKind): void {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last !== undefined && last.kind === kind) {
    tokens[tokens.length - 1] = { text: last.text + text, kind };
    return;
  }
  tokens.push({ text, kind });
}

function classify(
  word: string,
  code: string,
  start: number,
  end: number,
  spec: LanguageSpec,
): HighlightKind {
  const lookup = spec.caseInsensitive ? word.toLowerCase() : word;
  if (spec.keywords.has(lookup)) return 'keyword';
  if (spec.booleans.has(lookup)) return 'boolean';
  if (spec.functions?.has(lookup)) return 'function';
  if (spec.isType?.(word)) return 'type';
  const next = nextNonSpace(code, end);
  if (next === '(') return 'function';
  const previous = previousNonSpace(code, start);
  if (previous === '.' || next === ':') return 'property';
  return 'plain';
}

function tokenize(code: string, spec: LanguageSpec): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let cursor = 0;

  while (cursor < code.length) {
    let advanced = false;
    for (const rule of spec.rules) {
      rule.re.lastIndex = cursor;
      const match = rule.re.exec(code);
      if (match === null || match.index !== cursor || match[0].length === 0) continue;
      if (rule.guard !== undefined && !rule.guard(code, cursor)) continue;
      const text = match[0];
      const kind =
        rule.kind === 'ident'
          ? classify(text, code, cursor, cursor + text.length, spec)
          : rule.kind;
      pushToken(tokens, text, kind);
      cursor += text.length;
      advanced = true;
      break;
    }
    if (!advanced) {
      pushToken(tokens, code.charAt(cursor), 'plain');
      cursor += 1;
    }
  }

  return tokens;
}

/** XML/HTML tokenizer: tags, attributes, attribute values, comments/CDATA. */
function tokenizeXml(code: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let cursor = 0;

  while (cursor < code.length) {
    if (code.startsWith('<!--', cursor)) {
      const end = code.indexOf('-->', cursor + 4);
      const stop = end < 0 ? code.length : end + 3;
      pushToken(tokens, code.slice(cursor, stop), 'comment');
      cursor = stop;
      continue;
    }
    if (code.startsWith('<![CDATA[', cursor)) {
      const end = code.indexOf(']]>', cursor + 9);
      const stop = end < 0 ? code.length : end + 3;
      pushToken(tokens, code.slice(cursor, stop), 'string');
      cursor = stop;
      continue;
    }
    if (code.charAt(cursor) !== '<') {
      const next = code.indexOf('<', cursor);
      const stop = next < 0 ? code.length : next;
      pushToken(tokens, code.slice(cursor, stop), 'plain');
      cursor = stop;
      continue;
    }

    pushToken(tokens, '<', 'punctuation');
    cursor += 1;
    const prefix = code.charAt(cursor);
    if (prefix === '/' || prefix === '?') {
      pushToken(tokens, prefix, 'punctuation');
      cursor += 1;
    } else if (prefix === '!') {
      const end = code.indexOf('>', cursor);
      const stop = end < 0 ? code.length : end + 1;
      pushToken(tokens, code.slice(cursor, stop), 'keyword');
      cursor = stop;
      continue;
    }

    const name = /^[A-Za-z_][\w:.-]*/.exec(code.slice(cursor));
    if (name !== null) {
      pushToken(tokens, name[0], 'tag');
      cursor += name[0].length;
    }

    while (cursor < code.length) {
      const char = code.charAt(cursor);
      if (char === '>') {
        pushToken(tokens, '>', 'punctuation');
        cursor += 1;
        break;
      }
      if (char === '/' && code.charAt(cursor + 1) === '>') {
        pushToken(tokens, '/>', 'punctuation');
        cursor += 2;
        break;
      }
      if (/\s/.test(char)) {
        let end = cursor + 1;
        while (end < code.length && /\s/.test(code.charAt(end))) end += 1;
        pushToken(tokens, code.slice(cursor, end), 'plain');
        cursor = end;
        continue;
      }
      if (char === '=') {
        pushToken(tokens, '=', 'punctuation');
        cursor += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        let end = cursor + 1;
        while (end < code.length) {
          const current = code.charAt(end);
          if (current === '\\') {
            end += 2;
            continue;
          }
          end += 1;
          if (current === char) break;
        }
        pushToken(tokens, code.slice(cursor, end), 'string');
        cursor = end;
        continue;
      }
      const attribute = /^[A-Za-z_:][\w:.-]*/.exec(code.slice(cursor));
      if (attribute !== null) {
        pushToken(tokens, attribute[0], 'attr');
        cursor += attribute[0].length;
        continue;
      }
      pushToken(tokens, char, 'plain');
      cursor += 1;
    }
  }

  return tokens;
}

/**
 * Tokenizes `code` for the given language. Unknown languages and empty input
 * degrade to a single plain token / empty list; this function never throws on
 * arbitrary Unicode or malformed code.
 */
export function highlightCode(
  code: string,
  rawLanguage: string | null | undefined,
): HighlightToken[] {
  if (typeof code !== 'string' || code.length === 0) return [];
  const id = languageId(rawLanguage);
  if (id === null) return [{ text: code, kind: 'plain' }];
  if (id === 'xml') return tokenizeXml(code);
  const spec = SPECS[id];
  if (spec === undefined) return [{ text: code, kind: 'plain' }];
  return tokenize(code, spec);
}
