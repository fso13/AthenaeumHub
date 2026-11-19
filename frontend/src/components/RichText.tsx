import { useMemo, type ReactNode } from 'react';
import { parseRichText, type RichBlockNode, type RichInlineNode } from '../domain/richText';
import { t } from '../i18n/ru';
import { CodeBlock } from './CodeBlock';

interface RichTextProps {
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly className?: string;
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
          <a
            key={index}
            className="rich-link"
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {renderInlineNodes(node.children)}
          </a>
        );
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

function renderBlock(block: RichBlockNode, index: number): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return (
        <p className="rich-p" key={index}>
          <InlineContent nodes={block.children} />
        </p>
      );
    case 'quote':
      return (
        <blockquote className="rich-quote" key={index}>
          <InlineContent nodes={block.children} />
        </blockquote>
      );
    case 'list': {
      const items = block.items.map((item, itemIndex) => (
        <li className="rich-li" key={itemIndex}>
          <InlineContent nodes={item} />
        </li>
      ));
      return block.ordered ? (
        <ol
          className="rich-list rich-list--ordered"
          key={index}
          start={block.start === 1 ? undefined : block.start}
        >
          {items}
        </ol>
      ) : (
        <ul className="rich-list rich-list--unordered" key={index}>
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
 * Every text run is a React text node (no HTML sink),
 * links are restricted to `http(s)` by the parser, and the only elements
 * produced are `p`, `blockquote`, `ul/ol/li`, `strong`, `em`, `del`, `code`,
 * `a`, spans for mentions/tokens and the code-block figure.
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
