import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RichText } from './RichText';

const clipboardWrite = vi.fn<(text: string) => Promise<void>>();

function installClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
}

/** user-event installs its own clipboard stub during setup; ours must win. */
function setupUser() {
  const user = userEvent.setup();
  installClipboard();
  return user;
}

beforeEach(() => {
  clipboardWrite.mockReset();
  clipboardWrite.mockResolvedValue(undefined);
  installClipboard();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('RichText', () => {
  it('renders the supported markdown elements and mention chips', () => {
    const { container } = render(
      <RichText
        text={
          '**жирный** _курсив_ ~~зачёркнуто~~ `const a = 1`\n\n> цитата\n\n- один\n- два\n\n1. раз\n2. два\n\n@Анна Петрова и @all'
        }
        mentions={['Анна Петрова']}
      />,
    );

    expect(screen.getByText('жирный').tagName).toBe('STRONG');
    expect(screen.getByText('курсив').tagName).toBe('EM');
    expect(screen.getByText('зачёркнуто').tagName).toBe('DEL');
    expect(screen.getByText('const a = 1').tagName).toBe('CODE');
    expect(container.querySelector('blockquote')).not.toBeNull();
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelectorAll('.mention')).toHaveLength(2);
    expect(container.querySelector('.mention--all')).toHaveTextContent('@all');
  });

  it('escapes raw HTML and rejects unsafe links', () => {
    const { container } = render(
      <RichText
        text={'<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))'}
      />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('[x](javascript:alert(1))');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('opens http(s) links in a new tab with noopener', () => {
    render(<RichText text="[сайт](https://example.com/a?b=1)" />);
    const link = screen.getByRole('link', { name: 'сайт' });
    expect(link).toHaveAttribute('href', 'https://example.com/a?b=1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders a code block with a language label, tokens and horizontal scroll', () => {
    const { container } = render(<RichText text={'```ts\nconst answer = 42; // yes\n```'} />);
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre).toHaveAttribute('tabindex', '0');
    expect(pre?.className).toContain('code-block__pre');
    expect(container.querySelectorAll('.tok--keyword').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.tok--comment').length).toBeGreaterThan(0);
  });

  it('keeps unknown languages plain and labelled with their raw name', () => {
    const { container } = render(<RichText text={'```brainfuck\n+++[>++<-].\n```'} />);
    expect(screen.getByText('brainfuck')).toBeInTheDocument();
    expect(container.querySelectorAll('.tok')).toHaveLength(0);
    expect(container.querySelector('.code-block__code')?.textContent).toBe('+++[>++<-].');
  });

  it('copies the raw code and announces success', async () => {
    const user = setupUser();
    const code = 'const a = 1;\nconsole.log(a);';
    render(<RichText text={'```js\n' + code + '\n```'} />);

    const button = screen.getByRole('button', { name: 'Скопировать код' });
    await user.click(button);

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(code));
    expect(button).toHaveTextContent('Скопировано');
  });

  it('reports a clipboard failure without losing the code', async () => {
    clipboardWrite.mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    const user = setupUser();
    const { container } = render(<RichText text={'```js\nconst a = 1;\n```'} />);

    await user.click(screen.getByRole('button', { name: 'Скопировать код' }));

    await screen.findByText('Не удалось скопировать');
    expect(container.querySelector('.code-block__code')?.textContent).toBe('const a = 1;');
  });

  it('passes an axe audit', async () => {
    const { container } = render(
      <RichText
        text={
          '**bold** [link](https://example.com) @all\n\n```ts\nconst a = 1;\n```\n\n> quote\n\n- list'
        }
        mentions={[]}
      />,
    );
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});
