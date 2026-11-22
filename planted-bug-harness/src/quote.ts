/**
 * Quote engine for a moving company.
 *
 * Pipeline: inventory -> billable volume -> crew -> hours -> price lines -> VAT -> RUT deduction.
 *
 * This is the pricing logic of a production moving-company quoting tool, copied out of the app
 * and made self-contained (no UI, database, maps or ID generation). SPEC.md is the source of
 * truth for REQUIRED behaviour. Short version of the contract:
 *
 *  - Volume: each moving inventory line counts round2(highM3 * loadFactor) * quantity m3; lines
 *    with moving === false are ignored. With no inventory volume, living area * 0.35 m3/m2
 *    (rounded to 0.1). The billable volume is never below 5 m3.
 *  - Crew: the smallest crew whose truck capacity >= volume (inclusive). Above the largest
 *    capacity: largest crew plus a manual-review flag.
 *  - Hours: ceil(volume * handlingMinutesPerM3 / 60), never below the crew's minimum hours.
 *  - Travel: the first 20 km are free; each km beyond costs 15 SEK ex VAT; not RUT-eligible.
 *    More than 50 km -> manual review.
 *  - Access, per leg: 350 SEK inc VAT per flight of stairs without an elevator; carry
 *    distance 10-30 m 300 SEK inc VAT, over 30 m 700 SEK inc VAT. "unsure" answers and villas
 *    -> manual review.
 *  - Heavy / special items: one 2000 SEK inc VAT surcharge, however many items.
 *  - Pensioner: -10 % of the RUT-eligible lines (ex VAT); the discount line is RUT-eligible.
 *  - VAT 25 %. Money is rounded to whole ore (2 decimals), halves away from zero.
 *  - RUT (private moves only): 50 % of RUT-eligible amount inc VAT, capped at the allowance
 *    the customer has left this year (default: one person's annual cap, 75 000 SEK),
 *    rounded DOWN to whole kronor.
 *  - Invalid input (negative, NaN or infinite numbers, fractional quantities, unknown move
 *    type) throws QuoteInputError. Zero is valid everywhere.
 */

export type MoveType = 'private' | 'office' | 'storage';
export type DwellingType = 'apartment' | 'townhouse' | 'villa' | 'other';
export type StairsType = 'standard' | 'narrow' | 'spiral' | 'unsure';
export type CarryDistance = 'under_10m' | '10_30m' | 'over_30m' | 'unsure';
export type SpecialItem = 'piano' | 'grand_piano' | 'safe' | 'chandelier' | 'other_heavy';

/** Access conditions at one end of the move (pickup or drop-off). */
export interface Access {
  /** Free text as typed by the customer: 'ground', '0', '3', '3rd', '-1' (basement). */
  floor?: string;
  elevator?: boolean;
  dwelling?: DwellingType;
  stairs?: StairsType;
  /** Distance from the truck to the entrance. */
  carry?: CarryDistance;
}

/** One inventory line, usually produced by matching a photographed item to a catalog entry. */
export interface InventoryLine {
  name: string;
  /** Whole pieces, 0 or more. */
  quantity: number;
  /** Upper volume estimate for one piece, m3 (from the catalog). */
  highM3: number;
  /** Slack the piece needs in the truck, e.g. 1.1 (from the catalog). */
  loadFactor: number;
  /** false = stays behind (built-in appliance, customer keeps it). Default: moving. */
  moving?: boolean;
}

export interface QuoteInput {
  moveType: MoveType;
  items?: InventoryLine[];
  /** Used only when the inventory gives no volume. */
  livingAreaM2?: number;
  /** Driving distance pickup -> drop-off. Missing = 0. */
  distanceKm?: number;
  pickup?: Access;
  dropoff?: Access;
  packing?: boolean;
  cleaning?: boolean;
  heavyItems?: boolean;
  specialItems?: SpecialItem[];
  pensioner?: boolean;
  /** RUT allowance the customer still has this year, SEK. Missing = rateCard.rut.annualCapPerPerson. */
  rutAllowanceLeft?: number;
}

export interface Crew {
  id: string;
  movers: number;
  capacityM3: number;
  hourlyRateExVat: number;
  minimumHours: number;
}

export interface RateCard {
  currency: 'SEK';
  vatRate: number;
  handlingMinutesPerM3: number;
  crews: Crew[];
  rut: { enabled: boolean; rate: number; annualCapPerPerson: number };
}

