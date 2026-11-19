/**
 * Test-only fixture for E7-F7B (real two-device E2EE).
 *
 * Responsibilities:
 *  - provision the two fixture users through the **real** Auth BFF:
 *    `POST /auth/register` → read the TOTP from Mailpit → `POST /auth/verify-email`;
 *    an existing verified user is reused (`POST /auth/login`), never assumed;
 *  - optional destructive SQL (device reset / stale workspace cleanup / workspace
 *    delete) only when `E2EE_REAL_RESET=1` (alias `E2EE_REAL_ALLOW_DESTRUCTIVE=1`).
 *    With the gate off this module never executes `UPDATE`/`DELETE`;
 *  - read-only DB helpers for the post-run envelopes-only checks.
 *
 * Nothing here is product code. Passwords, TOTP codes and tokens are only kept in
 * memory for the duration of one call and are never logged or attached to the
 * Playwright report.
 */
import { execFileSync } from 'node:child_process';

export interface FixtureUser {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

export type FixtureUserSource = 'existing' | 'registered' | 'resumed';

export interface FixtureUserState {
  readonly user: FixtureUser;
  readonly source: FixtureUserSource;
}

const env = process.env;

export const BASE_URL = (env.E2EE_REAL_BASE_URL ?? 'http://localhost:8088').replace(/\/$/, '');
export const API = `${BASE_URL}/api/v1`;
export const MAILPIT_URL = (env.E2EE_REAL_MAILPIT_URL ?? 'http://localhost:8025').replace(
  /\/$/,
  '',
);
export const DB_CHECK = env.E2EE_REAL_DB_CHECK !== '0';
/** Explicit destructive-SQL opt-in. Default: read-only DB checks only. */
export const RESET = env.E2EE_REAL_RESET === '1' || env.E2EE_REAL_ALLOW_DESTRUCTIVE === '1';
export const DESTRUCTIVE = RESET && DB_CHECK;
export const PG_CONTAINER = env.E2EE_REAL_PG_CONTAINER ?? 'krug-postgres';
export const BACKEND_CONTAINER = env.E2EE_REAL_BACKEND_CONTAINER ?? 'krug-backend';
export const WORKSPACE_PREFIX = env.E2EE_REAL_WORKSPACE_PREFIX ?? 'E2EE F7B';

/**
 * Fixed fixture identities: a clean stack registers them through the BFF, a rerun
 * reuses them. Override the email/password/name for an isolated run or to point the
 * fixture at an existing test account.
 */
export const USER_A: FixtureUser = {
  email: env.E2EE_REAL_USER_A_EMAIL ?? 'e2ee-f7b-a@krug.local',
  password: env.E2EE_REAL_USER_A_PASSWORD ?? 'F7b-Clean-A-2026!',
  name: env.E2EE_REAL_USER_A_NAME ?? 'E2EE F7B A',
};

export const USER_B: FixtureUser = {
  email: env.E2EE_REAL_USER_B_EMAIL ?? 'e2ee-f7b-b@krug.local',
  password: env.E2EE_REAL_USER_B_PASSWORD ?? 'F7b-Clean-B-2026!',
  name: env.E2EE_REAL_USER_B_NAME ?? 'E2EE F7B B',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAIL_TIMEOUT_MS = readPositiveInt(env.E2EE_REAL_MAIL_TIMEOUT_MS, 45_000);
/** Existing-but-unverified accounts may still have a valid code from the last run. */
const EXISTING_VERIFICATION_WINDOW_MS = 20 * 60_000;
const MAIL_POLL_MS = 500;

interface AuthResponse {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSeconds: number | null;
}

interface MailpitAddress {
  readonly Address?: string;
}

interface MailpitMessageSummary {
  readonly ID?: string;
  readonly Created?: string;
  readonly To?: MailpitAddress[];
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(value: unknown, key: string): string | null {
  const record = recordOf(value);
  const found = record?.[key];
  return typeof found === 'string' && found.length > 0 ? found : null;
}

function detailsOf(value: unknown): Record<string, unknown> | null {
  return recordOf(recordOf(value)?.details);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function authPost(path: string, body: unknown): Promise<AuthResponse> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `E2EE fixture cannot reach the Auth BFF at ${API}${path}. ` +
        `Start the test stack (deploy/docker-compose.yml + deploy/docker-compose.e2ee-test.yml) ` +
        `or set E2EE_REAL_BASE_URL. Underlying error: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const retryAfter = response.headers.get('retry-after');
  const retryAfterSeconds =
    retryAfter !== null && /^\d+$/.test(retryAfter.trim())
      ? Number.parseInt(retryAfter.trim(), 10)
      : null;
  return { status: response.status, body: parsed, retryAfterSeconds };
}

function authFailure(label: string, response: AuthResponse): string {
  const code = stringField(response.body, 'code');
  const reason = stringField(detailsOf(response.body), 'reason');
  const parts = [`${label}: unexpected HTTP ${response.status}`];
  if (code) parts.push(`code=${code}`);
  if (reason) parts.push(`reason=${reason}`);
  return parts.join(' ');
}

function rateLimitedHint(response: AuthResponse): string {
  const wait = response.retryAfterSeconds;
  return wait === null
    ? 'The Auth BFF rate limit was hit; wait and re-run.'
    : `The Auth BFF rate limit was hit; retry after ~${wait}s.`;
}

async function mailpitJson(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${MAILPIT_URL}${path}`);
  } catch (error) {
    throw new Error(
      `E2EE fixture cannot reach Mailpit at ${MAILPIT_URL}. ` +
        `Start deploy/docker-compose.yml (mailpit service) or set E2EE_REAL_MAILPIT_URL. ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Mailpit ${path} returned HTTP ${response.status}; the E2EE fixture needs the ` +
        `Mailpit API at ${MAILPIT_URL} to read the registration TOTP.`,
    );
  }
  return response.json();
}

function extractCode(message: unknown): string | null {
  const text = stringField(message, 'Text') ?? '';
  const html = stringField(message, 'HTML') ?? '';
  const plain = text.length > 0 ? text : html.replace(/<[^>]+>/g, ' ');
  const labelled = /подтверждения\s*:\s*(\d{6})/i.exec(plain);
  if (labelled?.[1]) return labelled[1];
  const anyCode = /(?:^|\D)(\d{6})(?:\D|$)/.exec(plain);
  return anyCode?.[1] ?? null;
}

/**
 * Polls Mailpit for the newest verification email sent to the fixture user at or
 * after `sinceMs`. The code is returned in memory only; it is never logged.
 */
async function readMailpitCode(email: string, sinceMs: number): Promise<string> {
  const deadline = Date.now() + MAIL_TIMEOUT_MS;
  const wanted = email.toLowerCase();
  while (Date.now() < deadline) {
    const listing = await mailpitJson('/api/v1/messages?limit=100');
    const messages = recordOf(listing)?.messages;
    if (Array.isArray(messages)) {
      const candidates = (messages as MailpitMessageSummary[])
        .filter((message) => {
          const recipients = message.To ?? [];
          if (!recipients.some((item) => item.Address?.toLowerCase() === wanted)) return false;
          const created = message.Created ? Date.parse(message.Created) : Number.NaN;
          return Number.isNaN(created) || created >= sinceMs - 5_000;
        })
        .filter((message): message is MailpitMessageSummary & { ID: string } => Boolean(message.ID))
        .sort((left, right) => {
          const leftAt = left.Created ? Date.parse(left.Created) : 0;
          const rightAt = right.Created ? Date.parse(right.Created) : 0;
          return rightAt - leftAt;
        });
      for (const summary of candidates.slice(0, 3)) {
        const full = await mailpitJson(`/api/v1/message/${encodeURIComponent(summary.ID)}`);
        const code = extractCode(full);
        if (code !== null) return code;
      }
    }
    await sleep(MAIL_POLL_MS);
  }
  throw new Error(
    `E2EE fixture: Mailpit at ${MAILPIT_URL} received no verification email for the ` +
      `fixture user within ${Math.round(MAIL_TIMEOUT_MS / 1000)}s. Check that the backend ` +
      `has SPRING_MAIL_HOST=mailpit, the mailpit service is running, and the stack is ` +
      `the base compose (Mailpit) rather than a custom SMTP setup.`,
  );
}

function readVerificationId(response: AuthResponse): string {
  const verificationId = stringField(response.body, 'verification_id');
  if (verificationId === null) {
    throw new Error(
      'E2EE fixture: POST /auth/register returned 202 without verification_id; ' +
        'the Auth BFF contract changed.',
    );
  }
  return verificationId;
}

async function resendVerificationCode(verificationId: string): Promise<number> {
  let response = await authPost('/auth/resend-email-code', {
    verification_id: verificationId,
  });
  if (response.status === 429) {
    const waitSeconds = Math.min(Math.max(response.retryAfterSeconds ?? 5, 1), 60);
    await sleep(waitSeconds * 1_000);
    response = await authPost('/auth/resend-email-code', {
      verification_id: verificationId,
    });
  }
  if (response.status !== 202) {
    throw new Error(
      `${authFailure('POST /auth/resend-email-code', response)}. ` +
        'The fixture could not re-send the verification TOTP.',
    );
  }
  return Date.now();
}

async function completeVerification(
  user: FixtureUser,
  verificationId: string,
  sinceMs: number,
): Promise<void> {
  let since = sinceMs;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const code = await readMailpitCode(user.email, since);
    const response = await authPost('/auth/verify-email', {
      verification_id: verificationId,
      code,
    });
    if (response.status === 200) return;
    if (response.status === 410 && attempt === 0) {
      // The mail/code expired between the previous run and this one; send a new
      // code and read only mail created after the resend.
      since = await resendVerificationCode(verificationId);
      continue;
    }
    if (response.status === 429) {
      throw new Error(
        `${authFailure('POST /auth/verify-email', response)}. ${rateLimitedHint(response)}`,
      );
    }
    throw new Error(
      `${authFailure('POST /auth/verify-email', response)}. ` +
        'The TOTP read from Mailpit was rejected; the fixture aborts instead of ' +
        'guessing codes.',
    );
  }
  throw new Error(
    'E2EE fixture: verification did not complete after one TOTP resend; ' +
      'check Mailpit/backend mail delivery.',
  );
}

