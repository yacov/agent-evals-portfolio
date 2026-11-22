// Behaviour suite: pins the REQUIRED behaviour in SPEC.md, through the public quote() function only.
// Each describe block names the SPEC rule it covers. Expected numbers are worked out by hand from
// the spec (the working is in the comments), never copied from the implementation's output.
//
// Things the spec leaves open are deliberately NOT asserted: line order, reason order, whether a
// zero-amount line exists, error message wording, internal helpers.
import { describe, it, expect } from 'vitest';
import { quote, DEFAULT_RATE_CARD, QuoteInputError, type QuoteInput, type Quote, type RateCard } from '../src/quote';

/** One inventory line of exactly `m3` cubic metres. */
const load = (m3: number) => ({ name: 'load', quantity: 1, highM3: m3, loadFactor: 1 });

/** Private move, 5 m3, no distance, easy access at both ends: labour 2 h x 792 = 1584 ex VAT. */
const base = (overrides: Partial<QuoteInput> = {}): QuoteInput => ({
  moveType: 'private',
  items: [load(5)],
  ...overrides,
});

/** Amount of a line by code; a missing line counts as 0 (the spec allows either). */
const amount = (q: Quote, code: string) =>
  q.lines.filter((line) => line.code === code).reduce((sum, line) => sum + line.amountExVat, 0);

const BASE_LABOUR = 1584;

const cardWith = (overrides: Partial<RateCard>): RateCard => ({ ...DEFAULT_RATE_CARD, ...overrides });

describe('V. volume', () => {
  it('V1: each line counts highM3 x loadFactor x quantity', () => {
    // 2.0 x 1.2 = 2.4; 0.3 x 1.3 = 0.39, x 6 = 2.34; 0.1 x 1.0 x 40 = 4.0 -> 8.74
    const q = quote(
      base({
        items: [
          { name: 'sofa', quantity: 1, highM3: 2.0, loadFactor: 1.2 },
          { name: 'chair', quantity: 6, highM3: 0.3, loadFactor: 1.3 },
          { name: 'box', quantity: 40, highM3: 0.1, loadFactor: 1.0 },
        ],
      }),
    );
    expect(q.volumeM3).toBe(8.74);
  });

  it('V1: the per-piece volume is rounded to 2 decimals before multiplying by quantity', () => {
    // 0.05 x 1.3 = 0.065 -> 0.07 per piece, x 10 = 0.7 (not 0.65); 5 + 0.7 = 5.7
    const q = quote(base({ items: [load(5), { name: 'screen', quantity: 10, highM3: 0.05, loadFactor: 1.3 }] }));
    expect(q.volumeM3).toBe(5.7);
  });

  it('V2: lines that stay behind count nothing', () => {
    // 10 m3 moving; 2 wardrobes staying (would add 3.96 and push hours from 3 to 4)
    const q = quote(
      base({ items: [load(10), { name: 'wardrobe', quantity: 2, highM3: 1.8, loadFactor: 1.1, moving: false }] }),
    );
    expect(q.volumeM3).toBe(10);
    expect(q.hours).toBe(3);
  });

  it('V2: a line without the moving field is moving', () => {
    const q = quote(base({ items: [load(6), { name: 'desk', quantity: 1, highM3: 1, loadFactor: 1 }] }));
    expect(q.volumeM3).toBe(7);
  });

  it('V3: quantity 0 counts nothing', () => {
    const q = quote(base({ items: [load(6), { name: 'sofa', quantity: 0, highM3: 2, loadFactor: 1.2 }] }));
    expect(q.volumeM3).toBe(6);
  });

  it('V4: with no inventory, volume = living area x 0.35', () => {
    // 60 x 0.35 = 21 m3 -> large crew, ceil(21 x 15 / 60) = 6 h x 1120 = 6720
    const q = quote(base({ items: [], livingAreaM2: 60 }));
    expect(q.volumeM3).toBe(21);
    expect(q.crewId).toBe('crew-3m-25m3');
    expect(amount(q, 'labour')).toBe(6720);
  });

  it('V4: the area estimate is rounded to 1 decimal, halves up', () => {
    // 43 x 0.35 = 15.05 -> 15.1, which no longer fits the 15 m3 truck
    const q = quote(base({ items: undefined, livingAreaM2: 43 }));
    expect(q.volumeM3).toBe(15.1);
    expect(q.crewId).toBe('crew-3m-25m3');
  });

  it('V4: a measured inventory wins over the living area', () => {
    const q = quote(base({ items: [load(8)], livingAreaM2: 100 }));
    expect(q.volumeM3).toBe(8);
  });

  it('V4: if every line stays behind, the living area is used', () => {
    // 20 x 0.35 = 7
    const q = quote(
      base({ items: [{ name: 'fridge', quantity: 1, highM3: 0.8, loadFactor: 1.1, moving: false }], livingAreaM2: 20 }),
    );
    expect(q.volumeM3).toBe(7);
  });

  it('V5: the billable volume is at least 5 m3, also when a small inventory was measured', () => {
    expect(quote(base({ items: [load(2)] })).volumeM3).toBe(5);
    expect(quote(base({ items: [] })).volumeM3).toBe(5);
  });

  it('V5: the 5 m3 minimum drives the price, not only the reported volume', () => {
    // One crew, 60 min per m3, minimum 1 h: 5 m3 -> 5 h x 100 = 500 even though 2 m3 was measured
    const card = cardWith({
      handlingMinutesPerM3: 60,
      crews: [{ id: 'solo', movers: 1, capacityM3: 40, hourlyRateExVat: 100, minimumHours: 1 }],
    });
    const q = quote(base({ items: [load(2)] }), card);
    expect(q.hours).toBe(5);
    expect(amount(q, 'labour')).toBe(500);
  });
});

