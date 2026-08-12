/**
 * Author(s): 1. Zainab Raza
 * Description: The customer support agent's tool layer - the single definition
 *              of everything the agent can actually do, shared by every
 *              surface it is exposed through.
 *
 *              Each tool is declared once here with a JSON Schema and a
 *              handler, and is then consumed in two different shapes:
 *                - as MCP tools by src/mcp/server.js, so any MCP client
 *                  (Claude Desktop, another agent, a partner integration) can
 *                  drive Steth support without going through our agent at all
 *                - as Claude tool definitions by supportAgent.service.js, which
 *                  is what WhatsApp / the website / Instagram talk to
 *              Defining them twice would let the two drift, and a support
 *              agent whose tools disagree with the MCP contract is worse than
 *              having no MCP server.
 *
 *              SECURITY - the central rule of this file:
 *              Every handler takes a `context` the caller supplies, never the
 *              model. A customer can only ever read or cancel their own
 *              orders, because the lookup is scoped by context.userId /
 *              context.email, not by an order ID the model chose. Treat any
 *              tool that widens that scope as a security change, not a
 *              feature.
 *
 *              Handlers return plain objects. They never touch req/res, so the
 *              same code serves HTTP, MCP stdio and a webhook unchanged.
 *
 * Date created: August 13th, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 13th, 2026
 * Run: Not directly runnable - imported by src/mcp/server.js and
 *      src/services/supportAgent.service.js
 */

const Product = require('../models/product.model');
const Order = require('../models/order.model');
const User = require('../models/user.model');
const orderController = require('../controllers/order.controller');
const { recommendSize } = require('../utils/sizeRecommendation');
const rewardsService = require('../services/rewards.service');

// Orders a customer may still cancel themselves. Anything further along has
// left the warehouse and needs a human - the agent says so rather than
// failing silently.
const CUSTOMER_CANCELLABLE = ['Pending', 'Confirmed'];

/**
 * Trims a product document down to what a support conversation needs. Sending
 * whole documents would bury the model in inventory rows and image metadata.
 * @param {Object} product - Product document (lean or hydrated).
 * @returns {Object} Compact product summary.
 */
const summariseProduct = (product) => ({
    id: String(product._id),
    name: product.name,
    price: product.price,
    discount: product.discount || 0,
    gender: product.gender,
    category: product.category,
    colors: (product.colors || []).map((colour) => colour.name).filter(Boolean),
    sizes: (product.sizes || []).filter((size) => size.isAvailable !== false).map((size) => size.name),
    averageRating: product.averageRating || 0
});

/**
 * Order summary shaped for a support reply - status, timeline and what was
 * actually bought, without payment internals the agent must never read aloud.
 * @param {Object} order - Order document.
 * @returns {Object} Compact order summary.
 */
const summariseOrder = (order) => ({
    orderId: order.orderId || String(order._id),
    status: order.orderStatus,
    placedOn: order.createdAt,
    total: order.total,
    items: (order.items || []).map((item) => ({
        product: item.productName,
        colour: item.color,
        size: item.size,
        quantity: item.quantity
    })),
    trackingNumber: order.trackingNumber || null,
    estimatedDelivery: order.estimatedDelivery || null,
    cancellable: CUSTOMER_CANCELLABLE.includes(order.orderStatus)
});

/**
 * Finds an order that belongs to this customer, and only this customer.
 *
 * Accepts the human-facing order reference the customer would read off an
 * email. The owning filter is applied in the query itself rather than checked
 * afterwards, so a wrong or guessed reference reads as "not found" and never
 * leaks another customer's order.
 *
 * @param {String} reference - orderId or raw _id.
 * @param {Object} context - { userId, email }.
 * @returns {Promise<Object|null>} The order, or null.
 */
const findOwnedOrder = async (reference, context) => {
    const owner = [];
    if (context.userId) owner.push({ user: context.userId });
    if (context.email) owner.push({ customerEmail: String(context.email).toLowerCase() });
    if (!owner.length) return null;

    const reference_ = String(reference || '').trim();
    const byReference = [{ orderId: reference_ }];
    // Only try the raw _id form when it could actually be one.
    if (/^[a-f\d]{24}$/i.test(reference_)) byReference.push({ _id: reference_ });

    return Order.findOne({ $and: [{ $or: owner }, { $or: byReference }] });
};