export interface PriceLine {
  /** labour | travel | packing | cleaning | stairs_<leg> | carry_<leg> | carry_long_<leg> | heavy | pensioner */
  code: string;
  amountExVat: number;
  rutEligible: boolean;
}

export interface Quote {
  /** Billable volume used for crew choice and hours, m3. */
  volumeM3: number;
  crewId: string;
  hours: number;
  lines: PriceLine[];
  totalExVat: number;
  vat: number;
  totalIncVat: number;
  rutEligibleIncVat: number;
  rutDeduction: number;
  toPay: number;
  mode: 'fixed' | 'manual';
  reviewReasons: string[];
}

export class QuoteInputError extends RangeError {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'QuoteInputError';
    this.field = field;
  }
}

export const DEFAULT_RATE_CARD: RateCard = {
  currency: 'SEK',
  vatRate: 0.25,
  handlingMinutesPerM3: 15,
  crews: [
    { id: 'crew-2m-15m3', movers: 2, capacityM3: 15, hourlyRateExVat: 792, minimumHours: 2 },
    { id: 'crew-3m-25m3', movers: 3, capacityM3: 25, hourlyRateExVat: 1120, minimumHours: 3 },
  ],
  rut: { enabled: true, rate: 0.5, annualCapPerPerson: 75_000 },
};

const MIN_BILLABLE_M3 = 5;
const AREA_TO_M3 = 0.35;
const FREE_KM = 20;
const PER_KM_EX_VAT = 15;
const REVIEW_DISTANCE_KM = 50;
const PACKING_EX_VAT = 1500;
const CLEANING_EX_VAT = 2000;
const STAIRS_PER_FLIGHT_INC_VAT = 350;
const CARRY_10_30M_INC_VAT = 300;
const CARRY_OVER_30M_INC_VAT = 700;
const HEAVY_INC_VAT = 2000;
const PENSIONER_DISCOUNT = 0.1;
const MOVE_TYPES: readonly MoveType[] = ['private', 'office', 'storage'];

/** Round to `decimals`, halves away from zero; toPrecision absorbs binary noise (1.005 -> 1.01). */
function roundTo(value: number, decimals: number): number {
  const scaled = Number((Math.abs(value) * 10 ** decimals).toPrecision(12));
  const rounded = Math.round(scaled) / 10 ** decimals;
  return value < 0 ? -rounded : rounded;
}

const money = (value: number) => roundTo(value, 2);
const sumExVat = (lines: PriceLine[]) => lines.reduce((sum, line) => sum + line.amountExVat, 0);

function requireNonNegative(field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!(Number.isFinite(value) && value >= 0)) {
    throw new QuoteInputError(field, 'must be a finite number >= 0');
  }
}

function validate(input: QuoteInput): void {
  if (!MOVE_TYPES.includes(input.moveType)) {
    throw new QuoteInputError('moveType', `unknown move type "${String(input.moveType)}"`);
  }
  requireNonNegative('distanceKm', input.distanceKm);
  requireNonNegative('livingAreaM2', input.livingAreaM2);
  requireNonNegative('rutAllowanceLeft', input.rutAllowanceLeft);
  (input.items ?? []).forEach((item, i) => {
    if (!Number.isInteger(item.quantity) || item.quantity < 0) {
      throw new QuoteInputError(`items[${i}].quantity`, 'must be a whole number >= 0');
    }
    requireNonNegative(`items[${i}].highM3`, item.highM3);
    requireNonNegative(`items[${i}].loadFactor`, item.loadFactor);
  });
}

/** Volume the crew and hours are planned for, m3. */
function billableVolume(input: QuoteInput): number {
  const inventoryM3 = roundTo(
    (input.items ?? [])
      .filter((item) => item.moving !== false)
      .reduce((sum, item) => sum + roundTo(item.highM3 * item.loadFactor, 2) * item.quantity, 0),
    2,
  );
  const areaM3 = input.livingAreaM2 ? roundTo(input.livingAreaM2 * AREA_TO_M3, 1) : 0;
  const measured = inventoryM3 > 0 ? inventoryM3 : areaM3;
  return Math.max(measured, MIN_BILLABLE_M3);
}

/** Flights of stairs implied by the floor text: the first whole number, sign ignored (basement -1 = 1). */
function flightsOfStairs(floor: string | undefined): number {
  const match = (floor ?? '').match(/-?\d+/);
  return match ? Math.abs(parseInt(match[0], 10)) : 0;
}

