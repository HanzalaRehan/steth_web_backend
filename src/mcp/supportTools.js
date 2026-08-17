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
const ChannelIdentity = require('../models/channelIdentity.model');
const orderController = require('../controllers/order.controller');
const { recommendSize } = require('../utils/sizeRecommendation');
const rewardsService = require('../services/rewards.service');
const { bumpCacheVersion } = require('../utils/cache');

// Agent-placed orders deduct stock, so cached product listings and detail
// pages have to reflect it - same version-namespace bump checkout uses, so
// both paths invalidate identically.
// Best-effort, and deliberately time-boxed. ioredis is configured to retry a
// command forever (maxRetriesPerRequest: null, required by BullMQ), so if Redis
// is down this call never settles - which would hang place_order *after* the
// order was already written and stock deducted, leaving the customer with no
// confirmation for an order that exists. A stale cache for a few minutes is a
// far smaller problem than that.
const CACHE_INVALIDATION_TIMEOUT_MS = 2000;

const invalidateProductCaches = async () => {
    try {
        await Promise.race([
            bumpCacheVersion('products'),
            new Promise((resolve) => setTimeout(resolve, CACHE_INVALIDATION_TIMEOUT_MS))
        ]);
    } catch (error) {
        console.error('[support-agent] product cache invalidation failed:', error.message);
    }
};

/**
 * Matches what a customer called a colour or size against what the product
 * actually stocks.
 *
 * Exact string comparison is wrong here: a customer asks for "navy blue" and
 * the catalogue says "Navy", so the row is never found and the agent tells
 * them an in-stock item is sold out. Matching is case-insensitive, ignores
 * surrounding whitespace, and accepts either string containing the other, so
 * "navy blue", "NAVY" and " navy " all reach "Navy".
 *
 * @param {String} wanted - What the customer said.
 * @param {Array<String>} options - What the product actually has.
 * @returns {String|null} The catalogue's own spelling, or null if no match.
 */
const matchOption = (wanted, options) => {
    const norm = (value) => String(value || '').trim().toLowerCase();
    const target = norm(wanted);
    if (!target) return null;

    const exact = options.find((option) => norm(option) === target);
    if (exact) return exact;

    // Size words spelled out. Handled explicitly because sizes are single
    // letters, and "small" happens to contain both "s" and "l" - substring
    // matching would resolve it to whichever of S or L the product listed
    // first.
    const SIZE_WORDS = {
        small: 's', medium: 'm', large: 'l',
        'extra large': 'xl', 'extra-large': 'xl', xlarge: 'xl', 'x large': 'xl'
    };
    if (SIZE_WORDS[target]) {
        const bySizeWord = options.find((option) => norm(option) === SIZE_WORDS[target]);
        if (bySizeWord) return bySizeWord;
    }

    // "navy blue" -> "Navy". Skipped for one-character options, where
    // containment is meaningless and dangerous.
    const contained = options.find((option) => {
        const candidate = norm(option);
        if (candidate.length < 2) return false;
        return candidate.includes(target) || target.includes(candidate);
    });
    if (contained) return contained;

    // Plurals both ways - "navys"/"navy", "sets"/"set".
    const stem = target.endsWith('s') ? target.slice(0, -1) : `${target}s`;
    const plural = options.find((option) => norm(option) === stem);
    if (plural) return plural;

    // Finally, typos: "navvy", "nvy", "tael". People type badly, especially on
    // a phone, and a misspelt colour must not read as "we do not stock that".
    // Tolerance scales with word length so short names cannot collapse into
    // each other - "S" must never fuzzy-match "M".
    let best = null;
    let bestDistance = Infinity;

    for (const option of options) {
        const candidate = norm(option);
        const tolerance = Math.floor(Math.min(candidate.length, target.length) / 3);
        if (tolerance < 1) continue;

        const distance = editDistance(candidate, target);
        if (distance <= tolerance && distance < bestDistance) {
            best = option;
            bestDistance = distance;
        }
    }

    return best;
};

