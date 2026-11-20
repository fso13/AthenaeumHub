/**
 * Mentions for the managed chat surface.
 *
 * The message text is the only storage: a mention is a literal `@Display Name`
 * (or `@all`) inside the plain-text body. There is no server-side mention
 * markup and no HTML. The helpers below are deliberately text-only so the same
 * rules drive composer autocomplete and message rendering.
 *
 * Safety rules:
 * - a mention must start at a word boundary, so `user@example.com` never looks
 *   like a mention;
 * - a mention must end at a word boundary, so `@АннаПетрова` is not `@Анна`;
 * - `@all` is recognized before member names and rendered distinctly;
 * - names are matched case-insensitively but the chip shows the directory's
 *   canonical spelling.
 */

/** The minimum member shape needed for the mention directory. */
export interface MentionMemberLike {
  readonly display_name: string;
}

export interface MentionCandidate {
  /** Stable React key; member names are de-duplicated case-insensitively. */
  readonly key: string;
  readonly all: boolean;
  /** Canonical display name for members, `all` for the broadcast mention. */
  readonly name: string;
}

export interface MentionQuery {
  /** Index of the triggering `@` in the composer value. */
  readonly start: number;
  /** Text between `@` and the caret (may contain spaces in display names). */
  readonly query: string;
}

export interface MentionMatch {
  readonly name: string;
  readonly all: boolean;
  /** Total length including the leading `@`. */
  readonly length: number;
}

interface MentionIndexEntry {
  readonly name: string;
  readonly lower: string;
}

export type MentionIndex = readonly MentionIndexEntry[];

export const MENTION_ALL = 'all';
const MENTION_MAX_QUERY = 48;
const MENTION_MAX_CANDIDATES = 8;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** `@` cannot be preceded by a letter/digit/underscore or another `@`. */
function isMentionStartBoundary(text: string, at: number): boolean {
  if (at <= 0) return true;
  const previous = text.charAt(at - 1);
  if (previous === '@') return false;
  return !WORD_CHAR.test(previous);
}

function isMentionEndBoundary(text: string, end: number): boolean {
  if (end >= text.length) return true;
  return !WORD_CHAR.test(text.charAt(end));
}

/**
 * Sorted longest-first so `@Анна Петрова` wins over a hypothetical `@Анна`.
 * Names are normalized (trim + collapse whitespace) and de-duplicated by their
 * lower-cased form.
 */
export function buildMentionIndex(names: readonly string[] | undefined): MentionIndex {
  const seen = new Set<string>();
  const entries: MentionIndexEntry[] = [];
  for (const raw of names ?? []) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (name.length === 0) continue;
    const lower = name.toLocaleLowerCase('ru');
    if (seen.has(lower)) continue;
    seen.add(lower);
    entries.push({ name, lower });
  }
  entries.sort(
    (left, right) =>
      right.name.length - left.name.length || left.name.localeCompare(right.name, 'ru'),
  );
  return entries;
}

/**
 * Matches a mention at `at` (which must point at `@`). Returns `null` for an
 * email address, an unknown name, or a prefix of a longer word.
 */
export function matchMentionAt(text: string, at: number, index: MentionIndex): MentionMatch | null {
  if (at < 0 || at >= text.length || text.charAt(at) !== '@') return null;
  if (!isMentionStartBoundary(text, at)) return null;

  const allEnd = at + 1 + MENTION_ALL.length;
  if (
    text.slice(at + 1, allEnd).toLocaleLowerCase('ru') === MENTION_ALL &&
    isMentionEndBoundary(text, allEnd)
  ) {
    return { name: MENTION_ALL, all: true, length: allEnd - at };
  }

  for (const entry of index) {
    const end = at + 1 + entry.name.length;
    if (end > text.length) continue;
    if (text.slice(at + 1, end).toLocaleLowerCase('ru') !== entry.lower) continue;
    if (!isMentionEndBoundary(text, end)) continue;
    return { name: entry.name, all: false, length: end - at };
  }

  return null;
}

/**
 * Finds the active `@query` before the caret.
 *
 * `@` preceded by a word character is ignored, which is what keeps
 * `dmitry@example.test` from opening the picker. Whitespace immediately after
 * `@` also closes it: `@ ` is just an at-sign, not a search.
 */
