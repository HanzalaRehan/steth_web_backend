/**
 * Author(s): 1. Zainab Raza
 * Description: Unit tests for the rule-based size recommendation engine.
 *              Covers the chart bands, the top/pants reconciliation into a
 *              single outfit size, the loose-fit adjustment (including the
 *              cap at our largest size), the height/weight fallback and the
 *              confidence levels.
 *
 *              These pin the behaviour of the rules so that when the trained
 *              model eventually replaces recommendSize(), the response
 *              contract it has to honour is written down and enforced.
 *              No database or Express involved - the engine is pure.
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: npm test
 */

const {
    recommendSize,
    recommendTopSize,
    recommendPantsSize,
    estimateFromBodyStats,
    sizeUp,
    largerSize,
    CONFIDENCE
} = require('../sizeRecommendation');

describe('recommendTopSize', () => {
    // Bands derived from the published chart: S<=38, M<=40, L<=42, XL<=44.
    test.each([
        [34, 'S'],
        [38, 'S'],
        [38.5, 'M'],
        [40, 'M'],
        [42, 'L'],
        [44, 'XL']
    ])('a %i" chest is a %s', (chest, expected) => {
        expect(recommendTopSize(chest).size).toBe(expected);
    });

    it('caps at XL and flags anything above the chart', () => {
        const result = recommendTopSize(52);
        expect(result.size).toBe('XL');
        expect(result.outOfChart).toBe(true);
    });
});

describe('recommendPantsSize', () => {
    // Waist bands are printed on the chart directly: 28-32, 32-36, 36-40, 40-44.
    test.each([
        [30, 'S'],
        [32, 'S'],
        [33, 'M'],
        [36, 'M'],
        [39, 'L'],
        [42, 'XL']
    ])('a %i" waist is a %s', (waist, expected) => {
        expect(recommendPantsSize(waist).size).toBe(expected);
    });

    it('sizes up when the hip needs more room than the waist size gives', () => {
        const result = recommendPantsSize(34, 42); // waist says M, hip needs L
        expect(result.size).toBe('L');
        expect(result.drivenByHip).toBe(true);
    });

    it('never sizes down for a small hip - the waist still governs', () => {
        const result = recommendPantsSize(38, 30); // waist says L, small hip
        expect(result.size).toBe('L');
        expect(result.drivenByHip).toBe(false);
    });
});

describe('recommendSize - one size for the whole outfit', () => {
    it('returns the single size when top and pants agree', () => {
        const result = recommendSize({ chest: 37, waist: 31 });
        expect(result.recommendedSize).toBe('S');
        expect(result.confidence).toBe(CONFIDENCE.HIGH);
    });

    it('takes the larger size when top and pants disagree, and explains why', () => {
        const result = recommendSize({ chest: 41, waist: 31 });
        expect(result.breakdown).toMatchObject({ top: 'L', pants: 'S' });
        expect(result.recommendedSize).toBe('L');
        expect(result.notes.join(' ')).toMatch(/chest measures a L and your waist a S/);
    });

    it('drops to medium confidence when only one measurement is given', () => {
        expect(recommendSize({ waist: 34 }).confidence).toBe(CONFIDENCE.MEDIUM);
        expect(recommendSize({ chest: 39 }).confidence).toBe(CONFIDENCE.MEDIUM);
    });

    it('throws when there is nothing usable to size from', () => {
        expect(() => recommendSize({})).toThrow(/Not enough information/);
    });
});

describe('recommendSize - loose fit preference', () => {
    it('recommends one size up while still reporting the measured size', () => {
        const result = recommendSize({ chest: 37, waist: 31, fitPreference: 'loose' });

        expect(result.baseSize).toBe('S');          // what the chart said
        expect(result.recommendedSize).toBe('M');   // what we tell the customer
        expect(result.adjustedForFit).toBe(true);
        expect(result.notes[0]).toMatch(/put you in a S.*looser fit.*recommending M/);
    });

    it('cannot go past the largest stocked size', () => {
        const result = recommendSize({ chest: 44, waist: 43, fitPreference: 'loose' });

        expect(result.recommendedSize).toBe('XL');
        expect(result.adjustedForFit).toBe(false);
        expect(result.notes.join(' ')).toMatch(/already in our largest size/);
    });

    it('treats an unrecognised preference as regular rather than failing', () => {
        const result = recommendSize({ chest: 37, waist: 31, fitPreference: 'skin-tight' });
        expect(result.fitPreference).toBe('regular');
        expect(result.recommendedSize).toBe(result.baseSize);
    });
});

describe('recommendSize - height/weight fallback', () => {
    it('estimates a size and marks it low confidence', () => {
        const result = recommendSize({ heightInches: 65, weightKg: 70 });

        expect(result.confidence).toBe(CONFIDENCE.LOW);
        expect(result.breakdown.basis).toBe('height-weight-estimate');
        expect(result.notes.join(' ')).toMatch(/estimate from your height and weight/);
    });

    it('prefers real measurements over the estimate when both are given', () => {
        const result = recommendSize({ chest: 37, waist: 31, heightInches: 71, weightKg: 95 });
        expect(result.breakdown.basis).toBe('measurements');
        expect(result.confidence).toBe(CONFIDENCE.HIGH);
    });

    it('adds a hem note for shorter customers', () => {
        const result = recommendSize({ chest: 37, waist: 31, heightInches: 61 });
        expect(result.notes.join(' ')).toMatch(/taken up by 2"/);
    });

    it('rejects unusable height/weight input', () => {
        expect(estimateFromBodyStats(0, 70)).toBeNull();
        expect(estimateFromBodyStats(65, 0)).toBeNull();
    });
});

describe('size helpers', () => {
    it('sizeUp clamps at the largest size', () => {
        expect(sizeUp('S')).toBe('M');
        expect(sizeUp('XL')).toBe('XL');
    });

    it('largerSize picks the bigger of two sizes either way round', () => {
        expect(largerSize('S', 'L')).toBe('L');
        expect(largerSize('L', 'S')).toBe('L');
        expect(largerSize('M', 'M')).toBe('M');
    });
});
