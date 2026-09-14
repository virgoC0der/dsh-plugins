/**
 * The vision bridge: let a text-only model learn what a screenshot shows.
 *
 * Native image input is the primary path — when the route serving a call
 * declares `image`, the screenshot is attached and the model sees the real
 * pixels. The bridge exists for the other case: a route that cannot take
 * images still gets a description, produced by a separate vision-capable model
 * through the same `llm` service the agent itself uses.
 *
 * This costs a second model call, so it is opt-in (`vision.enabled`) and off by
 * default. The description is deliberately returned as text on the tool result
 * rather than injected as context, so it stays with the screenshot it describes.
 *
 * @module dsh-browser/lib/vision
 */

/** The bridge's own instruction. Kept narrow: the agent should get facts, not prose. */
const PROMPT = [
  'Describe this web page screenshot for a software agent that cannot see images.',
  'Report, in at most 120 words and as terse lines:',
  '- what the page appears to be, and its main heading text;',
  '- any error, warning, or empty-state text that is visible;',
  '- the visible interactive controls, with their labels;',
  '- anything that looks broken, overlapping, unstyled, or cut off.',
  'Do not speculate about content that is not visible.',
].join('\n')

/**
 * Create a describer bound to one plugin instance.
 *
 * @param {object} deps - `ctx` (the plugin context) and `log`.
 * @returns {(exec: object, attachment: object, config: object) => Promise<string|null>} the describer.
 */
export function createDescriber({ ctx, log }) {
  /**
   * Describe one screenshot with the configured vision model.
   *
   * @param {object} exec - the tool execution context, for cancellation.
   * @param {object} attachment - a durable `ImageAttachmentRef`.
   * @param {object} config - the resolved plugin configuration.
   * @returns {Promise<string|null>} the description, or null when unavailable.
   */
  async function describe(exec, attachment, config) {
    const vision = config.vision
    if (vision.enabled !== true) return null
    if (vision.provider === '' || vision.model === '') {
      log('vision bridge is enabled but vision.provider / vision.model are not set')
      return null
    }
    const llm = ctx.get('llm')
    if (llm === undefined) {
      log('vision bridge needs the llm service, which is not composed')
      return null
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), vision.timeoutMs)
    // A tool call may already carry a cancellation signal; fuse the two so
    // abandoning the call also abandons the description request.
    const signal = exec?.signal === undefined
      ? controller.signal
      : AbortSignal.any([exec.signal, controller.signal])

    try {
      const stream = llm.stream({
        provider: vision.provider,
        model: vision.model,
        system: 'You describe screenshots precisely and briefly.',
        maxTokens: vision.maxTokens ?? 400,
        signal,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image', attachment },
            ],
          },
        ],
      })
      let description = ''
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') description += chunk.text
      }
      const trimmed = description.trim()
      if (trimmed === '') {
        log('the vision model returned no text')
        return null
      }
      return trimmed
    } catch (error) {
      // The bridge is best-effort: the tool already has a textual report, so a
      // failure here must never fail the call.
      log(`vision bridge failed: ${error.message}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return describe
}
