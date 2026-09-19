/**
 * Turns what an operator types at the pairing prompt into the digits WhatsApp
 * expects, catching the usual mistakes before a pairing code is requested:
 * WhatsApp shows only "couldn't link device, check the phone number" when the
 * digits don't match the account the code is entered on.
 */
export type PairingNumber = { digits: string; display: string } | { error: string };

export function normalizePairingNumber(input: string): PairingNumber {
  const digits = input.replace(/[\s()+.-]/g, "");
  if (!/^\d+$/.test(digits)) return { error: "Use digits only, e.g. 61412345678." };
  if (digits.startsWith("0")) {
    return { error: "Start with the country code instead of 0, e.g. 61412345678 for 0412 345 678." };
  }
  if (digits.startsWith("610")) {
    return { error: "Drop the 0 after 61: 0412 345 678 becomes 61412345678." };
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return { error: "That is not a full international number." };
  const display = digits.startsWith("61") && digits.length === 11
    ? `+61 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
    : `+${digits}`;
  return { digits, display };
}