async function registerFixtureUser(user: FixtureUser): Promise<FixtureUserState> {
  const startedAt = Date.now();
  const response = await authPost('/auth/register', {
    email: user.email,
    display_name: user.name,
    password: user.password,
  });
  if (response.status === 409) {
    throw new Error(
      'E2EE fixture: the login attempt was rejected but /auth/register reports ' +
        'EMAIL_TAKEN. The fixture account already exists with a different password. ' +
        'Set E2EE_REAL_USER_A_EMAIL / E2EE_REAL_USER_B_EMAIL to new addresses, or set ' +
        'the matching E2EE_REAL_USER_*_PASSWORD to the existing account password.',
    );
  }
  if (response.status === 429) {
    throw new Error(
      `${authFailure('POST /auth/register', response)}. ${rateLimitedHint(response)}`,
    );
  }
  if (response.status !== 202) {
    const reason = stringField(detailsOf(response.body), 'reason');
    const registryHint =
      response.status >= 500 || reason === 'keycloak_unavailable'
        ? ' The identity registry (Keycloak) or the mail path is unavailable; ' +
          'start the test stack and check backend health before re-running.'
        : '';
    throw new Error(
      `${authFailure('POST /auth/register', response)}.` +
        `${registryHint} The fixture never falls back to a pre-seeded account.`,
    );
  }
  await completeVerification(user, readVerificationId(response), startedAt);
  return { user, source: 'registered' };
}