/**
 * The tool catalogue. `inputSchema` is JSON Schema so it can be handed to MCP
 * and to the Claude Messages API without translation.
 */
const SUPPORT_TOOLS = [
    {
        name: 'search_products',
        description:
            'Search the Steth catalogue by free text, gender or category. Call this when the customer asks what is available, mentions a product by name, or asks about price. Returns matching products with their colours, sizes and price.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Free text to match against product name and description.' },
                gender: { type: 'string', description: 'Filter by gender, e.g. "Women" or "Men".' },
                limit: { type: 'integer', description: 'Maximum products to return. Defaults to 5, capped at 20.' }
            }
        },
        handler: async (input) => {
            const filter = {};
            if (input.query) {
                filter.$or = [
                    { name: { $regex: input.query, $options: 'i' } },
                    { description: { $regex: input.query, $options: 'i' } }
                ];
            }
            if (input.gender) filter.gender = { $regex: `^${input.gender}$`, $options: 'i' };

            const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 20);
            const products = await Product.find(filter).limit(limit).lean();

            return { count: products.length, products: products.map(summariseProduct) };
        }
    },

    {
        name: 'check_stock',
        description:
            'Check whether a specific product is in stock in a given colour and size. Call this before telling a customer that something is available, and before taking an order for it.',
        inputSchema: {
            type: 'object',
            properties: {
                productId: { type: 'string', description: 'The product id from search_products.' },
                colour: { type: 'string', description: 'Colour name exactly as returned by search_products.' },
                size: { type: 'string', description: 'Size letter: S, M, L or XL.' }
            },
            required: ['productId', 'colour', 'size']
        },
        handler: async (input) => {
            const product = await Product.findById(input.productId);
            if (!product) return { found: false, message: 'No product with that id.' };

            const row = (product.inventory || []).find(
                (entry) => entry.color === input.colour && entry.size === input.size
            );

            return {
                found: true,
                product: product.name,
                colour: input.colour,
                size: input.size,
                inStock: Boolean(row && row.stock > 0),
                // Exact counts are deliberately not returned - the agent should
                // say "in stock", not quote warehouse numbers to a customer.
                availability: row && row.stock > 0 ? 'in stock' : 'out of stock'
            };
        }
    },

    {
        name: 'get_my_orders',
        description:
            "List the customer's own recent orders with their status. Call this when they ask about an order without giving a reference, or ask what they have bought.",
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', description: 'How many recent orders to return. Defaults to 5.' }
            }
        },
        handler: async (input, context) => {
            if (!context.userId && !context.email) {
                return { identified: false, message: 'This customer is not identified yet.' };
            }

            const owner = [];
            if (context.userId) owner.push({ user: context.userId });
            if (context.email) owner.push({ customerEmail: String(context.email).toLowerCase() });

            const orders = await Order.find({ $or: owner })
                .sort({ createdAt: -1 })
                .limit(Math.min(Math.max(Number(input.limit) || 5, 1), 20));

            return { identified: true, count: orders.length, orders: orders.map(summariseOrder) };
        }
    },

    {
        name: 'get_order_status',
        description:
            'Look up one of the customer\'s own orders by its reference and return its current status, tracking number and delivery estimate.',
        inputSchema: {
            type: 'object',
            properties: {
                orderReference: { type: 'string', description: 'The order reference the customer quoted.' }
            },
            required: ['orderReference']
        },
        handler: async (input, context) => {
            const order = await findOwnedOrder(input.orderReference, context);
            if (!order) {
                return { found: false, message: 'No order with that reference on this account.' };
            }
            return { found: true, order: summariseOrder(order) };
        }
    },

    {
        name: 'cancel_order',
        description:
            "Cancel one of the customer's own orders. Only works while the order is still Pending or Confirmed. Always confirm with the customer before calling this - it cannot be undone.",
        inputSchema: {
            type: 'object',
            properties: {
                orderReference: { type: 'string', description: 'The order reference to cancel.' },
                reason: { type: 'string', description: "The customer's stated reason, if they gave one." }
            },
            required: ['orderReference']
        },
        handler: async (input, context) => {
            const order = await findOwnedOrder(input.orderReference, context);
            if (!order) {
                return { cancelled: false, message: 'No order with that reference on this account.' };
            }
            if (!CUSTOMER_CANCELLABLE.includes(order.orderStatus)) {
                return {
                    cancelled: false,
                    message: `This order is already ${order.orderStatus} and can no longer be cancelled here. A human agent can still help.`
                };
            }

            // Reuses the HTTP route's own helper, so stock restoration, reward
            // point refunds and cache invalidation all happen exactly as they
            // do for a customer cancelling on the website.
            const result = await orderController.cancelSingleOrder(String(order._id), {
                _id: context.userId,
                role: 'customer'
            });

            return result.success
                ? { cancelled: true, orderId: summariseOrder(order).orderId, message: 'The order has been cancelled.' }
                : { cancelled: false, message: result.message || 'That order could not be cancelled.' };
        }
    },

    {
        name: 'recommend_size',
        description:
            'Recommend a scrub size from the customer\'s measurements. Call this whenever they ask what size to buy. Chest and waist give the best answer, but height and weight alone also work.',
        inputSchema: {
            type: 'object',
            properties: {
                chest: { type: 'number', description: 'Chest measurement in inches.' },
                waist: { type: 'number', description: 'Waist measurement in inches.' },
                hip: { type: 'number', description: 'Hip measurement in inches.' },
                heightInches: { type: 'number', description: 'Height in inches.' },
                weightKg: { type: 'number', description: 'Weight in kilograms.' },
                fitPreference: { type: 'string', description: '"regular" or "loose".' }
            }
        },
        handler: async (input) => {
            try {
                // Same engine the website's size quiz uses, so the agent and the
                // storefront can never recommend different sizes.
                return { sized: true, ...recommendSize(input) };
            } catch (error) {
                return { sized: false, message: error.message };
            }
        }
    },

    {
        name: 'get_reward_points',
        description:
            "Report the customer's own loyalty points balance and what it is worth. Call this when they ask about points, rewards or discounts they have earned.",
        inputSchema: { type: 'object', properties: {} },
        handler: async (_input, context) => {
            if (!context.userId) {
                return { identified: false, message: 'This customer is not signed in, so their points cannot be read.' };
            }
            const summary = await rewardsService.getRewardsSummary(context.userId, { historyLimit: 5 });
            return {
                identified: true,
                balance: summary.balance,
                worthPkr: summary.balanceValuePkr,
                expiresOn: summary.nextExpiryDate,
                waysToEarnStillOpen: summary.rules.filter((rule) => rule.available).map((rule) => rule.label)
            };
        }
    },

    {
        name: 'prepare_order',
        description:
            'Prepare an order the customer has described, and get back a checkout link for them to confirm and pay. Call this once you know the product, colour, size and quantity for everything they want. Always read the summary back to them before sending the link.',
        inputSchema: {
            type: 'object',
            properties: {
                items: {
                    type: 'array',
                    description: 'Everything the customer wants to buy.',
                    items: {
                        type: 'object',
                        properties: {
                            productId: { type: 'string', description: 'Product id from search_products.' },
                            colour: { type: 'string', description: 'Colour name.' },
                            size: { type: 'string', description: 'Size letter: S, M, L or XL.' },
                            quantity: { type: 'integer', description: 'How many. Defaults to 1.' }
                        },
                        required: ['productId', 'colour', 'size']
                    }
                }
            },
            required: ['items']
        },
        handler: async (input, context) => {
            const requested = Array.isArray(input.items) ? input.items : [];
            if (!requested.length) return { prepared: false, message: 'No items were given.' };

            const lines = [];
            const problems = [];

            // Price and stock are resolved server-side from the catalogue. The
            // model never supplies a price - if it could, a customer could talk
            // the agent into a discount that checkout would then honour.
            for (const item of requested) {
                const product = await Product.findById(item.productId);
                if (!product) {
                    problems.push(`No product with id ${item.productId}.`);
                    continue;
                }

                const quantity = Math.max(Number(item.quantity) || 1, 1);
                const row = (product.inventory || []).find(
                    (entry) => entry.color === item.colour && entry.size === item.size
                );

                if (!row || row.stock < quantity) {
                    problems.push(`${product.name} in ${item.colour}/${item.size} is not available in that quantity.`);
                    continue;
                }

                const unitPrice = product.discount
                    ? Math.round(product.price - (product.price * product.discount) / 100)
                    : product.price;

                lines.push({
                    productId: String(product._id),
                    product: product.name,
                    colour: item.colour,
                    size: item.size,
                    quantity,
                    unitPrice,
                    lineTotal: unitPrice * quantity
                });
            }

            if (!lines.length) {
                return { prepared: false, problems, message: 'Nothing on this order is available.' };
            }

            const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);

            // Deliberately a checkout hand-off, not a direct write. Placing the
            // order itself runs discounts, gift cards, reward points, stock
            // decrements and the confirmation email (order.controller.js
            // createOrder); reproducing that here would drift from checkout and
            // eventually take a customer's money on the wrong terms. The agent
            // does the hard part - working out what they want and proving it is
            // in stock at a real price - and the existing, tested checkout
            // takes the payment.
            const base = process.env.FRONTEND_URL || 'http://localhost:3000';
            const draft = lines.map((l) => `${l.productId}:${l.colour}:${l.size}:${l.quantity}`).join(',');
            const checkoutUrl = `${base}/cart?draft=${encodeURIComponent(draft)}`;

            return {
                prepared: true,
                items: lines,
                subtotal,
                currency: 'PKR',
                // Named so the model reads it back rather than treating the
                // order as already placed.
                note: 'This is a draft. The order is only placed once the customer completes checkout.',
                problems: problems.length ? problems : undefined,
                checkoutUrl,
                identified: Boolean(context.userId)
            };
        }
    },

    {
        name: 'escalate_to_human',
        description:
            'Hand the conversation to a human agent. Call this when the customer asks for a person, is distressed, raises a payment or refund dispute, or asks for something no other tool covers. Say that you are handing over before calling it.',
        inputSchema: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'Why this needs a human, in one sentence.' },
                summary: { type: 'string', description: 'What the customer wants, so the human does not re-ask.' }
            },
            required: ['reason']
        },
        handler: async (input, context) => {
            // Deliberately just a durable record. Wiring this to a helpdesk
            // (email, Slack, Zendesk) is a follow-up, and the agent must be able
            // to hand over correctly before that exists.
            console.warn('[support-agent] escalation', {
                channel: context.channel,
                userId: context.userId || null,
                email: context.email || null,
                reason: input.reason
            });
            return {
                escalated: true,
                // Worded carefully: this records the handover, it does not
                // page anyone. Saying "notified" made the agent promise
                // callbacks "within the hour" in testing - a commitment
                // nothing in this system can keep. Until a helpdesk is wired
                // up, the tool must not imply one exists.
                message:
                    'The conversation has been flagged for a human agent. Do not promise the customer a callback time.'
            };
        }
    }
];

