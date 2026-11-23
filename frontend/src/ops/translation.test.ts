import { describe, expect, it } from 'vitest';
import {
  isLibreTranslateUrl,
  resolveTranslationProvider,
  translationDraftChanged,
  validateTranslationUrl,
} from './translation';

describe('#84/#104 translation URL validation', () => {
  it.each([
    ['https://translate.example.test', null],
    ['https://translate.example.test/v1/api', null],
    ['https://translate.example.test:8443/v1', null],
    ['http://libretranslate:5000/translate', null],
    ['http://localhost:5000', null],
    ['http://127.0.0.1:5000/translate', null],
    ['http://10.0.0.5:5000/translate', null],
    ['http://192.168.1.20:5000', null],
    ['http://translate.internal/translate', null],
    ['http://[::1]:5000/translate', null],
    ['http://[fd00::1]:5000/translate', null],
    ['', null],
  ])('accepts %s', (value, expected) => {
    expect(validateTranslationUrl(value)).toBe(expected);
  });

  it.each([
    ['http://translate.example.test', 'notHttps'],
    ['http://8.8.8.8:5000/translate', 'notHttps'],
    ['http://[2001:db8::1]:5000/translate', 'notHttps'],
    ['http://172.32.0.1:5000/translate', 'notHttps'],
    ['ftp://translate.example.test/v1', 'notHttps'],
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
    const settings = {
      enabled: true,
      url: 'https://translate.example.test/v1',
      provider: 'AUTO' as const,
    };
    expect(translationDraftChanged(settings, true, settings.url, 'AUTO')).toBe(false);
    expect(translationDraftChanged(settings, true, ` ${settings.url} `, 'AUTO')).toBe(false);
    expect(translationDraftChanged(settings, false, settings.url, 'AUTO')).toBe(true);
    expect(translationDraftChanged(settings, true, 'https://other.example.test', 'AUTO')).toBe(
      true,
    );
    expect(translationDraftChanged(settings, true, settings.url, 'LIBRETRANSLATE')).toBe(true);
    expect(translationDraftChanged(null, false, '', 'AUTO')).toBe(true);
  });
});

describe('#104 provider protocol hint', () => {
  it.each([
    ['https://translate.example.test/translate', true],
    ['https://translate.example.test/v1/translate', true],
    ['https://translate.example.test/translate/', true],
    ['https://translate.example.test', false],
    ['https://translate.example.test/translate2', false],
    ['not a url', false],
    ['', false],
  ])('detects a LibreTranslate path in %s', (url, expected) => {
    expect(isLibreTranslateUrl(url)).toBe(expected);
  });

  it('lets an explicit provider override the path heuristic', () => {
    expect(resolveTranslationProvider('AUTO', 'http://libretranslate:5000/translate')).toBe(
      'LIBRETRANSLATE',
    );
    expect(resolveTranslationProvider('AUTO', 'https://custom.example.test/v1')).toBe('CUSTOM');
    expect(resolveTranslationProvider('CUSTOM', 'https://custom.example.test/translate')).toBe(
      'CUSTOM',
    );
    expect(resolveTranslationProvider('LIBRETRANSLATE', 'https://lt.example.test')).toBe(
      'LIBRETRANSLATE',
    );
  });
});