describe('C. crew', () => {
  it('C1: a volume exactly equal to a capacity fits that truck', () => {
    // 15 m3 -> small crew, ceil(3.75) = 4 h x 792 = 3168
    const q = quote(base({ items: [load(15)] }));
    expect(q.crewId).toBe('crew-2m-15m3');
    expect(amount(q, 'labour')).toBe(3168);
  });

  it('C1: just above a capacity needs the next truck', () => {
    // 15.01 m3 -> large crew, ceil(3.7525) = 4 h x 1120 = 4480
    const q = quote(base({ items: [load(15.01)] }));
    expect(q.crewId).toBe('crew-3m-25m3');
    expect(amount(q, 'labour')).toBe(4480);
  });

  it('C2: the rate card crew order does not matter', () => {
    const card = cardWith({ crews: [...DEFAULT_RATE_CARD.crews].reverse() });
    expect(quote(base({ items: [load(10)] }), card).crewId).toBe('crew-2m-15m3');
    expect(quote(base({ items: [load(20)] }), card).crewId).toBe('crew-3m-25m3');
  });

  it('C3: exactly the largest capacity is not flagged', () => {
    const q = quote(base({ items: [load(25)] }));
    expect(q.crewId).toBe('crew-3m-25m3');
    expect(q.reviewReasons).not.toContain('volume_over_capacity');
    expect(q.mode).toBe('fixed');
  });

  it('C3: above the largest capacity uses the largest crew and is flagged', () => {
    const q = quote(base({ items: [load(25.01)] }));
    expect(q.crewId).toBe('crew-3m-25m3');
    expect(q.reviewReasons).toContain('volume_over_capacity');
    expect(q.mode).toBe('manual');
  });
});

describe('H. hours and labour', () => {
  it('H1: handling time is rounded UP to a whole hour', () => {
    // 9 m3 x 15 / 60 = 2.25 h -> 3 h x 792 = 2376
    const q = quote(base({ items: [load(9)] }));
    expect(q.hours).toBe(3);
    expect(amount(q, 'labour')).toBe(2376);
  });

  it('H1: a whole number of hours is not rounded further', () => {
    // 16 m3 -> exactly 4 h, large crew: 4 x 1120 = 4480
    const q = quote(base({ items: [load(16)] }));
    expect(q.hours).toBe(4);
    expect(amount(q, 'labour')).toBe(4480);
  });

  it("H2: billed hours are never below the crew's minimum", () => {
    // 6 m3 -> 1.5 h -> 2 h by handling, but this crew bills at least 4 h: 4 x 800 = 3200
    const card = cardWith({
      crews: [{ id: 'minimum-4h', movers: 2, capacityM3: 15, hourlyRateExVat: 800, minimumHours: 4 }],
    });
    const q = quote(base({ items: [load(6)] }), card);
    expect(q.hours).toBe(4);
    expect(amount(q, 'labour')).toBe(3200);
  });

  it('H3: labour is RUT-eligible', () => {
    expect(quote(base()).rutEligibleIncVat).toBe(1980); // 1584 x 1.25
  });
});

