/**
 * Author(s): 1. Zainab Raza
 * Description: Rule-based size recommendation engine - the brain behind both
 *              "What's My Size?" and the "Size Quiz". Pure functions only: no
 *              database access, no Express objects, no side effects, so it can
 *              be unit tested standalone and swapped for a trained model later
 *              without touching the controller.
 *
 *              Why rules: at launch there is zero order/exchange history to
 *              learn from, so recommendations are derived from the published
 *              size chart (see sizeChart.js). Every submission is persisted by
 *              the controller so a model can be trained on real fit outcomes
 *              once the data exists - at that point only recommendSize() needs
 *              replacing, and its return shape is the contract to preserve.
 *
 *              Deliberately returns ONE size for the whole outfit (top +
 *              pants), because Steth sells scrub sets and a customer wants a
 *              single answer. Where the top and the bottom disagree the larger
 *              of the two wins - a slightly roomy top is wearable, a tight
 *              waistband is not - and the disagreement is surfaced in the
 *              response so the storefront can explain it.
 *
 *              Key functions:
 *                - recommendTopSize      : body chest -> top size
 *                - recommendPantsSize    : body waist + hip -> pants size
 *                - estimateFromBodyStats : height/weight fallback (BMI bands)
 *                - recommendSize         : the public entry point
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: Not directly runnable - imported by src/controllers/size.controller.js
 */

const {
    SIZES,
    PANTS_CHART,
    PANTS_LENGTH_ADJUSTMENT_INCHES,
    BODY_CHEST_MAX,
    BODY_HIP_MAX,
    BODY_WAIST_MAX,
    BODY_WAIST_MIN
} = require('./sizeChart');

// Accepted values for the customer's fit preference. 'regular' is the default
// and means "size me exactly as the chart says".
const FIT_PREFERENCES = ['regular', 'loose'];

// How confident we are in the answer, driven by which inputs we actually got.
// Surfaced to the storefront so it can soften the copy on weak inputs, and
// stored so the future training set can be weighted by input quality.
const CONFIDENCE = {
    HIGH: 'high',      // real chest AND waist measurements
    MEDIUM: 'medium',  // one real measurement
    LOW: 'low'         // height/weight estimate only
};

// BMI bands for the fallback path. Most customers do not own a tape measure,
// so height + weight is the realistic minimum input. These bands are an
// intentionally coarse heuristic - they are the first thing the trained model
// should replace, which is why every estimate is marked CONFIDENCE.LOW.
const BMI_BANDS = [
    { maxBmi: 19, size: 'S' },
    { maxBmi: 23.5, size: 'M' },
    { maxBmi: 28, size: 'L' },
    { maxBmi: Infinity, size: 'XL' }
];

// Below this height the pants will almost certainly need their hem taken up.
// The chart already advertises up to 2" of adjustment, so this is a note, not
// a size change.
const SHORT_HEIGHT_INCHES = 63; // 5'3"

/**
 * Picks the smallest size whose band still accommodates the given measurement.
 * @param {Number} measurement - Body measurement in inches.
 * @param {Object} bands - Map of size -> largest body measurement it fits.
 * @returns {String|null} Size letter, or null if the measurement exceeds every
 *                        band (i.e. the customer is off the top of the chart).
 */
const matchBand = (measurement, bands) => {
    const match = SIZES.find((size) => measurement <= bands[size]);
    return match || null;
};

/**
 * Moves a size up by `steps` positions, clamped to the largest stocked size.
 * @param {String} size - Starting size letter.
 * @param {Number} steps - How many sizes to go up (default 1).
 * @returns {String} The bumped size, never beyond the top of SIZES.
 */
const sizeUp = (size, steps = 1) => {
    const index = SIZES.indexOf(size);
    if (index === -1) return size;
    return SIZES[Math.min(index + steps, SIZES.length - 1)];
};

/**
 * Returns whichever of two sizes is larger. Used to reconcile a top size and a
 * pants size into the single outfit size the customer is shown.
 * @param {String} a - First size letter.
 * @param {String} b - Second size letter.
 * @returns {String} The larger of the two.
 */