/**
 * Ensures the fixture user is verified.
 *
 * Order matters for a clean stack: a verified login means "reuse"; 403
 * EMAIL_NOT_VERIFIED means a previous run stopped mid-provisioning and the
 * still-valid TOTP/verification id is resumed; 401 means "register through the
 * real BFF". There is deliberately no SQL/user-directory shortcut.
 */
export async function ensureFixtureUser(user: FixtureUser): Promise<FixtureUserState> {
  const login = await authPost('/auth/login', {
    email: user.email,
    password: user.password,
  });
  if (login.status === 200) return { user, source: 'existing' };

  const code = stringField(login.body, 'code');
  if (login.status === 403 && code === 'EMAIL_NOT_VERIFIED') {
    const verificationId = stringField(detailsOf(login.body), 'verification_id');
    if (verificationId === null) {
      throw new Error(
        'E2EE fixture: login returned EMAIL_NOT_VERIFIED without verification_id; ' +
          'cannot resume verification. Choose new fixture emails or reset the test stack.',
      );
    }
    await completeVerification(user, verificationId, Date.now() - EXISTING_VERIFICATION_WINDOW_MS);
    return { user, source: 'resumed' };
  }
  if (login.status === 401 && code === 'INVALID_CREDENTIALS') {
    return registerFixtureUser(user);
  }
  if (login.status === 429) {
    throw new Error(`${authFailure('POST /auth/login', login)}. ${rateLimitedHint(login)}`);
  }
  if (login.status >= 500) {
    const reason = stringField(detailsOf(login.body), 'reason');
    throw new Error(
      `${authFailure('POST /auth/login', login)}. The identity registry (Keycloak) is ` +
        `unavailable${reason ? ` (${reason})` : ''}; start/repair the test stack first.`,
    );
  }
  throw new Error(
    `${authFailure('POST /auth/login', login)}. The fixture cannot decide whether the ` +
      'account exists; it never falls back to a pre-seeded account.',
  );
}

/** Provisions A then B sequentially (avoids burning the per-IP registration burst). */
export async function ensureFixtureUsers(
  users: readonly FixtureUser[],
): Promise<FixtureUserState[]> {
  const states: FixtureUserState[] = [];
  for (const user of users) {
    states.push(await ensureFixtureUser(user));
  }
  return states;
}

