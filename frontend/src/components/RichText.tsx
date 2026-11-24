import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  parseRichText,
  type RichBlockNode,
  type RichInlineNode,
  type RichTableAlign,
} from '../domain/richText';
import { t } from '../i18n/ru';
import { CodeBlock } from './CodeBlock';

interface RichTextProps {
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly className?: string;
}

function RichImage({ src, alt }: { readonly src: string; readonly alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    // The alt text is the fallback: no broken-image icon, no layout jump.
    return <span className="rich-image-fallback">{alt.trim() || src}</span>;
  }
  return (
    <img
      className="rich-image"
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

interface LinkPreviewData {
  title: string | null;
  description: string | null;
  image: string | null;
}

function LinkPreviewAnchor({ href, children }: { href: string; children: ReactNode }) {
  const [preview, setPreview] = useState<LinkPreviewData | null>(null);
  const [host, setHost] = useState('');
  useEffect(() => {
    try {
      setHost(new URL(href).hostname.replace(/^www\./, ''));
    } catch {
      setHost('');
    }
    if (document.documentElement.dataset.linkPreviews === 'off') return;
    let cancelled = false;
    void fetch(`/api/v1/link-preview?url=${encodeURIComponent(href)}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) setPreview(data as LinkPreviewData);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [href]);
  if (!preview) {
    return (
      <a className="rich-link" href={href} target="_blank" rel="noopener noreferrer">
        <span className="rich-link__domain" aria-hidden="true">
          {host}
        </span>
        <span className="rich-link__text">{children}</span>
      </a>
    );
  }
  return (
    <a className="link-preview-card" href={href} target="_blank" rel="noopener noreferrer">
      {preview.image ? (
        <img className="link-preview-card__image" src={preview.image} alt="" loading="lazy" />
      ) : null}
      <span className="link-preview-card__body">
        <span className="link-preview-card__domain">{host}</span>
        {preview.title ? <strong>{preview.title}</strong> : <strong>{host}</strong>}
        {preview.description ? <span>{preview.description}</span> : null}
      </span>
    </a>
  );
}

function renderInlineNodes(nodes: readonly RichInlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'strong':
        return <strong key={index}>{renderInlineNodes(node.children)}</strong>;
      case 'em':
        return <em key={index}>{renderInlineNodes(node.children)}</em>;
      case 'del':
        return <del key={index}>{renderInlineNodes(node.children)}</del>;
      case 'code':
        return (
          <code className="rich-inline-code" key={index}>
            {node.text}
          </code>
        );
      case 'link':
        return (
          <LinkPreviewAnchor key={index} href={node.href}>
            {renderInlineNodes(node.children)}
          </LinkPreviewAnchor>
        );
      case 'image':
        return <RichImage key={index} src={node.src} alt={node.alt} />;
      case 'mention':
        return (
          <span
            key={index}
            className={`mention${node.all ? ' mention--all' : ''}`}
            data-mention={node.all ? 'all' : 'user'}
            aria-label={
              node.all ? t('mentions.allAria') : t('mentions.userAria', { name: node.name })
            }
          >
            @{node.all ? 'all' : node.name}
          </span>
        );
    }
  });
}

/** Inline-only renderer shared by RichText and the quote/thread preview. */
export function InlineContent({ nodes }: { readonly nodes: readonly RichInlineNode[] }) {
  return <>{renderInlineNodes(nodes)}</>;
}

function alignClass(align: RichTableAlign | null): string {
  return align === null ? '' : ` rich-table__cell--${align}`;
}

function renderBlock(block: RichBlockNode, index: number): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return (
        <p className="rich-p" key={index}>
          <InlineContent nodes={block.children} />
        </p>
      );
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag className={`rich-heading rich-heading--${block.level}`} key={index}>
          <InlineContent nodes={block.children} />
        </Tag>
      );
    }
    case 'thematicBreak':
      return <hr className="rich-hr" key={index} />;
    case 'quote':
      return (
        <blockquote className="rich-quote" key={index}>
          {block.children.map(renderBlock)}
        </blockquote>
      );
    case 'table':
      return (
        <div
          className="rich-table-wrap"
          key={index}
          role="region"
          aria-label={t('rich.tableRegion')}
          tabIndex={0}
        >
          <table className="rich-table">
            <thead>
              <tr>
                {block.header.map((cell, column) => (
                  <th
                    key={column}
                    scope="col"
                    className={`rich-table__cell${alignClass(block.align[column] ?? null)}`}
                  >
                    <InlineContent nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {block.header.map((_, column) => (
                    <td
                      key={column}
                      className={`rich-table__cell${alignClass(block.align[column] ?? null)}`}
                    >
                      <InlineContent nodes={row[column] ?? []} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list': {
      const allTasks = block.items.length > 0 && block.items.every((item) => item.task !== null);
      const items = block.items.map((item, itemIndex) => (
        <li
          className={`rich-li${item.task === null ? '' : ' rich-li--task'}`}
          key={itemIndex}
          data-task={item.task ?? undefined}
        >
          {item.task === null ? null : (
            <span
              className={`rich-task${item.task === 'checked' ? ' rich-task--checked' : ''}`}
              role="checkbox"
              aria-checked={item.task === 'checked'}
              aria-disabled="true"
              aria-label={item.task === 'checked' ? t('rich.taskDone') : t('rich.taskOpen')}
            />
          )}
          <InlineContent nodes={item.children} />
          {item.blocks.map(renderBlock)}
        </li>
      ));
      return block.ordered ? (
        <ol
          className={`rich-list rich-list--ordered${allTasks ? ' rich-list--tasks' : ''}`}
          key={index}
          start={block.start === 1 ? undefined : block.start}
        >
          {items}
        </ol>
      ) : (
        <ul
          className={`rich-list rich-list--unordered${allTasks ? ' rich-list--tasks' : ''}`}
          key={index}
        >
          {items}
        </ul>
      );
    }
    case 'code':
      return <CodeBlock key={index} code={block.code} language={block.lang} />;
  }
}

/**
 * Safe Markdown renderer for managed messages.
 *
 * Every text run is a React text node (no HTML sink), links and image sources
 * are restricted to `http(s)` by the parser, and the only elements produced are
 * `p`, `h1`–`h6`, `hr`, `blockquote`, `ul/ol/li`, `strong`, `em`, `del`, `code`,
 * `a`, `img`, `table` (+ wrapper), spans for mentions/task boxes and the
 * code-block figure.
 */
export function RichText({ text, mentions = [], className }: RichTextProps) {
  const blocks = useMemo(() => parseRichText(text, { mentions }), [text, mentions]);
  const classes = className === undefined ? 'rich-text' : `rich-text ${className}`;
  return (
    <div className={classes} data-rich-text="true" dir="auto">
      {blocks.map(renderBlock)}
    </div>
  );
}
