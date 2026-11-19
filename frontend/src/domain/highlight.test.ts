import { describe, expect, it } from 'vitest';
import { highlightCode, languageLabel, normalizeLanguage } from './highlight';

const SAMPLES: Record<string, string> = {
  ts: 'export const greet = (name: string): string => {\n  // hello\n  return `Hi ${name}`;\n};\n',
  js: 'function sum(a, b) {\n  /* add */\n  return a + b; // done\n}\nconst n = 42;\n',
  java: 'public class Demo {\n  // field\n  private final String name = "x";\n  public int add(int a, int b) { return a + b; }\n}\n',
  python: '# comment\ndef greet(name):\n    text = f"Hello {name}"\n    return text\n',
  json: '{\n  "name": "sova",\n  "count": 3,\n  "ok": true,\n  "none": null\n}\n',
  sql: '-- list\nSELECT id, name FROM users WHERE id = 1 AND active = true ORDER BY id;\n',
  bash: '#!/bin/bash\n# deploy\nNAME="$1"\necho "hello $NAME"\nif [ -n "$NAME" ]; then\n  exit 0\nfi\n',
  xml: '<!-- comment -->\n<user id="1" active="true"><name>Анна</name></user>\n',
  css: '/* theme */\n.card {\n  color: #1f6b57;\n  margin: 8px 12px;\n}\n@media (max-width: 390px) {\n  .card { padding: 4px; }\n}\n',
};

describe('code highlighter', () => {
  it.each(Object.entries(SAMPLES))('round-trips every character for %s', (lang, code) => {
    const tokens = highlightCode(code, lang);
    expect(tokens.map((token) => token.text).join('')).toBe(code);
  });

  it('produces token kinds for known languages', () => {
    const ts = highlightCode(SAMPLES.ts ?? '', 'ts');
    expect(ts.some((token) => token.kind === 'keyword')).toBe(true);
    expect(ts.some((token) => token.kind === 'string')).toBe(true);
    expect(ts.some((token) => token.kind === 'comment')).toBe(true);

    const json = highlightCode(SAMPLES.json ?? '', 'json');
    expect(json.some((token) => token.kind === 'property')).toBe(true);
    expect(json.some((token) => token.kind === 'boolean')).toBe(true);

    const xml = highlightCode(SAMPLES.xml ?? '', 'xml');
    expect(xml.some((token) => token.kind === 'tag')).toBe(true);
    expect(xml.some((token) => token.kind === 'attr')).toBe(true);
    expect(xml.some((token) => token.kind === 'comment')).toBe(true);

    const css = highlightCode(SAMPLES.css ?? '', 'css');
    expect(css.some((token) => token.kind === 'property')).toBe(true);
    expect(css.some((token) => token.kind === 'keyword')).toBe(true);
  });

  it('keeps unknown languages plain', () => {
    const code = 'brainfuck: +++++[>++++<-]>. // not highlighted';
    expect(highlightCode(code, 'brainfuck')).toEqual([{ text: code, kind: 'plain' }]);
    expect(highlightCode(code, null)).toEqual([{ text: code, kind: 'plain' }]);
  });

  it('never throws on hostile or broken input', () => {
    for (const code of [
      '<script>alert(1)</script>',
      '```',
      '"unterminated',
      '/* unterminated',
      '🙂\u0000\u0007',
      '<div attr="unterminated>',
    ]) {
      expect(() => highlightCode(code, 'ts')).not.toThrow();
      expect(() => highlightCode(code, 'xml')).not.toThrow();
      expect(
        highlightCode(code, 'ts')
          .map((token) => token.text)
          .join(''),
      ).toBe(code);
    }
  });

  it('normalizes aliases and labels unknown languages honestly', () => {
    expect(normalizeLanguage('TypeScript')).toBe('typescript');
    expect(languageLabel('ts')).toBe('TypeScript');
    expect(languageLabel('postgresql')).toBe('SQL');
    expect(languageLabel('brainfuck')).toBe('brainfuck');
    expect(languageLabel(null)).toBeNull();
  });
});
