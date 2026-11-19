import { useMemo } from 'react';
import { parseMentionText } from '../domain/richText';
import { InlineContent } from './RichText';

interface MentionTextProps {
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly className?: string;
}

/**
 * Single-line-safe preview renderer: plain text plus mention chips.
 *
 * Used for reply quotes, the composer reply bar and thread previews, where
 * rendering full block Markdown (code fences, lists) would break the compact
 * layout. It is intentionally not a Markdown renderer.
 */
export function MentionText({ text, mentions = [], className }: MentionTextProps) {
  const nodes = useMemo(() => parseMentionText(text, mentions), [text, mentions]);
  return (
    <span className={className} dir="auto">
      <InlineContent nodes={nodes} />
    </span>
  );
}
