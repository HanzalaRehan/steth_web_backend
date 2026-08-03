/**
 * Author(s): 1. Zainab Raza
 * Description: Single source of truth for Steth's published scrub size charts
 *              (top + pants) and the body-measurement bands derived from them.
 *              Everything size-related in the backend reads from here so the
 *              recommendation engine, the API responses and any future admin
 *              tooling can never drift apart.
 *
 *              The garment tables (TOP_CHART / PANTS_CHART) are copied verbatim
 *              from the customer-facing size chart images - all values in inches,
 *              LENGTH/CHEST/SLEEVE/HIP are flat (laid-flat) garment measurements,
 *              pants WAIST is the only body measurement on the published charts.
 *
 *              The BODY_* bands convert those garment numbers into "which body
 *              fits in this garment" ranges by applying the ease constants
 *              below. These bands are what the rule-based engine matches
 *              against until there is enough order/exchange data to train a
 *              model (see sizeRecommendation.js).
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - imported by src/utils/sizeRecommendation.js
 */

// Ordered smallest -> largest. Index position is used for "one size up"
// arithmetic in the engine, so never reorder this array.
const SIZES = ['S', 'M', 'L', 'XL'];

// Published scrub top chart. Flat measurements, inches.
const TOP_CHART = {
    S: { length: 27.5, chest: 21.5, sleeve: 9 },
    M: { length: 28.5, chest: 22.5, sleeve: 9.5 },
    L: { length: 29.5, chest: 23.5, sleeve: 10 },
    XL: { length: 30.5, chest: 24.5, sleeve: 10.5 }
};

// Published scrub pants chart. `waist` is a body measurement range (as printed
// on the chart), `hip` is a flat garment measurement, `length` is inseam-ish
// total length and is adjustable by up to 2" at tailoring.
const PANTS_CHART = {
    S: { length: 39, waist: [28, 32], hip: 20.5 },
    M: { length: 40, waist: [32, 36], hip: 21.5 },
    L: { length: 41, waist: [36, 40], hip: 22.5 },
    XL: { length: 42, waist: [40, 44], hip: 23.5 }
};

// Pants lengths are adjustable up to 2" (printed on the pants chart). Used to
// decide whether to attach a "get the hem taken up" note for shorter customers.
const PANTS_LENGTH_ADJUSTMENT_INCHES = 2;

// Ease = the gap between the body and the garment. Scrubs are cut deliberately
// boxy for movement, so these are generous compared to fitted apparel. Chosen
// to reproduce the brand's own size guidance from the published chart; they are
// the main lever to retune if exchange data later shows systematic mis-sizing.
const EASE = {
    // Minimum slack across the chest before a top reads as tight.
    topChest: 5,
    // Minimum slack across the hip before pants read as tight.
    pantsHip: 2
};

/**
 * Converts a flat (laid-flat) garment measurement to a full circumference.
 * A flat chest of 21.5" is half the garment tube, so the wearer has 43" to
 * work with.
 * @param {Number} flatInches - Flat measurement straight off the size chart.
 * @returns {Number} Circumference in inches.
 */
const flatToCircumference = (flatInches) => flatInches * 2;

// Largest body chest (full circumference, measured at the fullest point) that
// still gets EASE.topChest of slack in each top size.
const BODY_CHEST_MAX = SIZES.reduce((bands, size) => {
    bands[size] = flatToCircumference(TOP_CHART[size].chest) - EASE.topChest;
    return bands;
}, {});

// Largest body hip (full circumference) that still fits each pants size.
const BODY_HIP_MAX = SIZES.reduce((bands, size) => {
    bands[size] = flatToCircumference(PANTS_CHART[size].hip) - EASE.pantsHip;
    return bands;
}, {});

// Body waist bands come straight off the pants chart - no ease maths needed,
// the printed ranges are already body measurements.
const BODY_WAIST_MAX = SIZES.reduce((bands, size) => {
    bands[size] = PANTS_CHART[size].waist[1];
    return bands;
}, {});

// Smallest body waist the chart covers at all. Anything under this is below the
// published range and gets flagged as out-of-chart rather than silently sized.
const BODY_WAIST_MIN = PANTS_CHART.S.waist[0];

module.exports = {
    SIZES,
    TOP_CHART,
    PANTS_CHART,
    PANTS_LENGTH_ADJUSTMENT_INCHES,
    EASE,
    BODY_CHEST_MAX,
    BODY_HIP_MAX,
    BODY_WAIST_MAX,
    BODY_WAIST_MIN,
    flatToCircumference
};
