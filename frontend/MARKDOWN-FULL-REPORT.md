# Full Markdown for Messages — headings, tables, images, nested lists and more

|                      |                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| **Task**             | Extend the safe Markdown subset in managed chat messages                                           |
| **Scope**            | `frontend/**` only                                                                                 |
| **Status**           | **DONE** (feature); one repo-wide build item is blocked by another slice's plugin schema sync (§6) |
| **Dependencies**     | none added — parser/renderer are hand-written; React only                                          |
| **Security posture** | AST → React text nodes, no HTML sink, http(s) only for links/images, SVG/data images rejected      |
| **Brand / E2EE**     | branding unchanged («Сова»); E2EE stays plain text (render path untouched)                         |

## 1. What was added

### 1.1 Parser (`src/domain/richText.ts`)

The parser still returns an AST (never HTML). New nodes:

| Node             | Shape                                                                |
| ---------------- | -------------------------------------------------------------------- |
| `heading`        | `level: 1..6`, inline children                                       |
| `thematicBreak`  | leaf                                                                 |
| `table`          | `align[]`, `header[]`, `rows[][]`, cells are inline node arrays      |
| `quote`          | `children: RichBlockNode[]` (was a flat inline array)                |
| `list` items     | `{ task, children, blocks }`; `blocks` holds nested lists/paragraphs |
| `image` (inline) | `src`, plain-text `alt`                                              |

New block syntax:

- ATX headings `#` … `######`; a space (or end of line) is required, `#хештег` and 7 hashes stay
  text; trailing closing hashes are stripped.
- Thematic breaks `---`, `***`, `___` and spaced variants (`- - -`); checked before lists so
  `* * *` is not mistaken for a bullet item.
- GFM tables: optional outer pipes, `:---`/`---:`/`:---:` alignment, escaped `\|` and pipes
  inside inline-code spans are data. Rows are padded/truncated to the header width; a malformed
  separator keeps the whole thing as a paragraph.
- Blockquotes collect consecutive `>` lines by stripping one marker, then recurse into the block
  parser. This gives multiple paragraphs (`>` separator), nested quotes (`> >`), headings,
  lists, tables and code inside quotes.
- Nested lists: items are parsed as blocks, so unordered/ordered lists nest at 2-space or
  4-space indentation (and mix freely). Loose lists (a blank line between items) stay one list;
  an indented paragraph after a blank line becomes a second paragraph inside the item.
- Task lists: `- [ ]` / `- [x]` / `- [X]` (also in ordered lists) become a read-only
  `checked`/`unchecked` state; `[y]` stays literal text.
- Fenced code blocks are unchanged (still raw, no Markdown/mentions inside).

New inline syntax:

- Images `![alt](https://…)`: only absolute `http:`/`https:`; `data:`, `javascript:`, `ftp:`,
  relative URLs and `.svg`/`.svgz` targets are **rejected and kept literal** (including
  percent-encoded `.svg`). Alt text is plain text (inline markdown is flattened, mentions become
  `@name`).
- Autolinks: `<https://…>` and bare `https://…`. Bare URLs require a whitespace/punctuation
  boundary, never start after `(`, `[`, `"` or `<`, and trim trailing `. , ; : ! ?` and
  unbalanced closers. Malformed Markdown such as `[x](https://example.com` therefore stays
  literal (existing test kept green).
- Existing syntax is untouched: `**bold**`, `_italic_`, `~~strike~~`, `` `code` ``,
  `[label](https://…)`, escapes and `@mentions`.

### 1.2 Security model (unchanged, extended)

- No `dangerouslySetInnerHTML`; raw HTML (`<script>`, `<b>`, `<img onerror=…>`, `<table>`)
  remains visible text. `security:check` passes over 355 files.
- Links still render with `target="_blank" rel="noopener noreferrer"`.
- Image `src` is only set after `safeHttpUrl` (absolute http/https) plus an SVG path check;
  React escapes `alt`, and `onError` replaces a broken image with its alt text.
- Unsafe image constructs are consumed whole, so the fallback link parser cannot turn
  `![x](javascript:…)` into a clickable link.
- Block depth is capped at 8 and inline depth at 6; malformed input cannot recurse or loop.
- Tables/headings/task boxes are fixed React elements; alignment is a three-value union mapped
  to CSS classes (no user-controlled `style`).

### 1.3 Renderer (`src/components/RichText.tsx`)

- Element set extended to `h1`–`h6`, `hr`, `table/thead/tbody/tr/th/td` inside a scrollable
  `div[role=region][tabindex=0]`, `img`, and `span[role=checkbox][aria-checked][aria-disabled]`
  for task state.
- Blockquotes render their child blocks recursively; list items render first-paragraph inline
  content followed by nested blocks.
- `RichImage` uses `loading="lazy"`, `decoding="async"`, `referrerPolicy="no-referrer"` and an
  alt-text fallback on load error.
- Alignment classes: `.rich-table__cell--left/center/right`.

### 1.4 CSS (`src/styles/app.css`)

- Headings with a compact chat scale (h1 1.36em → h6), `white-space: normal`, wrapping.
- `hr` using `--line-2`.
- Tables: `overflow-x: auto` wrapper with rounded border, focus ring, header surface, cell
  wrapping, per-column alignment; last row border removed.
- Nested lists get tighter indents and circle/square markers; task lists lose bullets and get a
  13 px visual checkbox with a checkmark.
- Images: `display:block`, `max-width:100%`, `height:auto`, rounded; dashed alt fallback chip.
- 390 px rules: reduced heading/table font sizes, smaller cell padding and list indents. The
  table wrapper is the only horizontal scroll container, so a wide table cannot widen the feed.
- All colors use existing light/dark CSS variables; no new palette or brand changes.

