import * as React from 'react';
import { useMemo } from 'react';
import { stringWidth, Text } from '@anthropic/ink';
import { getSdkBetas } from '../../bootstrap/state.js';
import { getAutoCompactThreshold, isProactiveAutoCompactActive } from '../../services/compact/autoCompact.js';
import type { Message } from '../../types/message.js';
import { getContextWindowForModel } from '../../utils/context.js';
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js';
import type { Theme } from '../../utils/theme.js';
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js';
import { CONTEXT_GAUGE_RULE, type ContextGaugeRunKind, layoutContextGauge } from './contextGauge.js';

const LEAD = '▶';

type Props = {
  messages: Message[];
  model: string;
  columns: number;
  /** Border color of the prompt box; a non-default mode/teammate color tints the used share. */
  borderColor: keyof Theme;
  /** Pre-rendered text pinned one cell from the right edge (e.g. the fast-mode icon). */
  trailingText?: string;
  /**
   * False while viewing a subagent/teammate: `messages`/`model` are the leader's,
   * so the gauge draws a plain rule instead of misreporting the viewed agent's context.
   */
  showUsage: boolean;
};

/**
 * Prompt box top border doubling as a context-window gauge:
 * `▶───3%──────────┃──────1M─` — fill = context used, `┃` = auto-compact trigger.
 */
export function ContextGaugeBorder({
  messages,
  model,
  columns,
  borderColor,
  trailingText,
  showUsage,
}: Props): React.ReactNode {
  const tokenUsage = useMemo(
    () => tokenCountFromLastAPIResponse(getMessagesAfterCompactBoundary(messages)),
    [messages],
  );
  const contextWindow = showUsage ? getContextWindowForModel(model, getSdkBetas()) : 0;
  const thresholdPercent =
    contextWindow > 0 && isProactiveAutoCompactActive() ? (getAutoCompactThreshold(model) / contextWindow) * 100 : null;

  const trailingWidth = trailingText ? stringWidth(trailingText) + 1 : 0;
  const runs = layoutContextGauge({
    width: Math.max(0, columns - LEAD.length - trailingWidth),
    // No API response yet: show the empty gauge without a misleading 0%.
    percent: tokenUsage > 0 && contextWindow > 0 ? (tokenUsage / contextWindow) * 100 : null,
    contextWindow,
    thresholdPercent,
  });

  const accent: keyof Theme = borderColor === 'promptBorder' ? 'claude' : borderColor;
  const colorFor: Record<ContextGaugeRunKind, { color: keyof Theme; dim: boolean }> = {
    used: { color: accent, dim: false },
    percent: { color: accent, dim: false },
    unused: { color: 'promptBorder', dim: true },
    threshold: { color: accent, dim: true },
    window: { color: accent, dim: true },
    overflow: { color: 'error', dim: false },
  };

  return (
    <Text wrap="truncate">
      <Text color={accent}>{LEAD}</Text>
      {runs.map((run, i) => (
        <Text key={i} color={colorFor[run.kind].color} dimColor={colorFor[run.kind].dim}>
          {run.text}
        </Text>
      ))}
      {trailingText ? (
        <>
          {trailingText}
          <Text color={borderColor}>{CONTEXT_GAUGE_RULE}</Text>
        </>
      ) : null}
    </Text>
  );
}