const largerSize = (a, b) => (SIZES.indexOf(a) >= SIZES.indexOf(b) ? a : b);

/**
 * Top size from a body chest measurement (full circumference at the fullest
 * point), using the ease-adjusted bands derived from the published chart.
 * @param {Number} chest - Body chest circumference in inches.
 * @returns {Object} { size, outOfChart } - outOfChart flags a chest larger than
 *                   XL accommodates, in which case size is capped at XL.
 */
const recommendTopSize = (chest) => {
    const match = matchBand(chest, BODY_CHEST_MAX);
    return match
        ? { size: match, outOfChart: false }
        : { size: SIZES[SIZES.length - 1], outOfChart: true };
};

/**
 * Pants size from waist and (optionally) hip. Waist drives the decision because
 * that is what the published chart is built around; hip can only push the size
 * up, never down, since a waistband can be cinched but a hip cannot be shrunk.
 * @param {Number} waist - Body waist circumference in inches.
 * @param {Number} [hip] - Body hip circumference in inches. Optional.
 * @returns {Object} { size, outOfChart, drivenByHip }
 */
const recommendPantsSize = (waist, hip) => {
    const waistMatch = matchBand(waist, BODY_WAIST_MAX);
    const outOfChart = !waistMatch;
    let size = waistMatch || SIZES[SIZES.length - 1];
    let drivenByHip = false;

    if (hip) {
        const hipMatch = matchBand(hip, BODY_HIP_MAX) || SIZES[SIZES.length - 1];
        const reconciled = largerSize(size, hipMatch);
        drivenByHip = reconciled !== size;
        size = reconciled;
    }

    return { size, outOfChart, drivenByHip };
};

/**
 * Fallback for customers who do not know their measurements: a BMI band read
 * off height and weight. Coarse by design and always reported as low
 * confidence.
 * @param {Number} heightInches - Height in inches.
 * @param {Number} weightKg - Weight in kilograms.
 * @returns {Object|null} { size, bmi } or null if either input is unusable.
 */
const estimateFromBodyStats = (heightInches, weightKg) => {
    if (!heightInches || !weightKg || heightInches <= 0 || weightKg <= 0) return null;

    const heightMetres = heightInches * 0.0254;
    const bmi = weightKg / (heightMetres * heightMetres);
    const band = BMI_BANDS.find((entry) => bmi < entry.maxBmi);

    return { size: band.size, bmi: Number(bmi.toFixed(1)) };
};

/**
 * The public entry point. Takes whatever the customer gave us and returns a
 * single outfit size plus the reasoning behind it.
 *
 * The returned object is the stable contract - the controller persists it and
 * the storefront renders it, so a future ML implementation must keep this
 * shape:
 *   recommendedSize  - what the customer should actually add to cart
 *   baseSize         - what the measurements alone said, before fit preference
 *   fitPreference    - echoed back, 'regular' | 'loose'
 *   adjustedForFit   - true when loose-fit bumped them up a size
 *   confidence       - 'high' | 'medium' | 'low'
 *   breakdown        - per-garment sizes, so the UI can show top vs pants
 *   notes            - plain-English strings, safe to render as-is
 *
 * @param {Object} input - Customer answers.
 * @param {Number} [input.chest] - Body chest circumference, inches.
 * @param {Number} [input.waist] - Body waist circumference, inches.
 * @param {Number} [input.hip] - Body hip circumference, inches.
 * @param {Number} [input.heightInches] - Height, inches (fallback + hem note).
 * @param {Number} [input.weightKg] - Weight, kilograms (fallback only).
 * @param {String} [input.fitPreference] - 'regular' (default) or 'loose'.
 * @returns {Object} Recommendation payload as described above.
 * @throws {Error} If no usable measurement combination was supplied.
 */
