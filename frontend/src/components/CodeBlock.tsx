import { useEffect, useMemo, useRef, useState } from 'react';
import { highlightCode, languageLabel } from '../domain/highlight';
import { t } from '../i18n/ru';

interface CodeBlockProps {
  readonly code: string;
  readonly language: string | null;
}

type CopyState = 'idle' | 'copied' | 'error';

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path; the button reports the final result.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Fenced code block: language label, copy-to-clipboard, monospace text and
 * horizontal scrolling on narrow screens. Syntax tokens are plain text inside
 * spans (no HTML). The `<pre>` is focusable so keyboard users can scroll long
 * lines without a mouse.
 */
export function CodeBlock({ code, language }: CodeBlockProps) {
  const label = languageLabel(language) ?? t('rich.codePlain');
  const tokens = useMemo(() => highlightCode(code, language), [code, language]);
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const mark = (next: CopyState) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setState(next);
    timer.current = window.setTimeout(() => setState('idle'), 2_000);
  };

  const copy = async () => {
    const ok = await writeClipboard(code);
    mark(ok ? 'copied' : 'error');
  };

  return (
    <figure className="code-block" data-code-lang={language ?? ''}>
      <figcaption className="code-block__head">
        <span className="code-block__lang">{label}</span>
        <button
          type="button"
          className="code-block__copy"
          onClick={() => void copy()}
          aria-label={t('rich.codeCopyLabel')}
          title={t('rich.codeCopyLabel')}
        >
          {state === 'copied' ? t('rich.codeCopied') : t('rich.codeCopy')}
        </button>
      </figcaption>
      <pre
        className="code-block__pre"
        tabIndex={0}
        aria-label={t('rich.codeRegion', { lang: label })}
      >
        <code className="code-block__code">
          {tokens.map((token, index) =>
            token.kind === 'plain' ? (
              token.text
            ) : (
              <span className={`tok tok--${token.kind}`} key={index}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
      <span className="visually-hidden" role="status" aria-live="polite">
        {state === 'copied'
          ? t('rich.codeCopied')
          : state === 'error'
            ? t('rich.codeCopyError')
            : ''}
      </span>
    </figure>
  );
}
