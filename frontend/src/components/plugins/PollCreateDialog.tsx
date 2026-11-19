import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ApiError } from '../../api/problem';
import type { Poll } from '../../api/types';
import { t } from '../../i18n/ru';
import { usePluginActionsState, usePluginActionsStore } from '../../store/ChatProvider';
import { pluginActionErrorText } from '../../plugins/errors';
import { PluginModal } from './PluginModal';

const MAX_QUESTION = 500;
const MAX_OPTION = 200;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

function hasForbiddenChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '<' || char === '>') return true;
  }
  return false;
}

function textIssue(value: string, max: number): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return 'length';
  if (hasForbiddenChars(trimmed)) return 'chars';
  return null;
}

interface PollCreateDialogProps {
  chatId: string;
  onClose: () => void;
  onCreated: (poll: Poll) => void;
}

/**
 * D1.1 (#76) poll composer. Mirrors the contract bounds (question 1..500,
 * 2..10 unique options 1..200) for fast feedback, but the server stays
 * authoritative: the created card comes from the `201` response and no row is
 * inserted on a failed call.
 */
export function PollCreateDialog({ chatId, onClose, onCreated }: PollCreateDialogProps) {
  const store = usePluginActionsStore();
  const state = usePluginActionsState();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [optionErrors, setOptionErrors] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<ApiError | null>(null);
  const titleId = useId();
  const questionId = useId();
  const questionErrorId = useId();
  const formErrorId = useId();
  const questionRef = useRef<HTMLInputElement>(null);
  const busy = state.createPollPending;

  useEffect(() => {
    store.clearCreatePollError();
    questionRef.current?.focus();
  }, [store]);

  const optionIds = options.map((_, index) => `poll-option-${index}`);

  const validate = (): boolean => {
    let valid = true;
    const questionIssue = textIssue(question, MAX_QUESTION);
    if (questionIssue !== null) {
      setQuestionError(t('pluginActions.validationQuestion'));
      valid = false;
    } else {
      setQuestionError(null);
    }

    const trimmed = options.map((option) => option.trim());
    const nextErrors: Record<number, string> = {};
    trimmed.forEach((option, index) => {
      if (textIssue(option, MAX_OPTION) !== null) {
        nextErrors[index] = t('pluginActions.validationOption');
        valid = false;
        return;
      }
      if (trimmed.some((other, otherIndex) => otherIndex !== index && other === option)) {
        nextErrors[index] = t('pluginActions.validationOptionsUnique');
        valid = false;
      }
    });
    if (trimmed.length < MIN_OPTIONS || trimmed.length > MAX_OPTIONS) {
      nextErrors[0] = t('pluginActions.validationOptionsCount');
      valid = false;
    }
    setOptionErrors(nextErrors);
    return valid;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    if (!validate()) return;
    const poll = await store.createPoll(chatId, {
      question: question.trim(),
      options: options.map((option) => option.trim()),
    });
    if (poll) {
      onCreated(poll);
      return;
    }
    setFormError(store.getSnapshot().createPollError);
  };

  return (
    <PluginModal
      title={t('pluginActions.pollDialogTitle')}
      titleId={titleId}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {t('pluginActions.cancel')}
          </button>
          <button
            type="submit"
            form="poll-create-form"
            className="button button--primary"
            disabled={busy}
          >
            {busy ? t('pluginActions.pollSubmitting') : t('pluginActions.pollSubmit')}
          </button>
        </>
      }
    >
      <form id="poll-create-form" className="plugin-form" onSubmit={(event) => void submit(event)}>
        <div className="plugin-field">
          <label htmlFor={questionId}>{t('pluginActions.pollQuestion')}</label>
          <input
            id={questionId}
            ref={questionRef}
            type="text"
            value={question}
            maxLength={MAX_QUESTION}
            placeholder={t('pluginActions.pollQuestionPlaceholder')}
            aria-invalid={questionError !== null}
            aria-describedby={questionError ? questionErrorId : undefined}
            onChange={(event) => {
              setQuestion(event.target.value);
              if (questionError) setQuestionError(null);
            }}
          />
          {questionError ? (
            <p className="plugin-field__error" id={questionErrorId} role="alert">
              {questionError}
            </p>
          ) : null}
        </div>

        <fieldset className="plugin-field plugin-field--group">
          <legend>{t('pluginActions.pollOptions')}</legend>
          {options.map((option, index) => {
            const error = optionErrors[index] ?? null;
            const errorId = `${optionIds[index]}-error`;
            return (
              <div className="plugin-option-row" key={optionIds[index]}>
                <label className="visually-hidden" htmlFor={optionIds[index]}>
                  {t('pluginActions.optionLabel', { index: index + 1 })}
                </label>
                <input
                  id={optionIds[index]}
                  type="text"
                  value={option}
                  maxLength={MAX_OPTION}
                  placeholder={t('pluginActions.optionLabel', { index: index + 1 })}
                  aria-invalid={error !== null}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(event) => {
                    const next = event.target.value;
                    setOptions((current) =>
                      current.map((item, itemIndex) => (itemIndex === index ? next : item)),
                    );
                    if (optionErrors[index]) {
                      setOptionErrors((current) => {
                        const copy = { ...current };
                        delete copy[index];
                        return copy;
                      });
                    }
                  }}
                />
                <button
                  type="button"
                  className="icon-button icon-button--small"
                  onClick={() => {
                    setOptions((current) => current.filter((_, i) => i !== index));
                    setOptionErrors({});
                  }}
                  disabled={options.length <= MIN_OPTIONS || busy}
                  aria-label={t('pluginActions.removeOption', { index: index + 1 })}
                  title={t('pluginActions.removeOption', { index: index + 1 })}
                >
                  ×
                </button>
                {error ? (
                  <p className="plugin-field__error" id={errorId} role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            className="button button--small"
            onClick={() => {
              setOptions((current) => [...current, '']);
              setOptionErrors({});
            }}
            disabled={options.length >= MAX_OPTIONS || busy}
          >
            {t('pluginActions.addOption')}
          </button>
        </fieldset>

        {formError ? (
          <p className="plugin-form__error" id={formErrorId} role="alert">
            {t('pluginActions.pollCreateError')} {pluginActionErrorText(formError, 'pollCreate')}
          </p>
        ) : null}
      </form>
    </PluginModal>
  );
}
