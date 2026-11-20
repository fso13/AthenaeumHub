import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { StickerRef } from '../api/types';
import { describeError } from '../domain/errors';
import { t } from '../i18n/ru';
import {
  favoriteStickers,
  filterStickers,
  recentStickers,
  stickerAssetUrl,
} from '../stickers/model';
import type { StickersState } from '../stickers/store';
import { CloseIcon, StickerIcon } from './Icons';

export type StickerSendBlockedReason =
  'offline' | 'rate_limit' | 'read_only' | 'e2ee_blocked' | null;

interface StickerPickerProps {
  state: StickersState;
  onSend: (sticker: StickerRef) => void;
  onFavorite: (sticker: StickerRef) => void;
  onRetry: () => void;
  onClose: () => void;
  sendBlockedReason: StickerSendBlockedReason;
  rateLimitSeconds: number;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

type TabKey = 'favorites' | 'recent' | `pack:${string}`;

const FAVORITES_TAB: TabKey = 'favorites';
const RECENT_TAB: TabKey = 'recent';

export function StickerPicker({
  state,
  onSend,
  onFavorite,
  onRetry,
  onClose,
  sendBlockedReason,
  rateLimitSeconds,
  triggerRef,
}: StickerPickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const [activeTab, setActiveTab] = useState<TabKey>(FAVORITES_TAB);
  const [query, setQuery] = useState('');
  const panelId = useId();
  const gridId = `${panelId}-grid`;

  const packs = useMemo(
    () => state.packs.filter((pack) => !state.disabledPackIds.includes(pack.id)),
    [state.packs, state.disabledPackIds],
  );
  const favorites = useMemo(
    () => favoriteStickers(state.packs, state.disabledPackIds),
    [state.packs, state.disabledPackIds],
  );
  const recent = useMemo(
    () => recentStickers(state.packs, state.disabledPackIds, state.recent),
    [state.packs, state.disabledPackIds, state.recent],
  );

  const tabs = useMemo(
    () => [
      { key: FAVORITES_TAB, label: t('stickers.favorites') },
      { key: RECENT_TAB, label: t('stickers.recent') },
      ...packs.map((pack) => ({
        key: `pack:${pack.id}` as TabKey,
        label: pack.name,
      })),
    ],
    [packs],
  );

  // The active tab can disappear (pack disabled, favorites layout change).
  useEffect(() => {
    if (tabs.some((tab) => tab.key === activeTab)) return;
    setActiveTab(tabs[0]?.key ?? FAVORITES_TAB);
  }, [activeTab, tabs]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, triggerRef]);

  const sendEnabled = sendBlockedReason === null;
  const sendNote =
    sendBlockedReason === 'offline'
      ? t('stickers.offline')
      : sendBlockedReason === 'rate_limit'
        ? t('stickers.rateLimited', { seconds: rateLimitSeconds })
        : sendBlockedReason === 'read_only'
          ? t('composer.readOnly')
          : sendBlockedReason === 'e2ee_blocked'
            ? t('composer.e2eeBlocked')
            : null;

  const selectedPackId =
    activeTab.startsWith('pack:') && activeTab.length > 'pack:'.length
      ? activeTab.slice('pack:'.length)
      : null;
  const baseItems =
    activeTab === FAVORITES_TAB
      ? favorites
      : activeTab === RECENT_TAB
        ? recent
        : (packs.find((pack) => pack.id === selectedPackId)?.stickers ?? []);
  const items = filterStickers(baseItems, query);

  const emptyText =
    activeTab === FAVORITES_TAB
      ? t('stickers.emptyFavorites')
      : activeTab === RECENT_TAB
        ? t('stickers.emptyRecent')
        : query.trim()
          ? t('stickers.emptySearch')
          : t('stickers.emptyPack');
  const showSearchEmpty = query.trim().length > 0 && items.length === 0;

