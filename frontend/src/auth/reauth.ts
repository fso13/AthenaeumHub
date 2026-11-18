type ReauthHandler = () => Promise<boolean>;

let handler: ReauthHandler | null = null;

/** Registered by the password auth provider; the API layer calls it on the first 401. */
export function setReauthHandler(next: ReauthHandler | null): void {
  handler = next;
}

export async function reauthenticate(): Promise<boolean> {
  if (!handler) return false;
  try {
    return await handler();
  } catch {
    return false;
  }
}

export function resetReauthForTests(): void {
  handler = null;
}
