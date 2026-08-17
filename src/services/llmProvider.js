/**
 * Author(s): 1. Zainab Raza
 * Description: Provider adapter for the customer support agent. Presents one
 *              small interface - "here is a conversation and a tool list, give
 *              me back either a reply or tool calls" - so the agent loop never
 *              contains provider-specific code.
 *
 *              Two providers are implemented:
 *                mistral   - OpenAI-shaped chat completions. Selected today
 *                            because it is the key we have for testing.
 *                anthropic - Claude Messages API, the intended production
 *                            provider.
 *
 *              Why an adapter rather than committing to one: the two APIs
 *              disagree on almost every detail of tool use - Mistral nests
 *              schemas under `function.parameters` and returns tool calls with
 *              JSON-encoded string arguments, Claude uses `input_schema` and
 *              returns parsed objects in `tool_use` blocks. Without this file
 *              those differences leak into the agent loop and swapping
 *              provider means rewriting it. Choose with LLM_PROVIDER.
 *
 *              The normalised turn this returns is:
 *                { text, toolCalls: [{ id, name, input }], raw }
 *              and history is kept in the provider's own message format,
 *              because both need their own message shapes echoed back.
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - imported by src/services/supportAgent.service.js
 */

const DEFAULT_PROVIDER = 'mistral';

// Kept here rather than inline so switching model is a config change. The
// Mistral default is a tool-calling-capable model; the smaller ones are
// noticeably worse at deciding when to call a tool.
const DEFAULT_MODELS = {
    mistral: 'mistral-medium-2508',
    anthropic: 'claude-opus-5'
};

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

/**
 * Which provider is configured, and whether it can actually run.
 * @returns {Object} { provider, model, configured, missing }
 */
const getProviderConfig = () => {
    const provider = (process.env.LLM_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
    const model =
        process.env.LLM_MODEL || DEFAULT_MODELS[provider] || DEFAULT_MODELS[DEFAULT_PROVIDER];

    const keyVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'MISTRAL_API_KEY';
    const configured = Boolean(process.env[keyVar]);

    return { provider, model, configured, missing: configured ? null : keyVar };
};

/**
 * One turn against Mistral's chat completions API.
 *
 * @param {Object} params
 * @param {String} params.model - Model id.
 * @param {String} params.system - System prompt.
 * @param {Array} params.messages - Provider-format history.
 * @param {Array} params.tools - Tool catalogue in neutral form.
 * @returns {Promise<Object>} Normalised turn.
 */
const runMistralTurn = async ({ model, system, messages, tools }) => {
    const response = await fetch(MISTRAL_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: system }, ...messages],
            tools: tools.map((tool) => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema
                }
            })),
            tool_choice: 'auto'
        })
    });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Mistral request failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const body = await response.json();
    const message = body.choices[0].message;

    return {
        text: message.content || '',
        // Mistral returns arguments as a JSON *string*. Parsing failures are
        // treated as an empty input rather than throwing - the tool layer
        // validates its own inputs and will report the problem back to the
        // model far more usefully than a crashed request would.
        toolCalls: (message.tool_calls || []).map((call) => {
            let input = {};
            try {
                input = JSON.parse(call.function.arguments || '{}');
            } catch {
                input = {};
            }
            return { id: call.id, name: call.function.name, input };
        }),
        raw: message
    };
};

/**
 * One turn against the Claude Messages API.
 *
 * Uses adaptive thinking, which is the current recommendation and is on by
 * default for Opus 5 - it is set explicitly so the behaviour does not change
 * if the configured model does.
 *
 * @param {Object} params - Same shape as runMistralTurn.
 * @returns {Promise<Object>} Normalised turn.
 */
const runAnthropicTurn = async ({ model, system, messages, tools }) => {
    // Required lazily so the SDK is only loaded when this provider is used.
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system,
        thinking: { type: 'adaptive' },
        tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema
        })),
        messages
    });

    const textBlocks = response.content.filter((block) => block.type === 'text');
    const toolBlocks = response.content.filter((block) => block.type === 'tool_use');

    return {
        text: textBlocks.map((block) => block.text).join('\n'),
        // Already parsed objects here, unlike Mistral's JSON strings.
        toolCalls: toolBlocks.map((block) => ({ id: block.id, name: block.name, input: block.input })),
        raw: response.content
    };
};

/**
 * Runs one model turn against whichever provider is configured.
 * @param {Object} params - { system, messages, tools }.
 * @returns {Promise<Object>} { text, toolCalls, raw }.
 * @throws {Error} If the provider is unknown or its API key is missing.
 */
const runTurn = async ({ system, messages, tools }) => {
    const { provider, model, configured, missing } = getProviderConfig();

    if (!configured) {
        throw new Error(`${missing} is not set, so the support agent cannot run.`);
    }

    if (provider === 'anthropic') return runAnthropicTurn({ model, system, messages, tools });
    if (provider === 'mistral') return runMistralTurn({ model, system, messages, tools });

    throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
};

/**
 * Builds the assistant + tool-result messages to append to history after a
 * tool round. The two providers disagree on this shape, so it lives here
 * rather than in the agent loop.
 *
 * @param {Object} turn - The turn returned by runTurn.
 * @param {Array} results - [{ id, name, result }] in the same order.
 * @returns {Array<Object>} Messages to append to history.
 */
const buildToolResultMessages = (turn, results) => {
    const { provider } = getProviderConfig();

    if (provider === 'anthropic') {
        return [
            { role: 'assistant', content: turn.raw },
            {
                role: 'user',
                content: results.map((entry) => ({
                    type: 'tool_result',
                    tool_use_id: entry.id,
                    content: JSON.stringify(entry.result)
                }))
            }
        ];
    }

    // Mistral: the assistant turn is echoed back as-is, then one `tool`
    // message per call, each keyed by tool_call_id.
    return [
        turn.raw,
        ...results.map((entry) => ({
            role: 'tool',
            name: entry.name,
            tool_call_id: entry.id,
            content: JSON.stringify(entry.result)
        }))
    ];
};

module.exports = {
    DEFAULT_MODELS,
    getProviderConfig,
    runTurn,
    buildToolResultMessages
};