describe('T. travel', () => {
  it('T1: up to and including 20 km costs nothing extra', () => {
    expect(quote(base({ distanceKm: 0 })).totalExVat).toBe(BASE_LABOUR);
    expect(quote(base({ distanceKm: 20 })).totalExVat).toBe(BASE_LABOUR);
  });

  it('T2: only the km above 20 are charged, 15 per km ex VAT, pro rata', () => {
    expect(quote(base({ distanceKm: 21 })).totalExVat).toBe(BASE_LABOUR + 15);
    expect(quote(base({ distanceKm: 20.5 })).totalExVat).toBe(BASE_LABOUR + 7.5);
    expect(quote(base({ distanceKm: 35 })).totalExVat).toBe(BASE_LABOUR + 225);
  });

  it('T2: travel is not RUT-eligible', () => {
    const q = quote(base({ distanceKm: 35 }));
    expect(q.rutEligibleIncVat).toBe(1980);
    expect(q.rutDeduction).toBe(990);
  });

  it('T3: exactly 50 km is not flagged, above 50 km is', () => {
    const at50 = quote(base({ distanceKm: 50 }));
    expect(at50.reviewReasons).not.toContain('distance');
    expect(at50.mode).toBe('fixed');

    const above = quote(base({ distanceKm: 50.1 }));
    expect(above.reviewReasons).toContain('distance');
    expect(above.mode).toBe('manual');
  });

  it('T4: a missing distance is 0 km', () => {
    const q = quote(base({ distanceKm: undefined }));
    expect(q.totalExVat).toBe(BASE_LABOUR);
    expect(q.reviewReasons).not.toContain('distance');
  });
});

describe('S. services', () => {
  it('S1: packing 1500 and cleaning 2000 ex VAT, both RUT-eligible', () => {
    const q = quote(base({ packing: true, cleaning: true }));
    expect(q.totalExVat).toBe(BASE_LABOUR + 1500 + 2000);
    expect(q.rutEligibleIncVat).toBe((BASE_LABOUR + 3500) * 1.25);
  });
});

describe('A. access', () => {
  it('A1+A2: 350 inc VAT (280 ex VAT) per flight without an elevator', () => {
    const q = quote(base({ pickup: { floor: '3', elevator: false } }));
    expect(q.totalExVat).toBe(BASE_LABOUR + 840);
  });

  it('A2: with an elevator, stairs cost nothing whatever the floor', () => {
    const q = quote(base({ pickup: { floor: '9', elevator: true } }));
    expect(q.totalExVat).toBe(BASE_LABOUR);
  });

  it('A1: ground floor in any spelling means no stairs', () => {
    for (const floor of ['ground', '0', '', 'G']) {
      expect(quote(base({ pickup: { floor, elevator: false } })).totalExVat, `floor "${floor}"`).toBe(BASE_LABOUR);
    }
  });

  it('A1: the first whole number in the floor text counts; a basement -1 is one flight', () => {
    expect(quote(base({ pickup: { floor: '4th floor', elevator: false } })).totalExVat).toBe(BASE_LABOUR + 1120);
    expect(quote(base({ pickup: { floor: '-1', elevator: false } })).totalExVat).toBe(BASE_LABOUR + 280);
  });

  it('A3: carry 10-30 m costs 300 inc VAT, over 30 m 700 inc VAT, under 10 m nothing', () => {
    expect(quote(base({ pickup: { carry: '10_30m' } })).totalExVat).toBe(BASE_LABOUR + 240);
    expect(quote(base({ pickup: { carry: 'over_30m' } })).totalExVat).toBe(BASE_LABOUR + 560);
    expect(quote(base({ pickup: { carry: 'under_10m' } })).totalExVat).toBe(BASE_LABOUR);
  });

  it('A4: each end is charged on its own conditions', () => {
    // pickup 2 flights + drop-off 4 flights, no elevators: 6 x 280 = 1680
    const q = quote(base({ pickup: { floor: '2', elevator: false }, dropoff: { floor: '4', elevator: false } }));
    expect(q.totalExVat).toBe(BASE_LABOUR + 1680);

    // only the drop-off is hard: 2 flights (560) + long carry (560)
    const dropoffOnly = quote(base({ dropoff: { floor: '2', elevator: false, carry: 'over_30m' } }));
    expect(dropoffOnly.totalExVat).toBe(BASE_LABOUR + 1120);
  });

  it('A4: access charges are RUT-eligible', () => {
    const q = quote(base({ pickup: { floor: '2', elevator: false }, dropoff: { floor: '4', elevator: false } }));
    expect(q.rutEligibleIncVat).toBe((BASE_LABOUR + 1680) * 1.25);
  });

  it('A5: unsure answers and villas at either end are flagged', () => {
    for (const leg of ['pickup', 'dropoff'] as const) {
      expect(quote(base({ [leg]: { carry: 'unsure' } })).reviewReasons, leg).toContain('carry_unsure');
      expect(quote(base({ [leg]: { stairs: 'unsure' } })).reviewReasons, leg).toContain('stairs_unsure');
      expect(quote(base({ [leg]: { dwelling: 'villa' } })).reviewReasons, leg).toContain('villa');
    }
  });
});