export function findMentionQuery(value: string, caret: number): MentionQuery | null {
  const end = Math.max(0, Math.min(caret, value.length));
  if (end === 0) return null;
  const at = value.lastIndexOf('@', end - 1);
  if (at < 0) return null;
  if (!isMentionStartBoundary(value, at)) return null;

  const query = value.slice(at + 1, end);
  if (query.length > MENTION_MAX_QUERY) return null;
  if (query.includes('@') || query.includes('\n') || query.includes('\r')) return null;
  if (query.length > 0 && /^\s/.test(query)) return null;
  return { start: at, query };
}

/** Filter/sort directory entries; `@all` is always offered first when relevant. */
export function matchMentionCandidates(
  query: string,
  members: readonly MentionMemberLike[],
  limit = MENTION_MAX_CANDIDATES,
  allowAll = true,
): MentionCandidate[] {
  const normalized = query.trim().toLocaleLowerCase('ru');
  const result: MentionCandidate[] = [];
  if (allowAll && (normalized.length === 0 || MENTION_ALL.startsWith(normalized))) {
    result.push({ key: 'all', all: true, name: MENTION_ALL });
  }

  const seen = new Set<string>();
  const matches: Array<{ candidate: MentionCandidate; starts: boolean }> = [];
  for (const member of members) {
    const name = member.display_name.trim().replace(/\s+/g, ' ');
    if (name.length === 0) continue;
    const lower = name.toLocaleLowerCase('ru');
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (normalized.length > 0 && !lower.includes(normalized)) continue;
    matches.push({
      candidate: { key: `member:${lower}`, all: false, name },
      starts: normalized.length === 0 || lower.startsWith(normalized),
    });
  }

  matches.sort((left, right) => {
    if (left.starts !== right.starts) return left.starts ? -1 : 1;
    return left.candidate.name.localeCompare(right.candidate.name, 'ru');
  });

  for (const match of matches) result.push(match.candidate);
  return result.slice(0, limit);
}

/**
 * Replaces the active `@query` with `@Name ` and reports where the caret should
 * land. The trailing space is added only when the text after the caret does not
 * already start with whitespace, so selecting in the middle of a sentence does
 * not create a double space.
 */
export function insertMention(
  value: string,
  caret: number,
  candidate: MentionCandidate,
): { value: string; caret: number } | null {
  const trigger = findMentionQuery(value, caret);
  if (!trigger) return null;
  const end = Math.max(0, Math.min(caret, value.length));
  const insertion = candidate.all ? `@${MENTION_ALL}` : `@${candidate.name}`;
  const remaining = value.slice(end);
  const spacer = remaining.length === 0 || !/^\s/.test(remaining) ? ' ' : '';
  const nextValue = `${value.slice(0, trigger.start)}${insertion}${spacer}${remaining}`;
  return {
    value: nextValue,
    caret: trigger.start + insertion.length + spacer.length,
  };
}

/** The directory row needed to translate a rendered `@Name` back to a user id. */
export interface MentionIdMember {
  readonly user_id: string;
  readonly display_name: string;
}

/** Contract payload for `MessageCreate.mentions`/`mention_all` (#83). */
export interface MentionPayload {
  readonly mentions: string[];
  readonly mention_all: boolean;
}

const MENTION_MAX_IDS = 50;

/**
 * Derives the explicit mention payload from the **final** message text.
 *
 * The text stays the only storage of a mention, so the payload must follow the
 * text the user is actually sending: deleting an inserted `@Name` removes the
 * id, retyping it restores it. Only known directory members become ids — an
 * unknown `@Name` silently stays literal text instead of producing a
 * `422 MENTION_INVALID`. `@all` is only advertised when the caller's role
 * allows it; the server still owns the final 403 check.
 */
export function buildMentionPayload(
  text: string,
  members: readonly MentionIdMember[],
  allowAll = true,
): MentionPayload {
  const index = buildMentionIndex(members.map((member) => member.display_name));
  const idByLowerName = new Map<string, string>();
  for (const member of members) {
    const name = member.display_name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
    if (name.length === 0 || idByLowerName.has(name)) continue;
    idByLowerName.set(name, member.user_id);
  }

  const mentions: string[] = [];
  const seen = new Set<string>();
  let mentionAll = false;
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    const match = matchMentionAt(text, at, index);
    if (match === null) continue;
    if (match.all) {
      mentionAll = true;
      continue;
    }
    const id = idByLowerName.get(match.name.toLocaleLowerCase('ru'));
    if (id === undefined || seen.has(id) || mentions.length >= MENTION_MAX_IDS) continue;
    seen.add(id);
    mentions.push(id);
  }

  return { mentions, mention_all: mentionAll && allowAll };
}
