/**
 * Strict shape readers for wire objects.
 *
 * The envelope parser must build AD from *validated fields*, never from
 * attacker-controlled JSON bytes (§3.5.3), so every field goes through one of
 * these helpers and unknown keys are rejected (§4.7 item 5).
 */
import type { E2eeErrorCode } from '../errors';
import { invalid } from '../errors';
import { decodeBase64Url } from '../encoding/base64url';
import { isUuid } from '../encoding/bytes';

export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('INVALID_ENVELOPE_FORMAT', `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertExactKeys(
  record: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw invalid('INVALID_ENVELOPE_FORMAT', `${path}.${key} is not allowed`);
    }
  }
  for (const key of required) {
    if (record[key] === undefined) {
      throw invalid('INVALID_ENVELOPE_FORMAT', `${path}.${key} is required`);
    }
  }
}

export function readUuid(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (!isUuid(value)) {
    throw invalid('INVALID_ENVELOPE_FORMAT', `${path}.${key} must be a canonical UUID`);
  }
  return value;
}

export function readInt(
  record: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid('INVALID_ENVELOPE_FORMAT', `${path}.${key} must be an integer in ${min}..${max}`);
  }
  return value;
}

export function readString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  minLength: number,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    throw invalid(
      'INVALID_ENVELOPE_FORMAT',
      `${path}.${key} must be a string of ${minLength}..${maxLength} characters`,
    );
  }
  return value;
}

export function readBase64Url(
  record: Record<string, unknown>,
  key: string,
  path: string,
  expectedBytes: number,
  code: E2eeErrorCode = 'INVALID_ENVELOPE_FORMAT',
): Uint8Array {
  const value = record[key];
  if (typeof value !== 'string') {
    throw invalid(code, `${path}.${key} must be a base64url string`);
  }
  try {
    return decodeBase64Url(value, expectedBytes);
  } catch {
    throw invalid(
      code,
      `${path}.${key} must be canonical base64url of exactly ${expectedBytes} bytes`,
    );
  }
}

export function readOptionalBase64Url(
  record: Record<string, unknown>,
  key: string,
  path: string,
  expectedBytes: number,
  code: E2eeErrorCode = 'INVALID_ENVELOPE_FORMAT',
): Uint8Array | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  return readBase64Url(record, key, path, expectedBytes, code);
}
