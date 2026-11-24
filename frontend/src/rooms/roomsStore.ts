import type { ChatApi } from '../api/endpoints';
import { toApiError, type ApiError } from '../api/problem';
import type { Room } from '../api/types';

/**
 * #105 rooms read/write model.
 *
 * The backend owns room metadata, permissions and a 30-second TTL presence row;
 * it deliberately keeps **no** call, SDP/ICE, SFU, recording or media state.
 * This store therefore:
 *  - polls `GET /workspaces/{id}/rooms` every 5 s (the list already contains
 *    TTL-filtered participants and `my_present`);
 *  - sends `POST /rooms/{id}/presence` on join and every 5 s while present;
 *  - sends an idempotent `DELETE /rooms/{id}/presence` on leave/unmount;
 *  - starts the existing mesh `CallController.startConference` through an
 *    injected bridge when other participants are already present. Nothing here
 *    claims an SFU: the conference is a full mesh over `call.signal`.
 *  - #107: `media_mode` (AUDIO|VIDEO) is server metadata; joining starts the
 *    mesh with `video=false` for AUDIO and `true` for VIDEO. The mode can only
 *    be changed through the contract's partial PATCH.
 */

/** Poll interval for the workspace room list (contract §3.1/§4). */
export const ROOMS_POLL_INTERVAL_MS = 5_000;
/** Presence heartbeat interval; the server TTL is 30 s. */
export const ROOMS_HEARTBEAT_INTERVAL_MS = 5_000;

/** Why a mesh conference did not start; the page renders honest RU copy. */
export type RoomCallIssueReason = 'offline' | 'busy' | 'unavailable';

export interface RoomCallIssue {
  roomId: string;
  reason: RoomCallIssueReason;
}

/**
 * Call bridge owned by `ChatStore`: the room store never touches the WebRTC
 * engine directly, so the media lifecycle stays in one place.
 */
export interface RoomCallBridge {
  startConference(
    chatId: string,
    peerUserIds: readonly string[],
    video: boolean,
    callId?: string,
  ): boolean;
  activeCallChatId(): string | null;
  endCallForChat(chatId: string): void;
}

/** #107 room media mode; a missing/invalid contract value falls back to VIDEO. */
export type RoomMediaMode = NonNullable<Room['media_mode']>;
export const DEFAULT_ROOM_MEDIA_MODE: RoomMediaMode = 'VIDEO';

export function roomMediaMode(room: { media_mode?: Room['media_mode'] }): RoomMediaMode {
  return room.media_mode === 'AUDIO' ? 'AUDIO' : DEFAULT_ROOM_MEDIA_MODE;
}

export type RoomsStatus = 'idle' | 'loading' | 'ready' | 'error';
export type RoomPresenceStatus = 'idle' | 'joining' | 'present' | 'leaving' | 'error';
export type RoomsActionKind = 'create' | 'rename' | 'media_mode' | 'close' | 'join' | 'leave';

export interface RoomsActionError {
  kind: RoomsActionKind;
  roomId: string | null;
  error: ApiError;
}

export interface RoomsState {
  workspaceId: string | null;
  items: Room[];
  status: RoomsStatus;
  /** Initial-load failure (no rows rendered). */
  error: ApiError | null;
  /** Background poll failure while rows stay visible. */
  refreshError: ApiError | null;
  /** Room the caller joined on this device (local mirror of `my_present`). */
  presenceRoomId: string | null;
  presenceStatus: RoomPresenceStatus;
  presenceError: ApiError | null;
  pending: { kind: RoomsActionKind; roomId: string | null } | null;
  actionError: RoomsActionError | null;
  /** A join found other participants but the mesh could not start. */
  callIssue: RoomCallIssue | null;
}

export interface RoomsStoreDeps {
  api: Pick<
    ChatApi,
    | 'listRooms'
    | 'createRoom'
    | 'updateRoom'
    | 'closeRoom'
    | 'joinRoomPresence'
    | 'leaveRoomPresence'
  >;
  calls: RoomCallBridge;
  /** `null` before the session/me bootstrap resolves. */
  getSelfId: () => string | null;
  heartbeatMs?: number;
}

