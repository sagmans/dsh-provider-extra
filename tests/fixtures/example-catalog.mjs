/** Synthetic membership keeps personal operator selections outside repository fixtures. */
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

export const SOURCES = ['openai', 'openai-codex', 'opencode-go', 'qwen-token-plan', 'xai']
export const REQUEST_DEFAULT = 4096
export const REQUEST_OVERRIDE = 2048
export const DEFAULT_EFFORT = 'max'
export const GO_ALIAS = 'example-go-alias'

export function exampleConfig() {
  const providers = SOURCES.map((source, index) => {
    const installed = builtinProviders().find(provider => provider.id === source).getModels()
    const template = installed.find(model => model.api === 'openai-completions') ?? installed[0]
    const metadata = { reasoning: true, thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', max: 'high' }, maxTokens: 8192 }
    return {
      id: 'example-route-' + index, name: 'Example route ' + index, source,
      auth: source === 'openai-codex' ? { credentialProvider: source } : { apiKeyRef: 'EXAMPLE_KEY_' + index },
      ...source === 'openai-codex' ? { transport: 'sse' } : {},
      models: [{ id: 'example-model-' + index, name: 'Example model ' + index, template: template.id, metadata,
        ...source === 'qwen-token-plan' ? { defaultMaxTokens: REQUEST_DEFAULT } : {},
        ...source === 'opencode-go' ? { aliases: [GO_ALIAS] } : {},
      }],
    }
  })
  return { catalog: { version: 1, providers, default: { provider: providers[2].id, model: providers[2].models[0].id, reasoningEffort: DEFAULT_EFFORT } } }
}