describe('K. heavy and special items', () => {
  it('K1: the heavy flag alone adds 2000 inc VAT (1600 ex VAT), RUT-eligible', () => {
    const q = quote(base({ heavyItems: true }));
    expect(q.totalExVat).toBe(BASE_LABOUR + 1600);
    expect(q.rutEligibleIncVat).toBe((BASE_LABOUR + 1600) * 1.25);
  });

  it('K1: one surcharge however many special items, also combined with the heavy flag', () => {
    expect(quote(base({ specialItems: ['piano', 'safe', 'chandelier'] })).totalExVat).toBe(BASE_LABOUR + 1600);
    expect(quote(base({ heavyItems: true, specialItems: ['piano'] })).totalExVat).toBe(BASE_LABOUR + 1600);
  });

  it('K2: each special item is flagged; the heavy flag alone is flagged as heavy', () => {
    const special = quote(base({ specialItems: ['piano', 'grand_piano'] }));
    expect(special.reviewReasons).toContain('special_piano');
    expect(special.reviewReasons).toContain('special_grand_piano');
    expect(special.mode).toBe('manual');

    expect(quote(base({ heavyItems: true })).reviewReasons).toContain('heavy');
  });
});

describe('P. pensioner discount', () => {
  it('P1: 10 % off the RUT-eligible lines; travel is not discounted', () => {
    // eligible 1584 -> -158.4; travel 10 km x 15 = 150 untouched
    const q = quote(base({ distanceKm: 30, pensioner: true }));
    expect(amount(q, 'pensioner')).toBe(-158.4);
    expect(q.totalExVat).toBe(1575.6); // 1584 + 150 - 158.4
  });

  it('P1: the discount covers every eligible line: labour, services, access, heavy', () => {
    // 1584 + packing 1500 + heavy 1600 + 3 flights 840 = 5524 -> -552.4
    const q = quote(base({ pensioner: true, packing: true, heavyItems: true, pickup: { floor: '3' } }));
    expect(amount(q, 'pensioner')).toBe(-552.4);
    expect(q.totalExVat).toBe(4971.6);
  });

  it('P2: the discount shrinks the RUT base', () => {
    // (1584 - 158.4) x 1.25 = 1782 eligible inc VAT -> RUT 891
    const q = quote(base({ pensioner: true }));
    expect(q.totalIncVat).toBe(1782);
    expect(q.rutEligibleIncVat).toBe(1782);
    expect(q.rutDeduction).toBe(891);
    expect(q.toPay).toBe(891);
  });
});

describe('R. VAT, totals and rounding', () => {
  it('R2: VAT is 25 % of the total ex VAT', () => {
    const q = quote(base());
    expect(q.totalExVat).toBe(1584);
    expect(q.vat).toBe(396);
    expect(q.totalIncVat).toBe(1980);
  });

  it('R1-R3 + U4: amounts are rounded to ore with a VAT rate that does not divide evenly', () => {
    // VAT 12 %: carry 300 / 1.12 = 267.857 -> 267.86; total ex 1584 + 267.86 = 1851.86
    // VAT 1851.86 x 0.12 = 222.2232 -> 222.22; inc 2074.08; eligible inc 2074.0832 -> 2074.08
    // RUT 2074.08 x 0.5 = 1037.04 -> 1037; to pay 1037.08
    const q = quote(base({ pickup: { carry: '10_30m' } }), cardWith({ vatRate: 0.12 }));
    expect(amount(q, 'carry_pickup')).toBe(267.86);
    expect(q.totalExVat).toBe(1851.86);
    expect(q.vat).toBe(222.22);
    expect(q.totalIncVat).toBe(2074.08);
    expect(q.rutEligibleIncVat).toBe(2074.08);
    expect(q.rutDeduction).toBe(1037);
    expect(q.toPay).toBe(1037.08);
  });
});