### 1.5 i18n

Added three Russian keys in `src/i18n/ru.ts`:
`rich.tableRegion` («Таблица»), `rich.taskDone` («Выполнено»), `rich.taskOpen` («Не выполнено»).

## 2. Behaviour matrix

| Input                                 | Result                                                 |
| ------------------------------------- | ------------------------------------------------------ |
| `# H1` … `###### H6`                  | heading; `#tag`, `#######` → paragraph                 |
| `---`, `***`, `- - -`                 | `<hr class="rich-hr">`                                 |
| `\| a \| b \|` + `\| :--- \| ---: \|` | table with left/right aligned columns; wrapper scrolls |
| `\| a \\\| b \|`                      | single cell containing `a \| b`                        |
| `![alt](https://e/x.png)`             | lazy `<img>` with alt                                  |
| `![x](javascript:…)`, `data:`, `.svg` | literal text, no `<img>`                               |
| `- a` + 2/4-space `- b`               | nested `<ul><li><ul>…`                                 |
| `- [x] done`                          | read-only checkbox, `aria-checked="true"`, no bullet   |
| `> a` / `> ` / `> b`                  | blockquote with two `<p>`                              |
| `> > inner`                           | nested blockquote                                      |
| `<https://e>` / `https://e`           | safe link (http/https only)                            |
| `[x](https://e` (malformed)           | literal text                                           |
| `<script>…</script>`                  | literal text, no element                               |

## 3. E2EE

No E2EE code was touched. `MessageRow` still selects `e2eeChat` before rich rendering and emits a
plain `<p className="msg-text msg-text--plain">`; `RichText` is only used for managed messages.
The existing E2EE suite (`Mentions.test.tsx`) still asserts that `**жирный**`, `` `код` ``,
`@Анна Петрова` and `[сайт](https://example.com)` stay literal and that no mention picker opens.
All E2EE tests pass unchanged.

## 4. Tests added

New assertions: **20** (domain 15, component 4, feed integration 1).

| Suite                                  | Added coverage                                                                                                                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/richText.test.ts`          | headings 1–6 + invalid hashes, thematic breaks, table alignment/escaped pipes/code pipes/padding/malformed, 2- and 4-space nesting, loose lists, multi-paragraph/nested/Markdown quotes, tasks, image allow/deny (incl. encoded SVG), angle/bare autolinks and their boundaries, raw HTML/XSS |
| `src/components/RichText.test.tsx`     | rendered headings/hr/table/alignment/image attributes/task ARIA/nested list/quote paragraphs, image alt fallback, unsafe image + raw HTML literals, axe audit with the enlarged element set                                                                                                   |
| `src/components/RichTextChat.test.tsx` | managed feed row with heading + aligned table + task list + scroll wrapper                                                                                                                                                                                                                    |

Existing tests for mentions, code blocks, XSS and E2EE were left intact and pass.

## 5. Verification

Ran from `frontend/`:

| Command                         | Result                                                                     |
| ------------------------------- | -------------------------------------------------------------------------- |
| `npm test`                      | **105 files / 1150 tests passed** (requirement was 1130+)                  |
| `npm run lint`                  | 0 errors; 2 pre-existing warnings (`ChatDetails.tsx`, E2EE test)           |
| `npm run format:check`          | pass                                                                       |
| `npm run security:check`        | pass — 355 files, no XSS sinks                                             |
| `npm run stickers:check`        | pass                                                                       |
| `npm run session-writers:check` | pass                                                                       |
| `npm run build`                 | pass before the external schema regeneration; see §6 for the current state |
| `npm run contract:check`        | pass (`102 paths / 173 schemas`, generated types in sync)                  |

## 6. Check caveat (outside this slice)

`npm run check` was executed end-to-end. The early runs were red because the shared workspace
contained an **in-flight contract/plugin sync from another slice** (regenerated
`src/api/schema.d.ts`, changed `contracts/openapi.yaml`, backend Java files). That contract sync
has since landed and `contract:check` now passes.

The regenerated schema now requires the plugin slice to update its own files:

```
src/mocks/db.ts        plugin fixtures are missing the new required `kind` field (5 errors)
src/plugins/model.ts   PERMISSION_LABELS lacks the new chat.* permission keys
```

Both files belong to the plugin/contract slice and were **not touched** by this Markdown
change. With those two files updated, `npm run check` is fully green; every other step (lint,
format, contract, stickers, security, session-writers, all 1150 tests) passes, and the Markdown
files typecheck cleanly:

```bash
npx tsc -p tsconfig.json --noEmit   # only the two plugin files above are reported
```

`frontend/scripts/check-contract.mjs` was formatted with Prettier (formatting only) because
`format:check` scans it and it was the only unformatted file in the tree.

## 7. Intentional limitations

- No raw HTML, footnotes, definition lists or multi-line table cells (chat scope; keeps the
  attack surface small).
- Table separators require at least three dashes (GFM); cells are single-line.
- Images must be absolute http(s); relative/`blob:` sources are deliberately not rendered.
- Bare autolinks are conservative: `(https://…)` without a space before `(` is not linked, which
  is what keeps malformed `[x](https://…` literal.
- Task boxes are visual/read-only; clicking them does not mutate the message.
- Headings render as real `h1`–`h6` inside the message body.

## 8. Result

**DONE.** Managed messages now support headings, thematic breaks, GFM tables with alignment and
horizontal scroll, safe lazy images with alt fallback, nested lists, multi-paragraph/nested
blockquotes, http(s) autolinks and read-only task lists — all through the existing AST-only
renderer. Raw HTML remains text, XSS tests and axe pass, E2EE remains plain, no dependency or
brand change. The full `npm run check` is green for this slice; the only remaining red step is
the external plugin-schema build break described in §6.
