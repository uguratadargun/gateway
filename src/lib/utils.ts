import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Strip terminal colour codes.
 *
 * Test runners and build tools colour their output, and the escape codes make
 * a failing suite unreadable in a browser. Defined once: a copy of this that
 * loses the leading escape byte still matches, and quietly eats "[0m]" out of
 * ordinary text instead of colour codes.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
