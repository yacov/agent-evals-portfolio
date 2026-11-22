# Quote engine: required behaviour

`quote(input, rateCard?)` in `src/quote.ts` prices a household or office move. This document is the
reference the behaviour suite is written against. Each rule has an ID; `tests/behaviour.test.ts`
names the rule each test pins.

Amounts are in SEK. "ex VAT" and "inc VAT" are stated on every figure because mixing them up is a
classic pricing bug.

## Default rate card

| Setting | Value |
|---|---|
| VAT rate | 25 % |
| Handling time | 15 minutes per m3 |
| Small crew `crew-2m-15m3` | 2 movers, 15 m3 truck, 792 ex VAT per hour, minimum 2 hours |
| Large crew `crew-3m-25m3` | 3 movers, 25 m3 truck, 1 120 ex VAT per hour, minimum 3 hours |
| RUT | enabled, rate 50 %, annual cap 75 000 per person |

A caller may pass its own rate card. Every rule below that mentions the rate card must hold for
any valid card, not only the default.

## Fixed prices (not configurable)

| Item | Price |
|---|---|
| Free distance | first 20 km |
| Distance beyond 20 km | 15 per km ex VAT |
| Packing service | 1 500 ex VAT (flat) |
| Move-out cleaning | 2 000 ex VAT (flat) |
| Stairs without an elevator | 350 inc VAT per flight, per end of the move |
| Carry distance 10 to 30 m | 300 inc VAT, per end |
| Carry distance over 30 m | 700 inc VAT, per end |
| Heavy or special items | 2 000 inc VAT, once per move |
| Pensioner discount | 10 % of the RUT-eligible lines |

## V. Volume

- **V1** Each inventory line counts `round(highM3 * loadFactor, 2 decimals) * quantity` m3.
- **V2** Lines with `moving: false` count nothing. Lines without the field are moving.
- **V3** The inventory volume is the sum of V1 over the moving lines, rounded to 2 decimals.
- **V4** If the inventory volume is 0 (no lines, all staying, or all quantity 0), the volume is
  estimated from the living area: `livingAreaM2 * 0.35`, rounded to 1 decimal (halves up).
  The living area is ignored whenever the inventory volume is above 0.
- **V5** The billable volume (`volumeM3` in the result) is never below 5 m3. This minimum also
  applies when a small inventory was measured, not only when nothing was measured.

## C. Crew

- **C1** The crew is the one with the smallest truck capacity that is greater than or equal to the
  billable volume. A volume exactly equal to a capacity fits that truck.
- **C2** The rate card's crew order does not matter.
- **C3** If the volume is above the largest capacity, the largest crew is used and the quote is
  flagged `volume_over_capacity`. A volume exactly equal to the largest capacity is not flagged.

## H. Hours and labour

- **H1** Handling hours = `volume * handlingMinutesPerM3 / 60`, rounded UP to a whole hour.
- **H2** Billed hours are never below the chosen crew's `minimumHours`.
- **H3** Labour = billed hours * crew hourly rate (ex VAT). Labour is RUT-eligible.

## T. Travel

- **T1** Distances up to and including 20 km cost nothing extra.
- **T2** Beyond 20 km, only the part above 20 km is charged, at 15 per km ex VAT, pro rata for
  fractions of a km. Travel is NOT RUT-eligible.
- **T3** A distance above 50 km flags `distance`. Exactly 50 km is not flagged.
- **T4** A missing distance means 0 km.

## S. Services

- **S1** Packing (1 500 ex VAT) and cleaning (2 000 ex VAT) are added when requested. Both are
  RUT-eligible.

## A. Access (applied to pickup and drop-off independently)

- **A1** Flights of stairs = the first whole number in the floor text, sign ignored (a basement
  written `-1` is one flight). Text with no number (`ground`, empty) and `0` mean no stairs.
- **A2** Stairs cost 350 inc VAT per flight, only when there is no elevator. With an elevator,
  stairs cost nothing whatever the floor.
- **A3** Carry distance `10_30m` costs 300 inc VAT; `over_30m` costs 700 inc VAT; `under_10m` and a
  missing value cost nothing.
- **A4** All access charges are RUT-eligible. Each end is charged on its own conditions.
- **A5** At either end: carry `unsure` flags `carry_unsure`; stairs `unsure` flags
  `stairs_unsure`; dwelling `villa` flags `villa`.

## K. Heavy and special items

- **K1** If `heavyItems` is true or `specialItems` is non-empty, ONE surcharge of 2 000 inc VAT is
  added, however many items there are. It is RUT-eligible.
- **K2** Each special item flags `special_<item>`. If there are no special items but `heavyItems`
  is true, the quote is flagged `heavy`.

## P. Pensioner discount

- **P1** For pensioners, a discount of 10 % of the sum of all other RUT-eligible lines (ex VAT) is
  added as a negative line. Lines that are not RUT-eligible (travel) are not discounted.
- **P2** The discount line itself is RUT-eligible, so it reduces the RUT base: you can only deduct
  what you pay.

## R. VAT, totals and rounding

- **R1** Every line amount is rounded to whole ore (2 decimals), halves away from zero.
- **R2** `totalExVat` = sum of the lines. `vat` = `totalExVat * vatRate`, rounded to 2 decimals.
  `totalIncVat` = `totalExVat + vat`.
- **R3** `rutEligibleIncVat` = sum of the RUT-eligible lines * (1 + vatRate), rounded to 2 decimals.

## U. RUT deduction

- **U1** Only `private` moves get a RUT deduction, and only when the rate card enables RUT.
  `office` and `storage` moves get 0.
- **U2** Deduction = `rate * rutEligibleIncVat` (the base is inc VAT; travel is excluded by T2).
- **U3** The deduction is capped at the allowance the customer has left this year
  (`rutAllowanceLeft`). If the caller does not say, the allowance is one person's annual cap from
  the rate card (75 000 by default). The cap limits the deduction; it never raises it.
- **U4** The deduction is rounded DOWN to whole kronor, so the quote never promises more tax
  relief than the customer can get.
- **U5** `toPay` = `totalIncVat - rutDeduction`, never below 0.

## M. Quote mode

- **M1** `mode` is `manual` if any review flag was raised (including `office` for office moves),
  otherwise `fixed`. `reviewReasons` lists each flag once. Pricing is still computed for manual
  quotes: a manual flag asks a person to check the price, it does not block it.

## I. Invalid input

`quote` throws `QuoteInputError` (a `RangeError`) and returns nothing when:

- **I1** `moveType` is not `private`, `office` or `storage`.
- **I2** `distanceKm`, `livingAreaM2` or `rutAllowanceLeft` is negative, `NaN` or infinite.
- **I3** An inventory line has a quantity that is negative, fractional, `NaN` or infinite, or a
  `highM3` or `loadFactor` that is negative, `NaN` or infinite.
- **I4** Zero is valid for every number above (0 km, 0 m2, quantity 0, allowance 0).

## Not specified (free for implementations)

Tests must not pin these, or they would reject correct implementations:

- the order of `lines` and of `reviewReasons`;
- whether a zero-amount line is emitted;
- the wording of error messages;
- internal helper functions and constants.
