# Rich Text, Code Blocks and @Mentions — D1-FE2 add-on

|                      |                                                                            |
| -------------------- | -------------------------------------------------------------------------- |
| **Task**             | Safe Markdown + fenced code blocks + `@mentions` for managed chat messages |
| **Scope**            | `frontend/**` only                                                         |
| **Status**           | **DONE**                                                                   |
| **Dependencies**     | none added (parser, highlighter and mention matcher are hand-written)      |
| **Security posture** | text nodes only, no HTML sink, http(s)-only links, E2EE remains plain text |

## 1. What was added

### 1.1 Safe Markdown parser

`src/domain/richText.ts` is a small block + inline parser that returns an AST. It
does not emit HTML and it is not a general-purpose CommonMark implementation.

Blocks:

- paragraphs with preserved line breaks;
- blockquotes (`> …`);
- unordered lists (`-`, `*`, `+`) and ordered lists (`1.`, `1)`), including
  continuation lines and an honest `start` number;
- fenced code blocks (` ``` `, three or more backticks, optional info
  string, closing fence must be at least as long).

Inline:

- `**bold**`, `__bold__`, `*italic*`, `_italic_`, `~~strike~~`, `` `inline code` ``;
- links `[label](https://…)` — only `http:`/`https:`; the parser rejects
  `javascript:`, `data:`, `ftp:` and malformed targets, and leaves them as text;
- `@Display Name` / `@all` mentions (see §1.3);
- backslash escapes for the punctuation used by the syntax.

Safety properties (covered by tests):

- raw HTML such as `<script>`, `<img onerror=…>`, `<b>` stays **visible text**;
- unmatched delimiters, unclosed fences and invalid link targets stay text;
- mentions are never parsed inside code spans or fenced code;
- the parser never loops on unterminated input; deep nesting degrades to text;
- links render with `target="_blank" rel="noopener noreferrer"`.

`RichText` (`src/components/RichText.tsx`) maps the AST to a fixed element set:
`p`, `blockquote`, `ul/ol/li`, `strong`, `em`, `del`, `code`, `a`, mention
`span`s and the `CodeBlock` figure. There is no HTML injection API in the file
(verified by `npm run security:check`).

### 1.2 Fenced code blocks

`src/components/CodeBlock.tsx`:

- language label in the header (`TypeScript`, `JavaScript`, `Java`, `Python`,
  `JSON`, `SQL`, `Bash`, `XML`, `CSS`; unknown languages show their sanitized
  raw name; no language shows «Код»);
- copy button with `navigator.clipboard` and a legacy `execCommand` fallback,
  `aria-live` success/error announcement and stable `aria-label`;
- focusable `<pre>` (`tabIndex={0}`) with horizontal scroll, monospace text and
  `tab-size: 2`; the block never widens the page at 390 px;
- token spans only for highlighted languages; unknown languages render one plain
  text run.

`src/domain/highlight.ts` implements a dependency-free lexer:

| Language                | Highlights                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------- |
| TypeScript / JavaScript | keywords, booleans, strings/templates, comments, numbers, types, calls, properties      |
| Java                    | keywords, annotations, strings/char/text blocks, comments, numbers, types               |
| Python                  | keywords, decorators, triple/single/double strings, comments, numbers, types            |
| JSON                    | keys (property), strings, numbers, booleans/null, comments, punctuation                 |
| SQL                     | case-insensitive keywords, strings/identifiers, line/block comments, numbers, functions |
| Bash                    | keywords/builtins, variables, strings, comments (word-boundary aware), numbers          |
| XML/HTML/SVG            | tags, attributes, values, comments, CDATA, doctype                                      |
| CSS                     | at-rules, properties, hex/number+unit values, strings, comments                         |

Every tokenizer guarantees `tokens.map(t => t.text).join('') === source`, which is
what makes the copy button exact. Unknown languages return the source as one
plain token.

### 1.3 Mentions

Domain (`src/domain/mentions.ts`):

- candidate matching from the active workspace member directory plus `@all`
  (always first when the query matches);
- longest-name-first matching, case-insensitive lookup, canonical display-name
  chips;
- word-boundary rules:
  - a mention cannot start after a letter/digit/underscore or another `@`, so
    `dmitry@example.test`, `user.name@example.test` and `user+tag@example.test`
    never become mentions;
  - a mention cannot end inside a longer word (`@АннаПетрова` is not `@Анна`);
- `@all` is recognized before member names and rendered with a distinct
  `mention--all` style;
- inserted text is the literal display name (`@Анна Петрова `), so edit,
  reactions, replies and calls keep working on the same plain-text body.

Composer (`src/hooks/useMentionAutocomplete.ts` + `MentionPopover.tsx`):

- opens on `@` at a word boundary, loads the workspace directory lazily once per
  picker open (the store no-ops when the full first page is cached and refreshes
  it if the members dialog left a filtered page);
- `↑`/`↓` move the active option with wrap-around, `Enter`/`Tab` insert,
  `Escape` closes only the picker (and stops propagation, so a thread panel stays
  open), pointer selection keeps textarea focus;
- after a complete `@Display Name` the picker does not reopen over the rest of
  the typed message;
- ARIA combobox/listbox wiring: `role="combobox"`, `aria-autocomplete="list"`,
  `aria-expanded`, `aria-controls`, `aria-activedescendant`, options with
  `aria-selected` and accessible names;
- mentions are disabled in E2EE composers (no picker, no combobox role).

Preview rendering: `MentionText` renders plain text plus mention chips (no block
Markdown) for the composer reply bar, message quote bars and the thread root
preview; `ThreadLink` uses the same chips for the server excerpt. If the
directory is not loaded, the same text is shown without chips.

### 1.4 Integration

| File                 | Change                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `MessageRow.tsx`     | managed text → `RichText`; E2EE text → plain `<p>`; quotes/thread links → `MentionText`; outgoing rows get `richText` + mention names |
| `MessageList.tsx`    | passes mention names, renders outgoing managed rows rich, E2EE plain                                                                  |
| `Composer.tsx`       | mention autocomplete, ARIA, picker, reply-bar chips                                                                                   |
| `ThreadComposer.tsx` | mention autocomplete in threads                                                                                                       |
| `ThreadPanel.tsx`    | root preview chips, rich replies, mention directory wiring, E2EE text defense                                                         |
| `ChatScreen.tsx`     | memoized mention names, lazy directory loader, composer props                                                                         |
| `ThreadLink.tsx`     | mention chips in `last_reply_excerpt`                                                                                                 |
| `styles/app.css`     | rich text, lists/quotes/links, code block, tokens, mention chips/picker, 390 px rules                                                 |

Flat design, spacing, light/dark tokens and reduced-motion rules are reused; no
bubble layout was reintroduced. The D1 selectors `.msg-text`, `.msg-row`,
`.thread-panel*` and the composer label are unchanged.

## 2. E2EE

`MessageRow` selects `e2eeChat` before any rich rendering:

- decrypted E2EE text is rendered as one plain `<p className="msg-text msg-text--plain">`;
- no Markdown, links, code blocks or mention chips are produced;
- quotes and the composer reply bar use the decrypted plain string;
- the thread panel passes `e2eeChat={!threadsAvailable}` to replies and renders
  the root preview as plain text when threads are unavailable;
- outgoing E2EE rows are passed `richText={false}`.

Tests assert that `**жирный**`, `` `код` ``, `@Анна Петрова` and
`[сайт](https://example.com)` stay literal inside an E2EE row and that typing `@`
in the E2EE composer opens no picker and sets no combobox role.

## 3. Tests

New suites:

| Suite                                  | Covers                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/richText.test.ts`          | all block/inline cases, escapes, malformed Markdown, raw HTML, URL allowlist, mention boundaries/longest match, code isolation                |
| `src/domain/highlight.test.ts`         | round-trip for all 9 languages, token kinds, unknown languages, hostile input, labels                                                         |
| `src/components/RichText.test.tsx`     | rendering, XSS, links, code label/tokens/scroll/focus, copy success/failure, axe                                                              |
| `src/components/Mentions.test.tsx`     | autocomplete load/filter/insert, `@all`, arrows/Enter/Escape, email false positive, ARIA, axe, quote chips, thread composer chips, E2EE plain |
| `src/components/RichTextChat.test.tsx` | managed feed Markdown/code/chips, raw HTML, thread panel root/reply rendering                                                                 |

Targeted runs are green. Final `npm run check`:

- **89 test files / 962 tests passed** (915 before this slice, 47 new);
- `lint` 0 errors (3 pre-existing warnings outside this slice);
- `format:check`, `contract:check`, `stickers:check`, `security:check`
  (302 files, no XSS sinks), `session-writers:check` and `build` pass;
- `security:check` confirms there is no HTML sink in `src/`.

## 4. Known limitations / intentional scope

- Headings, tables, images, nested lists and Markdown inside blockquotes are not
  supported; they stay plain text. This is deliberate for a chat slice and keeps
  the parser small and auditable.
- Mentions are stored as display-name text (no user IDs, no server mention
  markup). The server contract is unchanged.
- Autocomplete reads the first workspace-member page (50 entries); larger
  directories are not paginated inside the picker.
- Syntax highlighting is lexical (comments/strings/keywords/numbers/types/
  functions/properties), not semantic. JS regex literals and template
  interpolation are intentionally left plain.
- Code copy falls back to `execCommand` only when the Clipboard API is missing
  or rejected.

## 5. Verification commands

```bash
cd frontend
npm run lint
npm run format:check
npm run security:check
npm test
npm run build
npm run check
npm run test:e2e:d1   # MSW dashboard suite (selectors unchanged)
```

## 6. Result

**DONE.** Safe Markdown, fenced code blocks with lightweight highlighting/copy,
and workspace-member `@mentions` (including `@all`) are integrated into the
managed feed, composer, replies, quotes and thread panel. E2EE messages remain
plain text. The D1 flat-feed selectors and layout are unchanged; the MSW
dashboard e2e suite is green.