export function requireUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw new Error(`${label} is not a canonical UUID`);
  return value;
}

/**
 * Read-only/`docker exec` SQL helper. `E2EE_REAL_DB_CHECK=0` disables every DB and
 * backend-log assertion (for a remote stack).
 */
export function psql(sql: string): string {
  try {
    return execFileSync(
      'docker',
      [
        'exec',
        PG_CONTAINER,
        'psql',
        '-U',
        'krug_migrator',
        '-d',
        'krug',
        '-v',
        'ON_ERROR_STOP=1',
        '-tA',
        '-F',
        '\t',
        '-c',
        sql,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 },
    ).trim();
  } catch {
    throw new Error(
      `E2EE DB check needs \`docker exec ${PG_CONTAINER} psql\`; ` +
        'set E2EE_REAL_DB_CHECK=0 for a remote stack',
    );
  }
}

export function scalar(sql: string): string {
  return psql(sql).split('\n')[0]?.trim() ?? '';
}

export function countOf(sql: string): number {
  const value = Number(scalar(sql));
  if (!Number.isInteger(value) || value < 0) throw new Error('E2EE DB check returned no count');
  return value;
}

function countCommand(output: string, command: 'DELETE' | 'UPDATE'): number {
  return output
    .split('\n')
    .map((line) => new RegExp(`^${command}\\s+(\\d+)$`).exec(line.trim())?.[1])
    .reduce((total, value) => total + (value ? Number(value) : 0), 0);
}

/**
 * Destructive: revokes every ACTIVE device of the fixture user before the browser
 * logs in. Opt-in only (`E2EE_REAL_RESET=1`) and only with DB access; a disposable
 * stack is required because this bypasses `device.list.changed` events.
 */
export function resetFixtureDevices(emails: readonly string[]): number {
  if (!DESTRUCTIVE) return 0;
  let revoked = 0;
  for (const email of emails) {
    const userId = scalar(`SELECT id FROM auth.users WHERE email='${email.replace(/'/g, "''")}';`);
    if (userId === '') {
      throw new Error(
        'E2EE fixture: the BFF user has no local auth.users row after verification; ' +
          'cannot run the opt-in device reset.',
      );
    }
    const id = requireUuid(userId, 'fixture user id');
    const output = psql(
      `UPDATE auth.devices
          SET status='REVOKED', revoked_at=now(), revoked_reason='E2EE_F7B_TEST_RESET'
        WHERE user_id='${id}' AND status='ACTIVE';`,
    );
    revoked += countCommand(output, 'UPDATE');
  }
  return revoked;
}

/**
 * Destructive: removes stale `E2EE F7B …` workspaces (older than one hour) so a
 * disposable stack does not accumulate fixtures forever. Messages/envelopes have
 * no FK to `chat.chats`, so they are deleted explicitly before the workspace.
 */
export function cleanupStaleWorkspaces(olderThan = '1 hour'): number {
  if (!DESTRUCTIVE) return 0;
  const prefix = `${WORKSPACE_PREFIX.replace(/'/g, "''")} %`;
  const where = `name LIKE '${prefix}' AND created_at < now() - interval '${olderThan}'`;
  const envelopes = psql(
    `DELETE FROM message.message_envelopes
      WHERE workspace_id IN (SELECT id FROM workspace.workspaces WHERE ${where});`,
  );
  const messages = psql(
    `DELETE FROM message.messages
      WHERE workspace_id IN (SELECT id FROM workspace.workspaces WHERE ${where});`,
  );
  const workspaces = psql(`DELETE FROM workspace.workspaces WHERE ${where};`);
  return (
    countCommand(envelopes, 'DELETE') +
    countCommand(messages, 'DELETE') +
    countCommand(workspaces, 'DELETE')
  );
}

/** Destructive: deletes exactly this run's workspace (and its orphaned messages). */
export function deleteWorkspace(workspaceId: string): number {
  if (!DESTRUCTIVE) return 0;
  const id = requireUuid(workspaceId, 'workspace id');
  const output = psql(
    `DELETE FROM message.message_envelopes WHERE workspace_id='${id}';
     DELETE FROM message.messages WHERE workspace_id='${id}';
     DELETE FROM workspace.workspaces WHERE id='${id}';`,
  );
  return countCommand(output, 'DELETE');
}

export function backendLogs(sinceMs: number): string {
  try {
    return execFileSync(
      'docker',
      ['logs', BACKEND_CONTAINER, '--since', new Date(sinceMs).toISOString()],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    throw new Error(
      `E2EE log check needs \`docker logs ${BACKEND_CONTAINER}\`; ` +
        'set E2EE_REAL_DB_CHECK=0 for a remote stack',
    );
  }
}