/**
 * Damerau-Levenshtein distance - edits between two strings, counting a swap of
 * two adjacent characters as one edit rather than two.
 *
 * That transposition case is the reason this is not plain Levenshtein:
 * "tael" for "teal" is the single commonest way people mistype a word, and
 * plain Levenshtein scores it 2, far enough to be rejected as a non-match.
 *
 * @param {String} a - First string.
 * @param {String} b - Second string.
 * @returns {Number} Edit distance.
 */
const editDistance = (a, b) => {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const grid = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let i = 0; i < rows; i += 1) grid[i][0] = i;
    for (let j = 0; j < cols; j += 1) grid[0][j] = j;

    for (let i = 1; i < rows; i += 1) {
        for (let j = 1; j < cols; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            grid[i][j] = Math.min(grid[i - 1][j] + 1, grid[i][j - 1] + 1, grid[i - 1][j - 1] + cost);

            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                grid[i][j] = Math.min(grid[i][j], grid[i - 2][j - 2] + cost);
            }
        }
    }
    return grid[rows - 1][cols - 1];
};

/**
 * Resolves a customer's colour and size wording to a real inventory row.
 *
 * Distinguishes "we do not make that" from "we make it but it is sold out" -
 * conflating the two is what produced a false out-of-stock answer.
 *
 * @param {Object} product - Product document.
 * @param {String} colour - Customer's colour wording.
 * @param {String} size - Customer's size wording.
 * @returns {Object} { row, colour, size, reason, availableColours, availableSizes }
 */
const resolveVariant = (product, colour, size) => {
    const inventory = product.inventory || [];
    const availableColours = [...new Set(inventory.map((entry) => entry.color).filter(Boolean))];
    const availableSizes = [...new Set(inventory.map((entry) => entry.size).filter(Boolean))];

    const resolvedColour = matchOption(colour, availableColours);
    if (!resolvedColour) {
        return { row: null, reason: 'unknown-colour', availableColours, availableSizes };
    }

    const sizesForColour = inventory
        .filter((entry) => entry.color === resolvedColour)
        .map((entry) => entry.size);
    const resolvedSize = matchOption(size, sizesForColour);
    if (!resolvedSize) {
        return { row: null, reason: 'unknown-size', colour: resolvedColour, availableColours, availableSizes: sizesForColour };
    }

    const row = inventory.find((entry) => entry.color === resolvedColour && entry.size === resolvedSize);
    return { row, colour: resolvedColour, size: resolvedSize, reason: null, availableColours, availableSizes };
};

/**
 * A fingerprint of exactly what was quoted to the customer.
 *
 * Placing an order is the one irreversible thing this agent can do, and a
 * prompt instruction is not a control - in testing the model placed an order
 * straight from "I want to order X", skipping both the quote and the
 * confirmation. This makes the sequence enforceable in code: place_order
 * needs a token that only prepare_order issues, and the token only matches if
 * the items are identical to the ones the customer was shown a total for.
 *
 * @param {Array} lines - Priced order lines.
 * @returns {String} Stable fingerprint of the basket.
 */
const buildDraftToken = (lines) =>
    require('crypto')
        .createHash('sha256')
        .update(
            lines
                .map((line) => `${line.productId}:${line.colour}:${line.size}:${line.quantity}:${line.unitPrice}`)
                .sort()
                .join('|')
        )
        .digest('hex')
        .slice(0, 16);

// Orders a customer may still cancel themselves. Anything further along has
// left the warehouse and needs a human - the agent says so rather than
// failing silently.
const CUSTOMER_CANCELLABLE = ['Pending', 'Confirmed'];

/**
 * What a product actually costs right now, in PKR.
 *
 * `discount` on a product is an object - { percentage, validUntil } - not a
 * number, so arithmetic straight off `product.discount` yields NaN and the
 * agent quotes "NaN" at the customer. An expired discount is ignored, so the
 * agent never quotes a price checkout would refuse to honour.
 *
 * @param {Object} product - Product document.
 * @returns {Object} { price, wasPrice, discountPercentage } - wasPrice is null
 *                   when nothing is discounted.
 */