describe('U. RUT deduction', () => {
  it('U1: only private moves get RUT', () => {
    expect(quote(base({ moveType: 'private' })).rutDeduction).toBe(990);
    expect(quote(base({ moveType: 'office' })).rutDeduction).toBe(0);
    expect(quote(base({ moveType: 'storage' })).rutDeduction).toBe(0);
  });

  it('U1: no RUT when the rate card disables it', () => {
    const card = cardWith({ rut: { ...DEFAULT_RATE_CARD.rut, enabled: false } });
    const q = quote(base(), card);
    expect(q.rutDeduction).toBe(0);
    expect(q.toPay).toBe(q.totalIncVat);
  });

  it('U2: the deduction is 50 % of the eligible amount INCLUDING VAT', () => {
    const q = quote(base());
    expect(q.rutEligibleIncVat).toBe(1980);
    expect(q.rutDeduction).toBe(990);
  });

  it('U3: the deduction is capped at the allowance left', () => {
    expect(quote(base({ rutAllowanceLeft: 500 })).rutDeduction).toBe(500);
    const none = quote(base({ rutAllowanceLeft: 0 }));
    expect(none.rutDeduction).toBe(0);
    expect(none.toPay).toBe(none.totalIncVat);
  });

  it('U3: the cap limits the deduction, it does not shrink the base or raise the deduction', () => {
    expect(quote(base({ rutAllowanceLeft: 1000 })).rutDeduction).toBe(990);
    expect(quote(base({ rutAllowanceLeft: 5000 })).rutDeduction).toBe(990);
  });

  it("U3: without an allowance, one person's annual cap (75 000) applies", () => {
    // 2 h x 100 000 = 200 000 ex VAT -> 250 000 inc VAT -> 50 % = 125 000 -> capped at 75 000
    const card = cardWith({
      crews: [{ id: 'premium', movers: 2, capacityM3: 30, hourlyRateExVat: 100_000, minimumHours: 2 }],
    });
    const q = quote(base(), card);
    expect(q.totalIncVat).toBe(250_000);
    expect(q.rutDeduction).toBe(75_000);
    expect(q.toPay).toBe(175_000);

    // an explicit allowance (e.g. two people sharing the deduction) replaces the default
    expect(quote(base({ rutAllowanceLeft: 100_000 }), card).rutDeduction).toBe(100_000);
  });

  it('U4: the deduction is rounded DOWN to whole kronor', () => {
    // packing: eligible 3084 x 1.25 = 3855 -> 50 % = 1927.5 -> 1927
    const q = quote(base({ packing: true }));
    expect(q.rutDeduction).toBe(1927);
    expect(q.toPay).toBe(1928);
  });

  it('U5: to pay = total inc VAT - deduction', () => {
    const q = quote(base({ distanceKm: 30 }));
    expect(q.toPay).toBe(q.totalIncVat - q.rutDeduction);
    expect(q.toPay).toBe(1177.5);
  });
});

describe('M. quote mode', () => {
  it('M1: a plain private move is fixed with no reasons', () => {
    const q = quote(base());
    expect(q.mode).toBe('fixed');
    expect(q.reviewReasons).toHaveLength(0);
  });

  it('M1: an office move is manual but still priced', () => {
    const q = quote(base({ moveType: 'office' }));
    expect(q.mode).toBe('manual');
    expect(q.reviewReasons).toContain('office');
    expect(q.totalExVat).toBe(BASE_LABOUR);
  });

  it('M1: a flag raised at both ends is listed once', () => {
    const q = quote(base({ pickup: { carry: 'unsure' }, dropoff: { carry: 'unsure' } }));
    expect(q.reviewReasons.filter((reason) => reason === 'carry_unsure')).toHaveLength(1);
  });
});

