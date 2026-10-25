import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../tests/mocks/log'
import { debugMock } from '../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  logEventAsync: async () => {},
  stripProtoFields: <V>(v: V) => v,
  attachAnalyticsSink: () => {},
  _resetForTesting: () => {},
}))

const DEPRECATED_MSG = '`temperature` is deprecated for this model.'

let createCalls: Array<Record<string, unknown>> = []
let createImpl: (params: Record<string, unknown>) => Promise<unknown>

const okResponse = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 1, output_tokens: 1 },
}

// MACRO is a compile-time define; the attribution header reads MACRO.VERSION.
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

mock.module('src/services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  getAnthropicClient: async () => ({
    beta: {
      messages: {
        create: (params: Record<string, unknown>) => {
          createCalls.push(params)
          return createImpl(params)
        },
      },
    },
  }),
}))

// Dynamic import: must load after mock.module() registers the client mock.
const { sideQuery, isTemperatureDeprecatedError } = await import(
  '../sideQuery.js'
)

const PROVIDER_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_API_KEY',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of PROVIDER_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // getAPIMetadata → getAnthropicApiKeyWithSource throws in test env
  // without a key; the client itself is mocked.
  process.env.ANTHROPIC_API_KEY = 'test-key'
  createCalls = []
})

afterEach(() => {
  for (const key of PROVIDER_ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function query(model: string) {
  return sideQuery({
    querySource: 'model_validation',
    model,
    temperature: 0,
    messages: [{ role: 'user', content: 'Hi' }],
  })
}

describe('isTemperatureDeprecatedError', () => {
  test('matches the real Anthropic deprecation message', () => {
    expect(isTemperatureDeprecatedError(new Error(DEPRECATED_MSG))).toBe(true)
  })

  test('does not match the thinking-mode temperature constraint', () => {
    expect(
      isTemperatureDeprecatedError(
        new Error('temperature may only be set to 1 when thinking is enabled'),
      ),
    ).toBe(false)
  })

  test('does not match unrelated deprecation errors', () => {
    expect(isTemperatureDeprecatedError(new Error('top_k is deprecated'))).toBe(
      false,
    )
  })
})

describe('sideQuery temperature retry', () => {
  test('retries once without temperature and caches per model', async () => {
    createImpl = async params => {
      if ('temperature' in params) throw new Error(DEPRECATED_MSG)
      return okResponse
    }

    await query('test-model-deprecated')
    expect(createCalls).toHaveLength(2)
    expect(createCalls[0]).toHaveProperty('temperature', 0)
    expect(createCalls[1]).not.toHaveProperty('temperature')

    // Same model: cached, temperature skipped up-front, single request.
    createCalls = []
    await query('test-model-deprecated')
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).not.toHaveProperty('temperature')

    // Different model: cache is per-model, temperature still sent.
    createCalls = []
    createImpl = async () => okResponse
    await query('test-model-other')
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).toHaveProperty('temperature', 0)
  })

  test('does not retry on unrelated temperature errors', async () => {
    createImpl = async () => {
      throw new Error(
        'temperature may only be set to 1 when thinking is enabled',
      )
    }
    await expect(query('test-model-thinking')).rejects.toThrow(
      'temperature may only be set to 1',
    )
    expect(createCalls).toHaveLength(1)
  })

  test('propagates the retry error without retrying again', async () => {
    let n = 0
    createImpl = async () => {
      n++
      throw new Error(n === 1 ? DEPRECATED_MSG : 'overloaded')
    }
    await expect(query('test-model-retry-fails')).rejects.toThrow('overloaded')
    expect(createCalls).toHaveLength(2)
  })
})