export function createInitialRoomsState(): RoomsState {
  return {
    workspaceId: null,
    items: [],
    status: 'idle',
    error: null,
    refreshError: null,
    presenceRoomId: null,
    presenceStatus: 'idle',
    presenceError: null,
    pending: null,
    actionError: null,
    callIssue: null,
  };
}

/** True when `last_seen_at` is inside the server's 30 s presence TTL. */
export function isRoomParticipantFresh(lastSeenAt: string, now = Date.now()): boolean {
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return false;
  return now - seen <= 30_000;
}

export class RoomsStore {
  private readonly api: RoomsStoreDeps['api'];
  private readonly calls: RoomCallBridge;
  private readonly getSelfId: () => string | null;
  private readonly heartbeatMs: number;
  private state: RoomsState = createInitialRoomsState();
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private generation = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInFlight = false;
  private disposed = false;

  constructor(deps: RoomsStoreDeps) {
    this.api = deps.api;
    this.calls = deps.calls;
    this.getSelfId = deps.getSelfId;
    this.heartbeatMs = deps.heartbeatMs ?? ROOMS_HEARTBEAT_INTERVAL_MS;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): RoomsState => this.state;

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.inFlight = null;
    this.stopHeartbeat();
    this.listeners.clear();
  }

  reset(): void {
    this.generation += 1;
    this.inFlight = null;
    this.stopHeartbeat();
    this.state = createInitialRoomsState();
    this.emit();
  }

  /**
   * Switch the read model to another workspace. A local presence row belongs to
   * the previous workspace, so it is dropped (best-effort DELETE) together with
   * a room call that may still be running.
   */
  setWorkspace(workspaceId: string | null): void {
    if (workspaceId === this.state.workspaceId) return;
    const previousRoomId = this.state.presenceRoomId;
    this.generation += 1;
    this.inFlight = null;
    this.stopHeartbeat();
    this.endRoomCall();
    if (previousRoomId) void this.api.leaveRoomPresence(previousRoomId).catch(() => undefined);
    this.state = { ...createInitialRoomsState(), workspaceId };
    this.emit();
  }

  /** `force` bypasses the ready short-circuit (polling/retry). */
  async load(force = false): Promise<void> {
    if (this.disposed) return;
    const workspaceId = this.state.workspaceId;
    if (!workspaceId) return;
    if (this.inFlight) return this.inFlight;
    if (!force && this.state.status === 'ready') return;

    const generation = this.generation;
    if (this.state.status !== 'ready') this.patch({ status: 'loading', error: null });

    this.inFlight = (async () => {
      try {
        const response = await this.api.listRooms(workspaceId);
        if (this.disposed || generation !== this.generation) return;
        this.patch({
          items: response.items,
          status: 'ready',
          error: null,
          refreshError: null,
        });
      } catch (error) {
        if (this.disposed || generation !== this.generation) return;
        const apiError = toApiError(error);
        if (this.state.status === 'ready') this.patch({ refreshError: apiError });
        else this.patch({ status: 'error', error: apiError });
      } finally {
        if (generation === this.generation) this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  clearActionError(): void {
    if (this.state.actionError === null) return;
    this.patch({ actionError: null });
  }

  clearCallIssue(): void {
    if (this.state.callIssue === null) return;
    this.patch({ callIssue: null });
  }

  async createRoom(
    name: string,
    mediaMode: RoomMediaMode = DEFAULT_ROOM_MEDIA_MODE,
  ): Promise<boolean> {
    const workspaceId = this.state.workspaceId;
    if (!workspaceId || this.state.pending !== null) return false;
    this.patch({ pending: { kind: 'create', roomId: null }, actionError: null });
    try {
      const room = await this.api.createRoom(workspaceId, {
        name: name.trim(),
        media_mode: roomMediaMode({ media_mode: mediaMode }),
      });
      this.patch({
        items: [room, ...this.state.items],
        status: 'ready',
        error: null,
        pending: null,
      });
      return true;
    } catch (error) {
      this.patch({
        pending: null,
        actionError: { kind: 'create', roomId: null, error: toApiError(error) },
      });
      return false;
    }
  }

  async renameRoom(roomId: string, name: string): Promise<boolean> {
    const workspaceId = this.state.workspaceId;
    if (!workspaceId || this.state.pending !== null) return false;
    this.patch({ pending: { kind: 'rename', roomId }, actionError: null });
    try {
      const room = await this.api.updateRoom(workspaceId, roomId, { name: name.trim() });
      this.patch({
        items: this.state.items.map((item) => (item.id === roomId ? room : item)),
        pending: null,
      });
      return true;
    } catch (error) {
      this.patch({
        pending: null,
        actionError: { kind: 'rename', roomId, error: toApiError(error) },
      });
      return false;
    }
  }

  /**
   * #107: creator/OWNER/ADMIN changes only the room metadata. The server
   * returns the updated projection; nothing is patched optimistically.
   */
  async updateRoomMediaMode(roomId: string, mediaMode: RoomMediaMode): Promise<boolean> {
    const workspaceId = this.state.workspaceId;
    if (!workspaceId || this.state.pending !== null) return false;
    if (!this.findRoom(roomId)) return false;
    this.patch({ pending: { kind: 'media_mode', roomId }, actionError: null });
    try {
      const room = await this.api.updateRoom(workspaceId, roomId, {
        media_mode: roomMediaMode({ media_mode: mediaMode }),
      });
      this.patch({
        items: this.state.items.map((item) => (item.id === roomId ? room : item)),
        pending: null,
      });
      return true;
    } catch (error) {
      this.patch({
        pending: null,
        actionError: { kind: 'media_mode', roomId, error: toApiError(error) },
      });
      return false;
    }
  }

  async closeRoom(roomId: string): Promise<boolean> {
    const workspaceId = this.state.workspaceId;
    if (!workspaceId || this.state.pending !== null) return false;
    this.patch({ pending: { kind: 'close', roomId }, actionError: null });
    try {
      await this.api.closeRoom(workspaceId, roomId);
      const joined = this.state.presenceRoomId === roomId;
      if (joined) {
        this.stopHeartbeat();
        this.endRoomCall();
      }
      this.patch({
        items: this.state.items.filter((item) => item.id !== roomId),
        presenceRoomId: joined ? null : this.state.presenceRoomId,
        presenceStatus: joined ? 'idle' : this.state.presenceStatus,
        callIssue: this.state.callIssue?.roomId === roomId ? null : this.state.callIssue,
        pending: null,
      });
      // Closed room presence is ephemeral only; the DELETE is allowed and
      // idempotent, so the local row never lingers for the TTL window.
      if (joined) void this.api.leaveRoomPresence(roomId).catch(() => undefined);
      return true;
    } catch (error) {
      this.patch({
        pending: null,
        actionError: { kind: 'close', roomId, error: toApiError(error) },
      });
      return false;
    }
  }

  /**
   * Join (or re-join) a room: upsert presence, start the 5 s heartbeat, refresh
   * the participant list and, when others are already present, start the mesh
   * conference towards exactly those peers.
   */
  async joinRoom(roomId: string): Promise<boolean> {
    if (this.state.pending !== null) return false;
    const room = this.findRoom(roomId);
    if (!room) return false;
    if (this.state.presenceRoomId === roomId && this.state.presenceStatus === 'present') {
      return true;
    }
    // One presence row per device: leaving the previous room avoids ghost rows.
    if (this.state.presenceRoomId !== null) {
      const previous = this.state.presenceRoomId;
      this.stopHeartbeat();
      try {
        await this.api.leaveRoomPresence(previous);
      } catch {
        // TTL cleans a failed DELETE; the new join must not be blocked.
      }
      this.endRoomCall();
    }

    this.patch({
      pending: { kind: 'join', roomId },
      presenceStatus: 'joining',
      presenceRoomId: roomId,
      presenceError: null,
      actionError: null,
      callIssue: null,
    });
    try {
      await this.api.joinRoomPresence(roomId);
    } catch (error) {
      this.patch({
        pending: null,
        presenceStatus: 'error',
        presenceRoomId: null,
        presenceError: toApiError(error),
      });
      return false;
    }

    this.patch({ presenceStatus: 'present', pending: null });
    this.startHeartbeat();
    // The just-POSTed presence must be visible in the peers' next TTL read.
    await this.load(true);
    const fresh = this.findRoom(roomId);
    const selfId = this.getSelfId();
    const peers = (fresh?.participants ?? [])
      .map((participant) => participant.user_id)
      .filter((userId) => userId.length > 0 && userId !== selfId);
    if (this.state.presenceRoomId === roomId) {
      const mode = roomMediaMode(fresh ?? room);
      const started = this.calls.startConference(
        fresh?.chat_id ?? room.chat_id,
        peers,
        mode === 'VIDEO',
        room.id,
      );
      if (!started) {
        this.patch({
          callIssue: { roomId, reason: this.calls.activeCallChatId() ? 'busy' : 'offline' },
        });
      }
    }
    return true;
  }

  /** Explicit leave: stop the mesh leg, clear the heartbeat, DELETE presence. */
  async leaveRoom(): Promise<boolean> {
    const roomId = this.state.presenceRoomId;
    if (roomId === null) {
      this.patch({ presenceStatus: 'idle', presenceError: null, callIssue: null });
      return true;
    }
    if (this.state.pending !== null) return false;
    this.patch({
      pending: { kind: 'leave', roomId },
      presenceStatus: 'leaving',
      actionError: null,
    });
    this.stopHeartbeat();
    this.endRoomCall();
    let ok = true;
    try {
      await this.api.leaveRoomPresence(roomId);
    } catch (error) {
      const apiError = toApiError(error);
      // A missing row already means "not present"; any other failure is shown.
      if (apiError.status !== 404) {
        ok = false;
        this.patch({ presenceError: apiError });
      }
    }
    this.patch({
      presenceRoomId: null,
      presenceStatus: ok ? 'idle' : 'error',
      pending: null,
      callIssue: null,
    });
    await this.load(true);
    return ok;
  }

  /**
   * Page teardown ("уход со страницы"): stop the 5 s heartbeat, hang up a call
   * of this room and DELETE presence. Fire-and-forget because React unmount
   * cannot await; the server TTL is the fallback if the DELETE loses the race.
   */
  detach(): void {
    const roomId = this.state.presenceRoomId;
    this.stopHeartbeat();
    this.endRoomCall();
    if (roomId !== null) {
      void this.api.leaveRoomPresence(roomId).catch(() => undefined);
    }
    this.patch({
      presenceRoomId: null,
      presenceStatus: 'idle',
      presenceError: null,
      callIssue: null,
    });
  }

  /** True when this room is present locally or the server reports `my_present`. */
  isPresent(room: Room): boolean {
    return room.my_present || room.id === this.state.presenceRoomId;
  }

  private findRoom(roomId: string): Room | null {
    return this.state.items.find((item) => item.id === roomId) ?? null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const roomId = this.state.presenceRoomId;
      if (roomId === null || this.heartbeatInFlight || this.disposed) return;
      const generation = this.generation;
      this.heartbeatInFlight = true;
      void this.api
        .joinRoomPresence(roomId)
        .then(() => {
          if (generation !== this.generation) return;
          if (this.state.presenceError !== null) {
            this.patch({ presenceError: null, presenceStatus: 'present' });
          }
        })
        .catch((error: unknown) => {
          if (generation !== this.generation) return;
          const apiError = toApiError(error);
          this.patch({ presenceError: apiError, presenceStatus: 'error' });
          if (apiError.status === 404 || apiError.status === 409) {
            // Room closed/removed: stop claiming presence and refresh the list.
            this.stopHeartbeat();
            void this.load(true);
          }
        })
        .finally(() => {
          this.heartbeatInFlight = false;
        });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * End a live call that belongs to a room. Incoming room calls carry the same
   * `chat_id`, so navigating away from the rooms page also stops them.
   */
  private endRoomCall(): void {
    const chatId = this.calls.activeCallChatId();
    if (!chatId) return;
    const belongsToRoom = this.state.items.some((room) => room.chat_id === chatId);
    if (belongsToRoom) this.calls.endCallForChat(chatId);
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<RoomsState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }
}

export function createRoomsStore(deps: RoomsStoreDeps): RoomsStore {
  return new RoomsStore(deps);
}
