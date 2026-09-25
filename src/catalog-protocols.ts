/**
 * Wire protocols a route without an installed source may speak.
 *
 * pi-ai ships one implementation per protocol under `api/`; importing them here
 * lets configuration declare a custom host that speaks exactly the protocol it
 * names, without the plugin curating which backends exist.
 */
import type { ProviderStreams } from '@earendil-works/pi-ai'
import * as anthropicMessages from '@earendil-works/pi-ai/api/anthropic-messages'
import * as azureOpenAIResponses from '@earendil-works/pi-ai/api/azure-openai-responses'
import * as googleGenerativeAI from '@earendil-works/pi-ai/api/google-generative-ai'
import * as mistralConversations from '@earendil-works/pi-ai/api/mistral-conversations'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses'

/** Protocol id (also the model's `api`) to the streams that implement it. */
export const PROTOCOL_STREAMS: Readonly<Record<string, ProviderStreams>> = Object.freeze({
  'anthropic-messages': anthropicMessages,
  'azure-openai-responses': azureOpenAIResponses,
  'google-generative-ai': googleGenerativeAI,
  'mistral-conversations': mistralConversations,
  'openai-completions': openaiCompletions,
  'openai-responses': openaiResponses,
})
