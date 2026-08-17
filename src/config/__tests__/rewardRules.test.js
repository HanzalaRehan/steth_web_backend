/**
 * Author(s): 1. Zainab Raza
 * Description: Unit tests for the loyalty programme rule catalogue and the
 *              occurrence-key logic that the ledger's uniqueness guarantee
 *              depends on.
 *
 *              These are the pure, database-free parts of the programme. They
 *              guard the two things most likely to break silently when the
 *              business retunes the numbers: a rule losing a required field,
 *              and a cadence producing the wrong occurrence key (which would
 *              quietly turn a one-time reward into a repeatable one).
 *
 * Date created: August 3rd, 2026
 * Edit(s):
 *   (1): None
 * Date last modified: August 3rd, 2026
 * Run: npm test
 */

const {
    CADENCE,
    TRIGGER,
    REWARD_RULES,
    getRule,
    listRules,
    listClaimableRules
} = require('../rewardRules');

const { buildOccurrenceKey } = require('../../services/rewards.service');

describe('reward rule catalogue', () => {
    it('covers every reward in the programme brief', () => {
        // The 14 rewards signed off for launch, plus the sign-up bonus the
        // rewards page pays on joining. "Join All-Access" is deliberately
        // excluded - it needs a membership product first.
        expect(listRules()).toHaveLength(15);
        expect(getRule('SIGN_UP').points).toBe(200);
        expect(getRule('JOIN_ALL_ACCESS')).toBeNull();
    });

    it('pays the sign-up bonus automatically rather than by claim', () => {
        // Derived from the account's creation date, so customers who joined
        // before the programme launched are credited too.
        expect(getRule('SIGN_UP').trigger).toBe(TRIGGER.DERIVED);
        expect(getRule('SIGN_UP').cadence).toBe(CADENCE.ONCE);
    });

    it('uses WhatsApp rather than SMS for the messaging opt-in', () => {
        expect(getRule('SUBSCRIBE_WHATSAPP')).not.toBeNull();
        expect(getRule('SUBSCRIBE_SMS')).toBeNull();
        expect(getRule('SUBSCRIBE_WHATSAPP').requiresWhatsappNumber).toBe(true);
    });

    it('gives every rule the fields the engine and the page rely on', () => {
        listRules().forEach((rule) => {
            expect(typeof rule.key).toBe('string');
            expect(typeof rule.label).toBe('string');
            expect(typeof rule.points).toBe('number');
            expect(rule.points).toBeGreaterThan(0);
            expect(Object.values(CADENCE)).toContain(rule.cadence);
            expect(Object.values(TRIGGER)).toContain(rule.trigger);
        });
    });

    it('keys every rule to its own name, so ledger rows stay resolvable', () => {
        Object.entries(REWARD_RULES).forEach(([key, rule]) => {
            expect(rule.key).toBe(key);
        });
    });

    it('only lets social and subscription rewards be self-claimed', () => {
        // Anything a customer can claim by asking is trust-based, so it must
        // never be repeatable - that would be an open points tap.
        listClaimableRules().forEach((rule) => {
            expect(rule.cadence).toBe(CADENCE.ONCE);
        });
        expect(listClaimableRules().map((rule) => rule.key)).toEqual([
            'SUBSCRIBE_EMAIL',
            'SUBSCRIBE_WHATSAPP',
            'FOLLOW_FACEBOOK',
            'FOLLOW_INSTAGRAM',
            'FOLLOW_TIKTOK'
        ]);
    });

    it('never exposes purchase milestones as claimable', () => {
        listRules()
            .filter((rule) => rule.category === 'purchase')
            .forEach((rule) => {
                expect(rule.trigger).toBe(TRIGGER.DERIVED);
            });
    });

    it('gives purchase rules the thresholds their evaluators read', () => {
        expect(REWARD_RULES.HIGH_VALUE_ORDER.thresholdPkr).toBeGreaterThan(0);
        expect(REWARD_RULES.RECURRING_PURCHASE.thresholdPkr).toBeGreaterThan(0);
        expect(REWARD_RULES.RECURRING_PURCHASE.interval).toBeGreaterThan(1);
        expect(REWARD_RULES.SECOND_ORDER_FAST.windowDays).toBe(30);
        expect(REWARD_RULES.ORDER_COUNT_MILESTONE.orderCount).toBe(5);
    });
});

describe('occurrence keys', () => {
    it('collapses one-time rules onto a single key', () => {
        expect(buildOccurrenceKey(getRule('SECOND_ORDER'))).toBe('once');
        expect(buildOccurrenceKey(getRule('FOLLOW_TIKTOK'))).toBe('once');
    });

    it('keys annual rules by year, so they reset once a year and no sooner', () => {
        expect(buildOccurrenceKey(getRule('BIRTHDAY'), null, new Date('2026-03-08'))).toBe('2026');
        expect(buildOccurrenceKey(getRule('BIRTHDAY'), null, new Date('2027-03-08'))).toBe('2027');
        // Same year, different date - still one payout.
        expect(buildOccurrenceKey(getRule('BIRTHDAY'), null, new Date('2026-12-31'))).toBe('2026');
    });

    it('keys repeatable rules by the thing that triggered them', () => {
        expect(buildOccurrenceKey(getRule('RECURRING_PURCHASE'), '3')).toBe('3');
        expect(buildOccurrenceKey(getRule('PRODUCT_REVIEW'), 'abc123')).toBe('abc123');
    });
});