const recommendSize = (input = {}) => {
    const { chest, waist, hip, heightInches, weightKg } = input;
    const fitPreference = FIT_PREFERENCES.includes(input.fitPreference)
        ? input.fitPreference
        : 'regular';

    const notes = [];
    const breakdown = { top: null, pants: null, basis: null };
    let baseSize = null;
    let confidence = CONFIDENCE.LOW;

    const top = chest ? recommendTopSize(chest) : null;
    const pants = waist ? recommendPantsSize(waist, hip) : null;

    if (top && pants) {
        // Both halves measured - the strongest signal we can get from rules.
        breakdown.top = top.size;
        breakdown.pants = pants.size;
        breakdown.basis = 'measurements';
        baseSize = largerSize(top.size, pants.size);
        confidence = CONFIDENCE.HIGH;

        if (top.size !== pants.size) {
            notes.push(
                `Your chest measures a ${top.size} and your waist a ${pants.size}. ` +
                `We've gone with ${baseSize} so nothing pulls - scrub tops are cut roomy, ` +
                `so the larger size still sits well up top.`
            );
        }
    } else if (top || pants) {
        // Only one half measured. Usable, but we are extrapolating the other
        // half from it, so confidence drops a step.
        const measured = top || pants;
        breakdown.top = top ? top.size : null;
        breakdown.pants = pants ? pants.size : null;
        breakdown.basis = 'measurements';
        baseSize = measured.size;
        confidence = CONFIDENCE.MEDIUM;
        notes.push(
            top
                ? 'Sized from your chest measurement. Add your waist for a sharper match on the pants.'
                : 'Sized from your waist measurement. Add your chest for a sharper match on the top.'
        );
    } else {
        // Nothing measured - fall back to height/weight.
        const estimate = estimateFromBodyStats(heightInches, weightKg);
        if (!estimate) {
            throw new Error(
                'Not enough information to recommend a size. Provide chest or waist in inches, or height and weight.'
            );
        }
        breakdown.top = estimate.size;
        breakdown.pants = estimate.size;
        breakdown.basis = 'height-weight-estimate';
        baseSize = estimate.size;
        confidence = CONFIDENCE.LOW;
        notes.push(
            'This is an estimate from your height and weight. Measuring your chest and waist will make it more accurate.'
        );
    }

    // Out-of-chart customers are capped at XL by the band matchers above; say so
    // rather than pretending XL is a clean fit.
    if ((top && top.outOfChart) || (pants && pants.outOfChart)) {
        notes.push(
            'Your measurements sit above our largest stocked size, so we\'ve recommended XL. ' +
            'Reach out and our team will help you get the fit right.'
        );
    }

    if (waist && waist < BODY_WAIST_MIN) {
        notes.push(
            `Our chart starts at a ${BODY_WAIST_MIN}" waist, so S is the smallest we stock - ` +
            'the drawstring will take up the extra room.'
        );
    }

    if (pants && pants.drivenByHip) {
        notes.push('Sized up for your hip measurement - the waistband drawstring will take in the waist.');
    }

    // Fit preference is applied last, on top of the finished measurement answer,
    // so the customer can always see what the chart alone said (baseSize) versus
    // what we actually recommended (recommendedSize).
    let recommendedSize = baseSize;
    let adjustedForFit = false;

    if (fitPreference === 'loose') {
        const bumped = sizeUp(baseSize);
        if (bumped !== baseSize) {
            recommendedSize = bumped;
            adjustedForFit = true;
            notes.unshift(
                `Your measurements put you in a ${baseSize}. You told us you like a looser fit, ` +
                `so we're recommending ${recommendedSize}.`
            );
        } else {
            notes.push(
                `You're already in our largest size, so we can't go up for a looser fit - ` +
                `${recommendedSize} it is.`
            );
        }
    }

    if (heightInches && heightInches < SHORT_HEIGHT_INCHES) {
        notes.push(
            `Our ${recommendedSize} pants run ${PANTS_CHART[recommendedSize].length}" long and can be ` +
            `taken up by ${PANTS_LENGTH_ADJUSTMENT_INCHES}" if you need them shorter.`
        );
    }

    return {
        recommendedSize,
        baseSize,
        fitPreference,
        adjustedForFit,
        confidence,
        breakdown,
        notes
    };
};

module.exports = {
    FIT_PREFERENCES,
    CONFIDENCE,
    SHORT_HEIGHT_INCHES,
    matchBand,
    sizeUp,
    largerSize,
    recommendTopSize,
    recommendPantsSize,
    estimateFromBodyStats,
    recommendSize
};
