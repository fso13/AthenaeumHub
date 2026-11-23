import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog';

describe('workspace create modal', () => {
  it('uses the shared centred backdrop, modal title/footer and focuses the name first', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <WorkspaceCreateDialog open busy={false} error={null} onClose={onClose} onCreate={vi.fn()} />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Новое пространство' });
    const backdrop = dialog.closest('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    expect(dialog.querySelector('.modal-title')).toHaveTextContent('Новое пространство');
    expect(dialog.querySelector('.modal-foot')).not.toBeNull();
    const input = screen.getByLabelText('Название пространства');
    await waitFor(() => expect(input).toHaveFocus());

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('passes an axe audit while open', async () => {
    render(
      <WorkspaceCreateDialog open busy={false} error={null} onClose={vi.fn()} onCreate={vi.fn()} />,
    );
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
  });
});