const getCurrentPrice = (product) => {
    const percentage = Number(product.discount?.percentage) || 0;
    const validUntil = product.discount?.validUntil;
    const live = percentage > 0 && (!validUntil || new Date(validUntil) > new Date());

    if (!live) return { price: product.price, wasPrice: null, discountPercentage: 0 };

    return {
        price: Math.round(product.price - (product.price * percentage) / 100),
        wasPrice: product.price,
        discountPercentage: percentage
    };
};

/**
 * Trims a product document down to what a support conversation needs. Sending
 * whole documents would bury the model in inventory rows and image metadata.
 * @param {Object} product - Product document (lean or hydrated).
 * @returns {Object} Compact product summary.
 */
const summariseProduct = (product) => {
    const pricing = getCurrentPrice(product);
    return {
        id: String(product._id),
        name: product.name,
        // The price the customer pays, so the model never has to do the
        // discount arithmetic itself.
        price: pricing.price,
        wasPrice: pricing.wasPrice,
        discountPercentage: pricing.discountPercentage,
        currency: 'PKR',
        gender: product.gender,
        category: product.category,
        colors: (product.colors || []).map((colour) => colour.name).filter(Boolean),
        sizes: (product.sizes || []).filter((size) => size.isAvailable !== false).map((size) => size.name),
        averageRating: product.averageRating || 0
    };
};

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
    // A verified WhatsApp customer with no website account owns their orders
    // through their channel handle, which is the only identity they have.
    // Unverified handles are excluded: anyone can message from a number, and
    // an unproven handle must never reach someone else's orders.
    if (context.channelIdentityId && context.identityStatus !== 'unverified') {
        owner.push({ channelIdentity: context.channelIdentityId });
    }
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
                query: { type: 'string', description: 'Free text - matches product name, description, category and colour. Pass the customer\'s own words, including a colour if they mentioned one.' },
                gender: { type: 'string', description: 'Filter by gender, e.g. "Women" or "Men".' },
                limit: { type: 'integer', description: 'Maximum products to return. Defaults to 5, capped at 20.' }
            }
        },
        handler: async (input) => {
            // Only ever surface products the storefront would sell.
            const filter = { isActive: { $ne: false } };

            if (input.query) {
                // Customers search conversationally - "navy blue scrubs" - so
                // the whole phrase rarely appears anywhere. Match on any
                // meaningful word, across colour and category as well as name
                // and description: searching name/description alone meant a
                // colour query returned nothing and the agent reported the
                // item unavailable.
                const terms = String(input.query)
                    .split(/\s+/)
                    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                    .filter((term) => term.length > 2);

                // Customers type plurals - "scrubs", "sets" - while the
                // catalogue is singular, so match the stem too. Without this,
                // "crimson scrubs" found nothing and the agent said we sell no
                // scrubs at all, rather than "not in crimson".
                const withSingulars = terms.flatMap((term) =>
                    term.length > 3 && term.toLowerCase().endsWith('s') ? [term, term.slice(0, -1)] : [term]
                );

                const searchable = withSingulars.length
                    ? [...new Set(withSingulars)]
                    : [String(input.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')];

                filter.$or = searchable.flatMap((term) => [
                    { name: { $regex: term, $options: 'i' } },
                    { description: { $regex: term, $options: 'i' } },
                    { category: { $regex: term, $options: 'i' } },
                    { 'colors.name': { $regex: term, $options: 'i' } }
                ]);
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

            const match = resolveVariant(product, input.colour, input.size);

            // "We do not make that" is a different answer from "it is sold
            // out", and saying the wrong one loses a sale. Return what we do
            // have so the agent can offer it.
            if (!match.row) {
                return {
                    found: true,
                    product: product.name,
                    inStock: false,
                    availability:
                        match.reason === 'unknown-colour'
                            ? 'we do not stock that colour'
                            : 'we do not stock that size in that colour',
                    availableColours: match.availableColours,
                    availableSizes: match.availableSizes,
                    message:
                        'This is NOT out of stock - we simply do not have that combination. Offer the customer what is listed here.'
                };
            }

            return {
                found: true,
                product: product.name,
                // Echo the catalogue's own spelling, so the agent answers with
                // "Navy" even when the customer said "navy blue".
                colour: match.colour,
                size: match.size,
                inStock: match.row.stock > 0,
                // Exact counts are deliberately not returned - the agent should
                // say "in stock", not quote warehouse numbers to a customer.
                availability: match.row.stock > 0 ? 'in stock' : 'out of stock'
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
            const owner = [];
            if (context.userId) owner.push({ user: context.userId });
            if (context.email) owner.push({ customerEmail: String(context.email).toLowerCase() });
            // Verified chat customers own orders through their handle - see
            // findOwnedOrder for why unverified handles are excluded.
            if (context.channelIdentityId && context.identityStatus !== 'unverified') {
                owner.push({ channelIdentity: context.channelIdentityId });
            }

            if (!owner.length) {
                return { identified: false, message: 'This customer is not identified yet.' };
            }

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
                // An unknown id means the model guessed one instead of taking
                // it from search_products. Say that plainly - the previous
                // wording fell through to "nothing is available", and the
                // agent told a customer an in-stock item was sold out.
                const product = await Product.findById(item.productId).catch(() => null);
                if (!product) {
                    return {
                        prepared: false,
                        reason: 'unknown-product',
                        message:
                            'That is not a real product id. Call search_products first and use the id it returns - do not invent one. This does not mean the item is unavailable.'
                    };
                }

                const quantity = Math.max(Number(item.quantity) || 1, 1);
                const match = resolveVariant(product, item.colour, item.size);

                if (!match.row) {
                    problems.push(
                        `${product.name} is not made in ${item.colour}/${item.size}. Available colours: ${match.availableColours.join(', ')}.`
                    );
                    continue;
                }
                if (match.row.stock < quantity) {
                    problems.push(`${product.name} in ${match.colour}/${match.size} is sold out in that quantity.`);
                    continue;
                }
                const row = match.row;

                const { price: unitPrice } = getCurrentPrice(product);

                lines.push({
                    productId: String(product._id),
                    product: product.name,
                    // The catalogue's own spelling, not the customer's wording.
                    // place_order fingerprints the resolved variant, so quoting
                    // "navy" here and storing "Navy" there made every draft
                    // token mismatch and refused the order.
                    colour: match.colour,
                    size: match.size,
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
                // place_order will not write an order without this. It ties the
                // order to exactly what was quoted, so the agent cannot change
                // items between showing a total and charging for it, and it
                // cannot place an order it never quoted at all.
                draftToken: buildDraftToken(lines),
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
        name: 'place_order',
        description:
            'Actually place the order, cash on delivery, to one of the customer\'s saved addresses. Only call this after prepare_order and after the customer has clearly confirmed the items, the total and the address. This charges nothing up front but creates a real order that will be delivered and paid for on arrival - never call it speculatively.',
        inputSchema: {
            type: 'object',
            properties: {
                items: {
                    type: 'array',
                    description: 'The confirmed items, same shape as prepare_order.',
                    items: {
                        type: 'object',
                        properties: {
                            productId: { type: 'string' },
                            colour: { type: 'string' },
                            size: { type: 'string' },
                            quantity: { type: 'integer' }
                        },
                        required: ['productId', 'colour', 'size']
                    }
                },
                addressIndex: {
                    type: 'integer',
                    description:
                        'Which saved address to ship to, as listed by get_my_addresses. Defaults to their default address.'
                },
                pointsToUse: {
                    type: 'integer',
                    description:
                        'How many reward points to spend on this order, 1 point = 1 PKR off. Ask the customer how many they want to use before ordering, and pass the number they said. Pass 0 if they want to keep their points. Never guess a number.'
                },
                draftToken: {
                    type: 'string',
                    description:
                        'The draftToken returned by prepare_order for these exact items. Required - you cannot place an order you have not quoted.'
                },
                customerConfirmed: {
                    type: 'boolean',
                    description:
                        'Set true only after you have shown the customer the items, the total and the delivery address, and they have explicitly agreed in their own words. Never assume agreement from an initial request.'
                }
            },
            required: ['items', 'draftToken', 'customerConfirmed']
        },
        handler: async (input, context) => {
            // Guard 1: identity. An order is a real delivery obligation, so we
            // must know who it is for. Two ways to know that: a signed-in
            // website account, or a chat handle whose owner has proved they
            // control it. An unverified handle is nobody - anyone can message
            // from a number they do not own.
            const isChannelCustomer =
                !context.userId &&
                Boolean(context.channelIdentityId) &&
                context.identityStatus !== 'unverified';

            if (!context.userId && !isChannelCustomer) {
                return {
                    placed: false,
                    reason: 'not-identified',
                    message: context.channelIdentityId
                        ? 'This handle is not verified yet. Ask them to confirm the code we sent before ordering.'
                        : 'The customer must be signed in before an order can be placed.'
                };
            }

            // Guard 2: the customer actually said yes. Enforced here rather
            // than trusted to the prompt - see buildDraftToken.
            if (input.customerConfirmed !== true) {
                return {
                    placed: false,
                    reason: 'not-confirmed',
                    message:
                        'Show the customer the items, the total and the delivery address, and wait for them to agree before placing anything.'
                };
            }

            // A chat customer has no account, so the identity carries their
            // details instead. Everything downstream reads through these two,
            // which keeps one order-writing path rather than two that drift.
            let user = null;
            let identity = null;

            if (isChannelCustomer) {
                identity = await ChannelIdentity.findById(context.channelIdentityId);
                if (!identity) return { placed: false, message: 'Chat identity not found.' };
            } else {
                user = await User.findById(context.userId).select('username email addresses rewardPoints');
                if (!user) return { placed: false, message: 'Customer account not found.' };
            }

            // Guard 2: an address we have actually captured. For an account
            // that means a saved address, which was entered somewhere
            // reviewable. For a chat customer it means one they gave us and we
            // read back - collected by save_delivery_address, never inferred
            // from conversation here.
            const addresses = user ? user.addresses || [] : [];

            if (isChannelCustomer && !identity.deliveryAddress?.addressLine1) {
                return {
                    placed: false,
                    reason: 'no-address',
                    message:
                        'Ask the customer for their full delivery address - name, street and city - and save it with save_delivery_address before ordering.'
                };
            }

            if (!isChannelCustomer && !addresses.length) {
                return {
                    placed: false,
                    reason: 'no-address',
                    message:
                        'The customer has no saved address. Ask them to add one in their account, then try again.'
                };
            }

            const chosen = isChannelCustomer
                ? identity.deliveryAddress
                :
                (Number.isInteger(input.addressIndex) && addresses[input.addressIndex]) ||
                addresses.find((entry) => entry.isDefault) ||
                addresses[0];

            // Guard 3: re-validate stock and price at the moment of writing.
            // prepare_order may have run several messages ago and the last
            // unit can sell in between.
            const processed = [];
            let subtotal = 0;

            for (const wanted of input.items || []) {
                const product = await Product.findById(wanted.productId);
                if (!product) return { placed: false, message: `Product ${wanted.productId} no longer exists.` };

                const quantity = Math.max(Number(wanted.quantity) || 1, 1);
                const match = resolveVariant(product, wanted.colour, wanted.size);

                if (!match.row) {
                    return {
                        placed: false,
                        reason: 'unknown-variant',
                        message: `${product.name} is not made in ${wanted.colour}/${wanted.size}. Available colours: ${match.availableColours.join(', ')}. Nothing has been ordered.`
                    };
                }
                if (match.row.stock < quantity) {
                    return {
                        placed: false,
                        reason: 'out-of-stock',
                        message: `${product.name} in ${match.colour}/${match.size} is no longer available in that quantity. Nothing has been ordered.`
                    };
                }
                const row = match.row;

                const { price } = getCurrentPrice(product);
                processed.push({ product, row, quantity, price });
                subtotal += price * quantity;
            }

            if (!processed.length) return { placed: false, message: 'No items to order.' };

            // Points redemption. Spending a balance is irreversible from the
            // customer's side, so it is validated here rather than trusted
            // from the model: a hallucinated number would otherwise wipe a
            // balance the customer never agreed to spend.
            // Loyalty points belong to an account. A chat customer without one
            // has no balance to spend, so any number here is ignored rather
            // than silently discounting an order nobody paid for.
            const pointsToUse = user ? Math.max(0, Math.floor(Number(input.pointsToUse) || 0)) : 0;

            if (pointsToUse > 0) {
                if (pointsToUse > user.rewardPoints) {
                    return {
                        placed: false,
                        reason: 'insufficient-points',
                        message: `They only have ${user.rewardPoints} points. Nothing has been ordered - confirm a smaller amount.`
                    };
                }
                // Points cannot exceed the order value: a negative total would
                // fail the order model's own arithmetic check, and refunding
                // the difference is not something this flow can do.
                if (pointsToUse > subtotal) {
                    return {
                        placed: false,
                        reason: 'too-many-points',
                        message: `This order is only PKR ${subtotal}, so at most ${subtotal} points can be used. Nothing has been ordered.`
                    };
                }
            }

            // Guard 4: these must be the exact items, at the exact prices, that
            // prepare_order quoted. A mismatch means the basket changed after
            // the customer agreed to a total - refuse rather than charge them
            // for something they did not see.
            const expectedToken = buildDraftToken(
                processed.map((entry) => ({
                    productId: String(entry.product._id),
                    colour: entry.row.color,
                    size: entry.row.size,
                    quantity: entry.quantity,
                    unitPrice: entry.price
                }))
            );

            if (input.draftToken !== expectedToken) {
                return {
                    placed: false,
                    reason: 'draft-mismatch',
                    message:
                        'These items do not match the order you quoted. Run prepare_order again, show the customer the new total, and get their agreement before placing it.'
                };
            }

            // Same daily-sequence order id format checkout uses, so agent
            // orders are indistinguishable from web orders downstream.
            const now = new Date();
            const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const todayCount = await Order.countDocuments({
                createdAt: { $gte: startOfDay, $lt: new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000) }
            });
            const orderId = `${dateStr}-${String(todayCount + 1).padStart(3, '0')}`;

            const previousOrders = await Order.countDocuments(
                user ? { user: user._id } : { channelIdentity: identity._id }
            );

            // The Order model requires an email and a chat customer may not
            // have given one. A deterministic address derived from their handle
            // keeps the record valid and traceable back to the conversation;
            // their real confirmation goes to them in the chat itself, which is
            // where they are actually reading.
            const customerEmail = user
                ? user.email
                : `${identity.channel}-${String(identity.handle).replace(/[^\w]/g, '')}@chat.steth.local`;

            const order = await Order.create({
                orderId,
                user: user ? user._id : undefined,
                channelIdentity: user ? undefined : identity._id,
                items: processed.map((entry) => ({
                    product: entry.product._id,
                    productName: entry.product.name,
                    color: entry.row.color,
                    size: entry.row.size,
                    quantity: entry.quantity,
                    price: entry.price
                })),
                shippingAddress: {
                    fullName: chosen.fullName || (user ? user.username : identity.displayName) || 'Customer',
                    addressLine1: chosen.addressLine1,
                    addressLine2: chosen.addressLine2,
                    city: chosen.city,
                    state: chosen.state || 'N/A',
                    postalCode: chosen.postalCode || '00000',
                    country: chosen.country || 'Pakistan',
                    phoneNumber: chosen.phoneNumber
                },
                subtotal,
                // No discounts, codes, gift cards or points spending through
                // the agent. Those need the checkout screen, where the
                // customer can see exactly what is applied before paying.
                // Points spent are recorded as the order's discount, because
                // the model enforces total = subtotal - discount + shipping.
                // Recording them only in pointsUsed would leave the order
                // failing its own validation.
                discount: pointsToUse,
                shippingCharges: 0,
                total: subtotal - pointsToUse,
                pointsUsed: pointsToUse,
                // Earned on what they actually pay, matching checkout.
                pointsEarned: user ? Math.floor((subtotal - pointsToUse) / 100) : 0,
                paymentMethod: 'cash-on-delivery',
                isFirstOrder: previousOrders === 0,
                statusHistory: [{ status: 'Pending', changedAt: now }],
                customerEmail
            });

            // Deduct stock exactly as checkout does, then invalidate the
            // product caches so listings reflect it.
            for (const entry of processed) {
                entry.row.stock -= entry.quantity;
                entry.product.totalStock -= entry.quantity;
                await entry.product.save();
            }
            await invalidateProductCaches();

            // Credit the points this order earned, matching checkout.
            // Net movement in one write, exactly as checkout does it:
            // spend what they redeemed, credit what this order earned.
            // Only an account has a balance to move. A chat customer with no
            // account neither spends nor earns.
            const pointsDelta = order.pointsEarned - order.pointsUsed;
            if (user && pointsDelta !== 0) {
                await User.findByIdAndUpdate(user._id, { $inc: { rewardPoints: pointsDelta } });
            }

            return {
                placed: true,
                orderId: order.orderId,
                total: order.total,
                currency: 'PKR',
                pointsEarned: order.pointsEarned,
                // Both movements, so the agent can tell them what they spent
                // and what they have left rather than only the total.
                pointsUsed: order.pointsUsed,
                pointsBalance: user
                    ? Math.max(0, user.rewardPoints - order.pointsUsed + order.pointsEarned)
                    : null,
                paymentMethod: 'Cash on delivery',
                shippingTo: `${chosen.addressLine1}, ${chosen.city}`,
                status: order.orderStatus,
                message:
                    'Order placed. Tell the customer their order id, the total, that it is cash on delivery, and where it is going.'
            };
        }
    },

    {
        name: 'get_my_addresses',
        description:
            "List the customer's saved delivery addresses so they can choose where an order should go. Call this before place_order if they have more than one.",
        inputSchema: { type: 'object', properties: {} },
        handler: async (input, context) => {
            if (!context.userId) {
                return { addresses: [], message: 'The customer must be signed in to see their saved addresses.' };
            }
            const user = await User.findById(context.userId).select('addresses');
            const addresses = (user?.addresses || []).map((entry, index) => ({
                index,
                label: entry.type,
                line: [entry.addressLine1, entry.city].filter(Boolean).join(', '),
                isDefault: Boolean(entry.isDefault)
            }));
            return {
                addresses,
                message: addresses.length
                    ? undefined
                    : 'No saved addresses. They need to add one in their account before ordering through chat.'
            };
        }
    },

    {
        name: 'save_delivery_address',
        description:
            "Save the delivery address for a chat customer who has no Steth account. Call this only after they have given you a street address, a city and a name for the parcel. Read it back to them before placing any order - a wrong address in chat means a lost parcel.",
        inputSchema: {
            type: 'object',
            properties: {
                fullName: { type: 'string', description: 'Name the parcel is for.' },
                addressLine1: { type: 'string', description: 'Street address.' },
                addressLine2: { type: 'string', description: 'Apartment, floor or landmark. Optional.' },
                city: { type: 'string', description: 'City.' },
                postalCode: { type: 'string', description: 'Postal code, if they know it.' },
                phoneNumber: { type: 'string', description: 'Contact number for the courier.' }
            },
            required: ['fullName', 'addressLine1', 'city']
        },
        handler: async (input, context) => {
            if (!context.channelIdentityId) {
                return {
                    saved: false,
                    message: 'This only applies to chat customers. A website customer manages addresses in their account.'
                };
            }
            if (context.identityStatus === 'unverified') {
                return {
                    saved: false,
                    message: 'This handle is not verified yet, so no address can be stored against it.'
                };
            }

            const identity = await ChannelIdentity.findById(context.channelIdentityId);
            if (!identity) return { saved: false, message: 'Chat identity not found.' };

            identity.deliveryAddress = {
                fullName: String(input.fullName).trim(),
                addressLine1: String(input.addressLine1).trim(),
                addressLine2: input.addressLine2 ? String(input.addressLine2).trim() : undefined,
                city: String(input.city).trim(),
                postalCode: input.postalCode ? String(input.postalCode).trim() : undefined,
                country: 'Pakistan',
                // Falls back to the handle itself for WhatsApp, which is
                // already a working phone number the courier can call.
                phoneNumber: input.phoneNumber
                    ? String(input.phoneNumber).trim()
                    : identity.channel === 'whatsapp'
                        ? identity.handle
                        : undefined
            };
            await identity.save();

            return {
                saved: true,
                address: identity.deliveryAddress,
                message: 'Address saved. Read it back to the customer before placing the order.'
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
