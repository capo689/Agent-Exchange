const USDC_SCALE = 1_000_000n;

export function parseUsdc(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,6})?$/.test(value)) {
    throw new Error(`Invalid USDC decimal: ${value}`);
  }

  const [whole, fractional = ''] = value.split('.');
  return BigInt(whole) * USDC_SCALE + BigInt(fractional.padEnd(6, '0'));
}

export function formatUsdc(micros) {
  const rawValue = BigInt(micros);
  const negative = rawValue < 0n;
  const value = negative ? -rawValue : rawValue;
  const whole = value / USDC_SCALE;
  const fractional = (value % USDC_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  const formatted = fractional ? `${whole}.${fractional}` : `${whole}.00`;
  return negative ? `-${formatted}` : formatted;
}

export function compareUsdc(a, b) {
  const left = parseUsdc(a);
  const right = parseUsdc(b);
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

export function multiplyUnitPrice(unitPriceUsdc, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('quantity must be a positive integer');
  }

  return formatUsdc(parseUsdc(unitPriceUsdc) * BigInt(quantity));
}

export function subtractUsdc(a, b) {
  return formatUsdc(parseUsdc(a) - parseUsdc(b));
}

export function addUsdc(a, b) {
  return formatUsdc(parseUsdc(a) + parseUsdc(b));
}