  const disabledPackNames = state.disabledPackIds
    .map((packId) => state.packs.find((pack) => pack.id === packId)?.name)
    .filter((name): name is string => Boolean(name));
  const favoriteErrorDescription = state.favoriteError ? describeError(state.favoriteError) : null;
  const loadErrorDescription = state.error ? describeError(state.error) : null;

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.key === activeTab);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    setActiveTab(target.key);
    const element = document.getElementById(`${panelId}-tab-${tabDomId(target.key)}`);
    element?.focus();
  };

  const handleGridKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      return;
    }
    const buttons = Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-sticker-send="true"]') ?? [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;

    const columns = 6;
    let next = current;
    if (event.key === 'ArrowRight') next = Math.min(buttons.length - 1, current + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, current + columns);
    else if (event.key === 'ArrowUp') next = Math.max(0, current - columns);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    event.preventDefault();
    buttons[next]?.focus();
  };

  const closeAndRestoreFocus = () => {
    onClose();
    triggerRef.current?.focus();
  };

  return (
    <div
      className="sticker-picker"
      id="sticker-picker"
      ref={panelRef}
      role="dialog"
      aria-label={t('stickers.title')}
      aria-modal="false"
    >
      <div className="sticker-picker__head">
        <span className="sticker-picker__title">
          <StickerIcon aria-hidden="true" />
          {t('stickers.title')}
        </span>
        <label className="visually-hidden" htmlFor={`${panelId}-search`}>
          {t('stickers.searchLabel')}
        </label>
        <input
          id={`${panelId}-search`}
          ref={searchRef}
          className="sticker-picker__search"
          type="search"
          value={query}
          placeholder={t('stickers.searchPlaceholder')}
          aria-controls={gridId}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="icon-button icon-button--small"
          onClick={closeAndRestoreFocus}
          aria-label={t('stickers.close')}
          title={t('stickers.close')}
        >
          <CloseIcon aria-hidden="true" />
        </button>
      </div>

      {state.status === 'idle' || state.status === 'loading' ? (
        <p className="sticker-picker__state" role="status">
          <span className="spinner" aria-hidden="true" />
          {t('stickers.loading')}
        </p>
      ) : state.status === 'error' ? (
        <div className="sticker-picker__state sticker-picker__state--error" role="alert">
          <span>{t('stickers.loadError')}</span>
          {loadErrorDescription ? (
            <span className="sticker-picker__empty">{loadErrorDescription.title}</span>
          ) : null}
          {state.error ? (
            <span className="sticker-picker__error-code">{state.error.code}</span>
          ) : null}
          <button type="button" className="button button--small" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <>
          {disabledPackNames.length > 0 ? (
            <p className="sticker-picker__notice" role="status">
              {t('stickers.packDisabled', { name: disabledPackNames.join(', ') })}
            </p>
          ) : null}
          {favoriteErrorDescription ? (
            <p className="sticker-picker__notice sticker-picker__notice--error" role="alert">
              {favoriteErrorDescription.title}. {favoriteErrorDescription.message}
            </p>
          ) : null}

          <div
            className="sticker-picker__tabs"
            role="tablist"
            aria-label={t('stickers.tabsLabel')}
            onKeyDown={handleTabKeyDown}
          >
            {tabs.map((tab) => {
              const selected = tab.key === activeTab;
              return (
                <button
                  key={tab.key}
                  id={`${panelId}-tab-${tabDomId(tab.key)}`}
                  type="button"
                  role="tab"
                  className={`sticker-tab${selected ? ' sticker-tab--active' : ''}`}
                  aria-selected={selected}
                  aria-controls={gridId}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div
            className="sticker-picker__body"
            role="tabpanel"
            id={gridId}
            aria-labelledby={`${panelId}-tab-${tabDomId(activeTab)}`}
          >
            {sendNote ? <p className="sticker-picker__notice">{sendNote}</p> : null}
            {items.length === 0 ? (
              <p className="sticker-picker__empty" role="status">
                {showSearchEmpty || query.trim() ? t('stickers.emptySearch') : emptyText}
              </p>
            ) : (
              <ul className="sticker-grid" ref={gridRef} onKeyDown={handleGridKeyDown}>
                {items.map((sticker) => (
                  <li className="sticker-grid__item" key={sticker.id}>
                    <button
                      type="button"
                      className="sticker-button"
                      data-sticker-send="true"
                      data-sticker-id={sticker.id}
                      aria-label={t('stickers.send', { alt: sticker.alt })}
                      aria-disabled={!sendEnabled}
                      title={sticker.alt}
                      onClick={() => {
                        if (!sendEnabled) return;
                        onSend(sticker);
                      }}
                    >
                      <img
                        className="sticker-image"
                        src={stickerAssetUrl(sticker.url)}
                        alt=""
                        aria-hidden="true"
                        width={512}
                        height={512}
                        loading="eager"
                        decoding="async"
                        draggable={false}
                      />
                    </button>
                    <button
                      type="button"
                      className={`sticker-favorite${sticker.favorite ? ' sticker-favorite--on' : ''}`}
                      aria-pressed={sticker.favorite}
                      aria-label={t(
                        sticker.favorite ? 'stickers.favoriteRemove' : 'stickers.favoriteAdd',
                        { alt: sticker.alt },
                      )}
                      disabled={state.pendingFavoriteIds.includes(sticker.id)}
                      onClick={() => onFavorite(sticker)}
                    >
                      <span aria-hidden="true">{sticker.favorite ? '★' : '☆'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="sticker-picker__hint">{t('stickers.hint')}</p>
        </>
      )}
    </div>
  );
}

function tabDomId(key: TabKey): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '-');
}
