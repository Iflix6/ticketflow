/**
 * Exact decimal money on strings (never floats).
 *
 * Prices are `numeric(12,2)` in PostgreSQL and `moneyStringSchema` (`\d+(\.\d{1,2})?`) on the wire.
 * Node has no fixed-point type, so the only safe arithmetic is through integer cents: parse to cents,
 * multiply by an integer quantity, re-format. This keeps a booking total byte-identical to what
 * `price * quantity` would be in SQL, so the amount recorded in `bookings.total_amount` can never
 * drift from the tier price because of binary floating-point rounding.
 *
 * Everything here is display/ledger math for the fake provider. No real currency conversion, and the
 * value is never taken from a client (spec: the server never accepts a price).
 */

const PRICE_PATTERN = /^\d+(\.\d{1,2})?$/;

/** `"10.00"` -> `1000` cents. Throws on a malformed price (a corrupt row, not a client error). */
export function toCents(price: string): number {
  if (!PRICE_PATTERN.test(price)) throw new Error(`invalid money value: ${price}`);
  const [units, fraction = ''] = price.split('.');
  const unitsCents = Number(units) * 100;
  const padded = (fraction + '00').slice(0, 2);
  return unitsCents + Number(padded);
}

/** `1000` cents -> `"10.00"`. */
export function fromCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`cents must be a safe integer: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const units = Math.floor(abs / 100).toString();
  const fraction = (abs % 100).toString().padStart(2, '0');
  return `${sign}${units}.${fraction}`;
}

/** Total for `quantity` units at `price` each, as an exact 2-decimal string. */
export function multiplyMoneyByInt(price: string, quantity: number): string {
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error(`invalid quantity: ${quantity}`);
  return fromCents(toCents(price) * quantity);
}