/**
 * Looks a tool up by name.
 * @param {String} name - Tool name.
 * @returns {Object|undefined} The tool definition.
 */
const getTool = (name) => SUPPORT_TOOLS.find((tool) => tool.name === name);

/**
 * Runs a tool by name with the caller-supplied context.
 *
 * Errors are returned rather than thrown: a tool failure should become a
 * result the model can read and recover from ("that didn't work, ask for the
 * order number again"), not a crash that drops the customer's conversation.
 *
 * @param {String} name - Tool name.
 * @param {Object} input - Model-supplied arguments.
 * @param {Object} context - Caller-supplied identity. Never model-supplied.
 * @returns {Promise<Object>} The tool result, or { error }.
 */
const runTool = async (name, input = {}, context = {}) => {
    const tool = getTool(name);
    if (!tool) return { error: `Unknown tool: ${name}` };

    try {
        return await tool.handler(input, context);
    } catch (error) {
        console.error(`[support-agent] tool ${name} failed:`, error.message);
        return { error: `The ${name} tool failed: ${error.message}` };
    }
};

/**
 * The catalogue in Claude Messages API shape (`input_schema`).
 * @returns {Array<Object>} Tool definitions for the Anthropic SDK.
 */
const toClaudeTools = () =>
    SUPPORT_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
    }));

/**
 * The catalogue in MCP shape (`inputSchema`).
 * @returns {Array<Object>} Tool definitions for the MCP server.
 */
const toMcpTools = () =>
    SUPPORT_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
    }));

module.exports = {
    SUPPORT_TOOLS,
    CUSTOMER_CANCELLABLE,
    getTool,
    runTool,
    toClaudeTools,
    toMcpTools,
    summariseOrder,
    summariseProduct
};
