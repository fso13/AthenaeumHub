import { describe, expect, it } from 'vitest';
import { translationDraftChanged, validateTranslationUrl } from './translation';

describe('#84 translation URL validation', () => {
  it.each([
    ['https://translate.example.test', null],
    ['https://translate.example.test/v1/api', null],
    ['https://translate.example.test:8443/v1', null],
    ['', null],
  ])('accepts %s', (value, expected) => {
    expect(validateTranslationUrl(value)).toBe(expected);
  });

  it.each([
    ['http://translate.example.test', 'notHttps'],
    ['translate.example.test/v1', 'notAbsolute'],
    ['https://user:secret@translate.example.test', 'credentials'],
    ['https://translate.example.test/v1?api_key=secret', 'query'],
    ['https://translate.example.test/v1#secret', 'fragment'],
    ['https://translate.example.test/a/../b', 'dotSegments'],
    ['https://translate.example.test:0/v1', 'port'],
    ['https://translate.example.test/v1 extra', 'whitespace'],
    [`https://translate.example.test/${'a'.repeat(2048)}`, 'tooLong'],
  ])('rejects %s', (value, issue) => {
    expect(validateTranslationUrl(value)).toBe(issue);
  });

  it('detects changed drafts and treats trimmed equality as clean', () => {
    const settings = { enabled: true, url: 'https://translate.example.test/v1' };
    expect(translationDraftChanged(settings, true, settings.url)).toBe(false);
    expect(translationDraftChanged(settings, true, ` ${settings.url} `)).toBe(false);
    expect(translationDraftChanged(settings, false, settings.url)).toBe(true);
    expect(translationDraftChanged(settings, true, 'https://other.example.test')).toBe(true);
    expect(translationDraftChanged(null, false, '')).toBe(true);
  });
});
