// First-pass suite. Tests 1-14 are the original project's pricing tests, ported scenario by
// scenario to the self-contained API (same inputs, same expected numbers). Tests 15-17 cover the
// three features this version added, written the same quick way: one typical case each.
import { describe, it, expect } from 'vitest';
import { quote, QuoteInputError, type QuoteInput } from '../src/quote';

// The original tests put a volume straight on the assessment; here that is one inventory line.
const volume = (m3: number) => [{ name: 'inventory', quantity: 1, highM3: m3, loadFactor: 1 }];

const defaultAccess = { floor: '1', elevator: true, stairs: 'standard', carry: 'under_10m' } as const;

const makeInput = (overrides: Partial<QuoteInput> = {}): QuoteInput => ({
  moveType: 'private',
  items: volume(5),
  distanceKm: 20,
  pickup: defaultAccess,
  dropoff: defaultAccess,
  ...overrides,
});

describe('Pricing Engine', () => {
  it('calculates minimum charge correctly (minimum 2 hours for small volume)', () => {
    const q = quote(makeInput({ items: volume(2) }));

    expect(q.hours).toBe(2);
    expect(q.crewId).toBe('crew-2m-15m3');
    expect(q.totalExVat).toBe(1584);
  });

  it('switches to Crew 2 for volumes over 15m3 and applies 3 hour minimum', () => {
    const q = quote(makeInput({ items: volume(20) }));

    expect(q.crewId).toBe('crew-3m-25m3');
    expect(q.hours).toBe(5);
    expect(q.totalExVat).toBe(5600);
  });

  it('correctly calculates VAT rules (25%)', () => {
    const q = quote(makeInput({ items: volume(5) }));

    expect(q.totalExVat).toBe(1584);
    expect(q.vat).toBe(396);
    expect(q.totalIncVat).toBe(1980);
  });

  it('applies RUT deduction correctly for private moves', () => {
    const q = quote(makeInput({ items: volume(5) }));

    expect(q.rutEligibleIncVat).toBe(1980);
    expect(q.rutDeduction).toBe(990);
    expect(q.toPay).toBe(990);
  });

  it('does not apply RUT deduction for office moves', () => {
    const q = quote(makeInput({ moveType: 'office' }));

    expect(q.rutDeduction).toBe(0);
    expect(q.toPay).toBe(q.totalIncVat);
    expect(q.mode).toBe('manual');
    expect(q.reviewReasons).toContain('office');
  });

  it('mixes RUT eligible (labor) and non-eligible (travel) costs correctly', () => {
    const q = quote(makeInput({ items: volume(5), distanceKm: 30 }));

    expect(q.totalExVat).toBe(1734);
    expect(q.totalIncVat).toBe(2167.5);
    expect(q.rutEligibleIncVat).toBe(1980);
    expect(q.rutDeduction).toBe(990);
    expect(q.toPay).toBe(1177.5);
  });

  it('includes packing service correctly in RUT calculations', () => {
    const q = quote(makeInput({ items: volume(5), packing: true }));

    expect(q.totalExVat).toBe(3084);
    expect(q.totalIncVat).toBe(3855);
    expect(q.rutEligibleIncVat).toBe(3855);
    expect(q.rutDeduction).toBe(1927);
    expect(q.toPay).toBe(1928);
  });

  it('triggers manual review mode for heavy items', () => {
    const q = quote(makeInput({ heavyItems: true }));

    expect(q.mode).toBe('manual');
    expect(q.reviewReasons).toContain('heavy');
  });

  it('calculates access surcharges for both ends (split model)', () => {
    const q = quote(
      makeInput({
        items: volume(5),
        pickup: { floor: '3', elevator: false, dwelling: 'apartment', stairs: 'standard', carry: '10_30m' },
        dropoff: { floor: '2', elevator: false, dwelling: 'apartment', stairs: 'standard', carry: 'under_10m' },
      }),
    );

    expect(q.totalExVat).toBe(3224);
    expect(q.totalIncVat).toBe(4030);
    expect(q.rutEligibleIncVat).toBe(4030);
  });

  it('triggers manual review if carry distance is unsure at either end', () => {
    const q = quote(
      makeInput({
        pickup: { floor: '0', elevator: true, dwelling: 'apartment', stairs: 'standard', carry: 'under_10m' },
        dropoff: { floor: '0', elevator: true, dwelling: 'apartment', stairs: 'standard', carry: 'unsure' },
      }),
    );

    expect(q.mode).toBe('manual');
    expect(q.reviewReasons).toContain('carry_unsure');
  });

  it('triggers manual review and +2000 surcharge once for specialItems', () => {
    const q = quote(makeInput({ items: volume(5), specialItems: ['piano', 'safe'] }));

    expect(q.totalExVat).toBe(3184); // 1584 labour + 1600 special (2000 inc VAT)
    expect(q.mode).toBe('manual');
    expect(q.reviewReasons).toContain('special_piano');
    expect(q.reviewReasons).toContain('special_safe');
  });

  it('flags villa at either end for manual review', () => {
    const q = quote(
      makeInput({
        pickup: { floor: '1', elevator: true, dwelling: 'apartment', stairs: 'standard', carry: 'under_10m' },
        dropoff: { floor: 'ground', elevator: true, dwelling: 'villa', stairs: 'standard', carry: 'under_10m' },
      }),
    );
    expect(q.mode).toBe('manual');
    expect(q.reviewReasons).toContain('villa');
  });

  it('flags long distance (>50km) for manual review', () => {
    const q = quote(makeInput({ distanceKm: 80 }));
    expect(q.mode).toBe('manual');
    expect(q.reviewReasons).toContain('distance');
  });

  it('pensioner discount applies to labour (RUT-eligible) lines only', () => {
    const q = quote(makeInput({ distanceKm: 30, pensioner: true })); // travel: 10 km x 15 = 150 ex VAT
    const discount = q.lines.find((line) => line.code === 'pensioner');
    expect(discount).toBeDefined();
    // labour base = 1584 ex VAT; travel 150 must NOT be discounted
    expect(discount!.amountExVat).toBeCloseTo(-158.4, 1);
    expect(discount!.rutEligible).toBe(true);
  });

  it('sums inventory volume from the item list', () => {
    const q = quote(
      makeInput({
        items: [
          { name: 'sofa', quantity: 1, highM3: 2.0, loadFactor: 1.2 },
          { name: 'moving box', quantity: 30, highM3: 0.1, loadFactor: 1.0 },
          { name: 'double bed', quantity: 1, highM3: 2.5, loadFactor: 1.1 },
        ],
      }),
    );

    expect(q.volumeM3).toBe(8.15);
    expect(q.hours).toBe(3);
  });

  it('caps the RUT deduction at the allowance left', () => {
    const q = quote(makeInput({ rutAllowanceLeft: 500 }));

    expect(q.rutDeduction).toBe(500);
    expect(q.toPay).toBe(1480);
  });

  it('rejects a negative distance', () => {
    expect(() => quote(makeInput({ distanceKm: -5 }))).toThrow(QuoteInputError);
  });
});