describe('I. invalid input', () => {
  const rejects = (input: QuoteInput) => expect(() => quote(input)).toThrow(QuoteInputError);

  it('I1: unknown move type', () => {
    rejects(base({ moveType: 'house' as QuoteInput['moveType'] }));
  });

  it('I2: negative, NaN or infinite distance, living area or allowance', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      rejects(base({ distanceKm: bad }));
      rejects(base({ items: [], livingAreaM2: bad }));
      rejects(base({ rutAllowanceLeft: bad }));
    }
  });

  it('I3: bad quantity, volume or load factor on an inventory line', () => {
    for (const quantity of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      rejects(base({ items: [{ name: 'x', quantity, highM3: 1, loadFactor: 1 }] }));
    }
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      rejects(base({ items: [{ name: 'x', quantity: 1, highM3: bad, loadFactor: 1 }] }));
      rejects(base({ items: [{ name: 'x', quantity: 1, highM3: 1, loadFactor: bad }] }));
    }
  });

  it('I4: zero is valid everywhere', () => {
    expect(() =>
      quote(
        base({
          distanceKm: 0,
          livingAreaM2: 0,
          rutAllowanceLeft: 0,
          items: [{ name: 'x', quantity: 0, highM3: 0, loadFactor: 0 }],
        }),
      ),
    ).not.toThrow();
  });
});

describe('combinations', () => {
  // 2.4 + 2 x 2.75 + 35 x 0.1 = 11.4 m3 (wardrobe stays) -> small crew, ceil(2.85) = 3 h -> 2376
  // travel 12.4 km x 15 = 186 (not eligible)
  // pickup 3 flights 840 + carry 240; drop-off has an elevator, long carry 560
  // packing 1500, heavy 1600 -> eligible 2376 + 840 + 240 + 560 + 1500 + 1600 = 7116
  // pensioner -711.6 -> total ex 7116 + 186 - 711.6 = 6590.4, VAT 1647.6, inc 8238
  // eligible inc (7116 - 711.6) x 1.25 = 8005.5 -> RUT 4002.75 -> 4002 -> to pay 4236
  const fullMove = (overrides: Partial<QuoteInput> = {}): QuoteInput => ({
    moveType: 'private',
    items: [
      { name: 'sofa', quantity: 1, highM3: 2.0, loadFactor: 1.2 },
      { name: 'bed', quantity: 2, highM3: 2.5, loadFactor: 1.1 },
      { name: 'box', quantity: 35, highM3: 0.1, loadFactor: 1.0 },
      { name: 'wardrobe', quantity: 1, highM3: 1.8, loadFactor: 1.1, moving: false },
    ],
    distanceKm: 32.4,
    pickup: { floor: '3', elevator: false, carry: '10_30m' },
    dropoff: { floor: '1', elevator: true, carry: 'over_30m' },
    packing: true,
    heavyItems: true,
    pensioner: true,
    ...overrides,
  });

  it('prices a full private move end to end', () => {
    const q = quote(fullMove());
    expect(q.volumeM3).toBe(11.4);
    expect(q.crewId).toBe('crew-2m-15m3');
    expect(q.hours).toBe(3);
    expect(q.totalExVat).toBe(6590.4);
    expect(q.vat).toBe(1647.6);
    expect(q.totalIncVat).toBe(8238);
    expect(q.rutEligibleIncVat).toBe(8005.5);
    expect(q.rutDeduction).toBe(4002);
    expect(q.toPay).toBe(4236);
    expect(q.mode).toBe('manual');
    expect(q.reviewReasons).toContain('heavy');
  });

  it('caps the same move at a fractional allowance, then rounds down', () => {
    const q = quote(fullMove({ rutAllowanceLeft: 3000.5 }));
    expect(q.rutDeduction).toBe(3000);
    expect(q.toPay).toBe(5238);
  });

  it('prices the same move for an office: no RUT, office and heavy flags', () => {
    const q = quote(fullMove({ moveType: 'office' }));
    expect(q.totalIncVat).toBe(8238);
    expect(q.rutDeduction).toBe(0);
    expect(q.toPay).toBe(8238);
    expect(q.reviewReasons).toContain('office');
    expect(q.reviewReasons).toContain('heavy');
  });
});
