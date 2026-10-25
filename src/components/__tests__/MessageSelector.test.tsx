import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import figures from 'figures';
import { PassThrough } from 'node:stream';
import * as React from 'react';
import stripAnsi from 'strip-ansi';
import { KeybindingSetup, parseBindings, wrappedRender as render } from '@anthropic/ink';
import { debugMock } from '../../../tests/mocks/debug';
import { logMock } from '../../../tests/mocks/log';

mock.module('src/utils/log.ts', logMock);
mock.module('src/utils/debug.ts', debugMock);

// Dynamic imports so the log/debug mocks above are installed before these
// modules (and their transitive imports) are evaluated.
const { MessageSelector } = await import('../MessageSelector.js');
const { AppStoreContext, getDefaultAppState } = await import('../../state/AppState.js');
const { createStore } = await import('../../state/store.js');
const { VoiceProvider } = await import('../../context/voice.js');
const { DEFAULT_BINDINGS } = await import('../../keybindings/defaultBindings.js');
const { createUserMessage } = await import('../../utils/messages.js');

const UP = '\x1b[A';
const ENTER = '\r';

/** Minimal TTY-like stdin so Ink enables raw mode and delivers keystrokes. */
function createTtyStdin(): PassThrough {
  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  return stdin;
}

/** Resolves once the accumulated output contains `text` (event-driven, no timers). */
function waitForOutput(stdout: PassThrough, read: () => string, text: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const check = () => {
    if (!read().includes(text)) return;
    stdout.off('data', check);
    resolve();
  };
  stdout.on('data', check);
  check();
  return promise;
}

describe('MessageSelector digest mode', () => {
  const prevCheckpointing = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING;
  beforeEach(() => {
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1';
  });
  afterEach(() => {
    if (prevCheckpointing === undefined) delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING;
    else process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = prevCheckpointing;
  });

  test('with checkpoints disabled, selecting a message confirms instead of rewinding', async () => {
    const stdout = new PassThrough();
    const stdin = createTtyStdin();
    let output = '';
    stdout.on('data', chunk => {
      output += chunk.toString();
    });
    const restored: unknown[] = [];
    const preRestored: unknown[] = [];
    const bindings = parseBindings(DEFAULT_BINDINGS);

    const instance = await render(
      <AppStoreContext.Provider value={createStore(getDefaultAppState())}>
        <VoiceProvider>
          <KeybindingSetup loadBindings={() => ({ bindings, warnings: [] })} subscribeToChanges={() => () => {}}>
            <MessageSelector
              messages={[createUserMessage({ content: 'explore the flaky test' })]}
              mode="digest"
              onPreRestore={() => preRestored.push(true)}
              onRestoreMessage={async message => {
                restored.push(message);
              }}
              onRestoreCode={async () => {}}
              onSummarize={async () => {}}
              onClose={() => {}}
            />
          </KeybindingSetup>
        </VoiceProvider>
      </AppStoreContext.Provider>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
      },
    );
    try {
      await waitForOutput(stdout, () => output, 'explore the flaky test');
      // Initial focus is the virtual "(current)" row; move to the real message
      // and let the selection re-render before Enter reads it.
      stdin.write(UP);
      await waitForOutput(stdout, () => stripAnsi(output), `${figures.pointer} explore the flaky test`);
      stdin.write(ENTER);
      await waitForOutput(stdout, () => output, 'Distill from here into a digest');

      expect(restored).toEqual([]);
      expect(preRestored).toEqual([]);
      expect(output).toContain('Never mind');
      expect(output).not.toContain('Restore conversation');
      expect(output).not.toContain('Nothing to rewind');
    } finally {
      instance.unmount();
    }
  });
});