export function quote(input: QuoteInput, rateCard: RateCard = DEFAULT_RATE_CARD): Quote {
  validate(input);

  const reviewReasons: string[] = [];
  const flag = (reason: string) => {
    if (!reviewReasons.includes(reason)) reviewReasons.push(reason);
  };
  const lines: PriceLine[] = [];
  const addLine = (code: string, amountExVat: number, rutEligible: boolean) => {
    lines.push({ code, amountExVat: money(amountExVat), rutEligible });
  };
  const exVat = (incVat: number) => incVat / (1 + rateCard.vatRate);

  if (input.moveType === 'office') flag('office');

  // Volume, crew, hours
  const volumeM3 = billableVolume(input);
  const crews = [...rateCard.crews].sort((a, b) => a.capacityM3 - b.capacityM3);
  const largest = crews[crews.length - 1];
  const crew = crews.find((c) => volumeM3 <= c.capacityM3) ?? largest;
  if (volumeM3 > largest.capacityM3) flag('volume_over_capacity');

  const handlingHours = Math.ceil((volumeM3 * rateCard.handlingMinutesPerM3) / 60);
  const hours = Math.max(crew.minimumHours, handlingHours);
  addLine('labour', hours * crew.hourlyRateExVat, true);

  // Travel
  const distanceKm = input.distanceKm ?? 0;
  if (distanceKm > FREE_KM) addLine('travel', (distanceKm - FREE_KM) * PER_KM_EX_VAT, false);
  if (distanceKm > REVIEW_DISTANCE_KM) flag('distance');

  // Services
  if (input.packing) addLine('packing', PACKING_EX_VAT, true);
  if (input.cleaning) addLine('cleaning', CLEANING_EX_VAT, true);

  // Access at both ends
  const legs: Array<[string, Access]> = [
    ['pickup', input.pickup ?? {}],
    ['dropoff', input.dropoff ?? {}],
  ];
  for (const [leg, access] of legs) {
    const flights = flightsOfStairs(access.floor);
    if (flights > 0 && !access.elevator) {
      addLine(`stairs_${leg}`, exVat(flights * STAIRS_PER_FLIGHT_INC_VAT), true);
    }
    if (access.carry === '10_30m') addLine(`carry_${leg}`, exVat(CARRY_10_30M_INC_VAT), true);
    else if (access.carry === 'over_30m') addLine(`carry_long_${leg}`, exVat(CARRY_OVER_30M_INC_VAT), true);

    if (access.carry === 'unsure') flag('carry_unsure');
    if (access.stairs === 'unsure') flag('stairs_unsure');
    if (access.dwelling === 'villa') flag('villa');
  }

  // Heavy and special items: reviewed by a person, one surcharge per move
  const specialItems = input.specialItems ?? [];
  if (specialItems.length > 0) specialItems.forEach((item) => flag(`special_${item}`));
  else if (input.heavyItems) flag('heavy');
  if (input.heavyItems || specialItems.length > 0) addLine('heavy', exVat(HEAVY_INC_VAT), true);

  // Pensioner discount: on the labour (RUT-eligible) part only; shrinks the RUT base with it
  if (input.pensioner) {
    const eligibleExVat = sumExVat(lines.filter((line) => line.rutEligible));
    addLine('pensioner', -eligibleExVat * PENSIONER_DISCOUNT, true);
  }

  // Totals
  const totalExVat = money(sumExVat(lines));
  const vat = money(totalExVat * rateCard.vatRate);
  const totalIncVat = money(totalExVat + vat);
  const rutEligibleIncVat = money(sumExVat(lines.filter((line) => line.rutEligible)) * (1 + rateCard.vatRate));

  let rutDeduction = 0;
  if (rateCard.rut.enabled && input.moveType === 'private') {
    const allowance = input.rutAllowanceLeft ?? rateCard.rut.annualCapPerPerson;
    rutDeduction = Math.floor(Math.min(rutEligibleIncVat * rateCard.rut.rate, allowance));
  }
  const toPay = money(Math.max(0, totalIncVat - rutDeduction));

  return {
    volumeM3,
    crewId: crew.id,
    hours,
    lines,
    totalExVat,
    vat,
    totalIncVat,
    rutEligibleIncVat,
    rutDeduction,
    toPay,
    mode: reviewReasons.length > 0 ? 'manual' : 'fixed',
    reviewReasons,
  };
}
