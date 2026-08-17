/**
 * Author(s): 1. Zainab Raza
 * Description: The customer support agent - the loop that turns a customer
 *              message into a reply, calling Steth's tools as needed.
 *
 *              Channel-agnostic by design. WhatsApp, the website widget and
 *              Instagram all call `handleMessage` with the same shape; the
 *              only thing that differs between them is the transport that
 *              wraps it. That is why nothing here knows what WhatsApp is.
 *
 *              The loop is deliberately hand-written rather than using an SDK
 *              tool runner: the runner helpers are provider-specific, and this
 *              agent has to run on either Mistral or Claude (see
 *              llmProvider.js). The loop is small enough that owning it costs
 *              less than abstracting over two runners.
 *
 *              Identity is passed in, never inferred by the model - see the
 *              security note in src/mcp/supportTools.js. The agent can only
 *              ever act on the customer the caller says it is talking to.
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - imported by src/controllers/supportAgent.controller.js
 */

const { runTool, toMcpTools } = require('../mcp/supportTools');
const { runTurn, buildToolResultMessages, getProviderConfig } = require('./llmProvider');

// A tool round trip is one model call plus the tool executions. Without a cap
// a confused model can loop forever on a customer's money and our tokens; five
// is comfortably more than any supported flow needs (search -> check stock ->
// answer is three).
const MAX_TOOL_ROUNDS = 5;

// Kept short and behavioural. Long prompts full of "CRITICAL: YOU MUST" make
// current models over-trigger tools; this states what the agent is, the few
// rules that actually matter, and what to do when it cannot help.
const SYSTEM_PROMPT = `You are the customer support agent for Steth, a Pakistani medical scrubs brand.

You help customers find products, check sizes, place and track orders, cancel orders, and answer questions about their reward points.

How to work:
- Use the tools to look things up. Never guess an order status, a price, a stock level or a points balance - if a tool can answer it, call the tool.
- Only ever name a product, a price or a size that came back from a tool in this conversation. Never invent one, never recall one from memory, and never fill a gap with a plausible-sounding product. If search_products returns nothing, say we do not stock it and offer to check something else - an empty result is an answer, not a prompt to improvise.
- Look a product up before you try to order it. prepare_order and place_order need a real product id from search_products; do not construct one.
- Prices are in PKR.
- Before cancelling an order, confirm with the customer in your reply and only call cancel_order once they have clearly agreed. Cancelling cannot be undone.
- A customer messaging from WhatsApp or Instagram can order and track orders without any Steth account. They will have no saved address, so ask for their name, street address, city and a contact phone number for the courier, save it with save_delivery_address, read it back, and then place the order. On WhatsApp the phone number is already known, so do not ask for it again. They have no reward points, so do not offer them.
- When a signed-in customer is about to order, check their points with get_reward_points, tell them the balance, and ask how many they want to put toward this order. 1 point = 1 PKR off. Pass exactly the number they give to place_order, or 0 if they would rather save them. Never pick a number for them, and never spend points they did not agree to spend.
- If a customer asks about an order you cannot find, ask them to check the reference rather than speculating about what happened to it.
- If someone asks for a human, raises a payment dispute, or wants something no tool covers, tell them you are handing over and call escalate_to_human.
- Never tell a customer that a colleague, a person or a human will get back to them unless you call escalate_to_human in the same turn. Saying it without calling it means nobody is ever told, and the customer waits for a reply that will never come. The words and the tool call always go together.
- When you do hand over: if they are upset, apologise for the problem first - "I am sorry that happened" - then say a colleague will get back to them shortly. Never give a specific time, never promise a phone call, and never guess the outcome.
- Never promise anything else you cannot verify either: no delivery dates a tool did not give you, and no refund or replacement outcomes. Those are the human's decision, not yours.

Payment:
- You can only take cash on delivery. If the customer wants to pay by card, bank transfer or any online method, tell them a colleague will take over to arrange it, and call escalate_to_human. Do not try to collect card or bank details yourself, and never ask for them.

How to write:
- Short, warm and direct. These are usually WhatsApp messages, not emails.
- Answer the question first, then add detail only if it helps.
- Never mention tools, internal ids, or that you are an AI model unless asked directly.
- Keep it plain. A couple of short sentences beats a formatted document: no headings, no tables, and at most a few "- " bullets when you are genuinely listing things. Use **bold** sparingly, for a size, a total or an order number - not for whole sentences.
- Write links as [Check out](https://...) and nothing else on that line, so they stay tappable on a phone.`;

/**
 * Runs the agent over one customer message.
 *
 * @param {Object} params
 * @param {String} params.message - What the customer just said.
 * @param {Array} [params.history] - Prior provider-format messages.
 * @param {Object} params.context - { userId, email, channel }. Caller-supplied.
 * @returns {Promise<Object>} { reply, history, toolsUsed, escalated, rounds }
 */
const handleMessage = async ({ message, history = [], context = {} }) => {
    const tools = toMcpTools();
    const messages = [...history, { role: 'user', content: message }];

    const toolsUsed = [];
    let escalated = false;
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
        rounds += 1;

        const turn = await runTurn({ system: SYSTEM_PROMPT, messages, tools });

        // No tool calls means the model is answering, so the turn is done.
        if (!turn.toolCalls.length) {
            messages.push({ role: 'assistant', content: turn.text });
            return { reply: turn.text, history: messages, toolsUsed, escalated, rounds };
        }

        // Run every requested tool before replying. Results must all go back in
        // one round - returning them piecemeal teaches the model to stop
        // requesting tools in parallel.
        const results = [];
        for (const call of turn.toolCalls) {
            const result = await runTool(call.name, call.input, context);
            toolsUsed.push(call.name);
            if (call.name === 'escalate_to_human') escalated = true;
            results.push({ id: call.id, name: call.name, result });
        }

        messages.push(...buildToolResultMessages(turn, results));
    }

    // Ran out of rounds. Better to hand over than to keep spending on a loop
    // the customer is waiting through.
    const fallback =
        'Sorry - I am having trouble getting you an answer on that one. Let me pass you to a human agent.';
    await runTool('escalate_to_human', { reason: 'Agent exceeded its tool round limit.' }, context);
    messages.push({ role: 'assistant', content: fallback });

    return { reply: fallback, history: messages, toolsUsed, escalated: true, rounds };
};

/**
 * Whether the agent can run at all, for health checks and startup logging.
 * @returns {Object} { ready, provider, model, missing }
 */
const getAgentStatus = () => {
    const { provider, model, configured, missing } = getProviderConfig();
    return { ready: configured, provider, model, missing };
};

module.exports = {
    SYSTEM_PROMPT,
    MAX_TOOL_ROUNDS,
    handleMessage,
    getAgentStatus
};
