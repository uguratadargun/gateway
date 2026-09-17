/**
 * The rows gate writes into Claude Code's `/model` picker.
 *
 * A provider model is addressable the moment a provider exists — `/model
 * provider:zai/glm-5.3` resolves on the first step of the router — but
 * nothing in Claude Code lists it, so the person has to know the reference
 * by heart. Its own gateway discovery does not help: it reads `/v1/models`
 * and then keeps only the entries whose id contains `claude` or `anthropic`,
 * which every provider reference fails. So gate writes the rows itself.
 *
 * The shape is the client's, validated by it as
 * `{ model, label?, description?, behavesAs? }` rows under `modelPicker`.
 * `behavesAs` is not decoration: without it Claude Code answers that the id
 * "isn't described by this version's model catalog" and the row is inert.
 *
 * `replaceBuiltInOptions` is never written. It is the caller's to set, and
 * true would take the built-in Claude rows away — gate adds models here, it
 * does not remove the ones someone else put in front of the person.
 *
 * Pure on purpose: the gate writes these rows from its own database, and the
 * CLI on a developer's machine writes the same rows from what the gateway's
 * `/v1/models` told it. Only the source differs.
 */

/** A row as Claude Code validates it. */
export interface PickerRow {
  model: string;
  label?: string;
  description?: string;
  behavesAs?: string;
}

/** What a catalogue entry has to carry for a row to be built from it. */
export interface CatalogueEntry {
  id: string;
  display_name?: string;
  description?: string;
}

/**
 * The model whose client-side profile an unrecognised id borrows: context
 * window, effort defaults, capabilities. Sonnet, because it is the middle of
 * the range in every one of them — a provider model given Haiku's profile
 * would be compacted early, and given Opus's would be sent thinking it does
 * not accept.
 */
export const PICKER_BEHAVES_AS = "claude-sonnet-5";

const GATE_PREFIXES = ["provider:", "local:"];

/**
 * Whether this id names a provider endpoint — `local:` is the pre-0.30
 * spelling, which still parses everywhere else and so is recognised here too.
 * Stated without `parseProviderRef` on purpose: this module is bundled into
 * the CLI, which has no database to reach for.
 */
export function isProviderModelId(id: unknown): boolean {
  return typeof id === "string" && GATE_PREFIXES.some((p) => id.startsWith(p));
}

/** Whether this row is one gate wrote. */
export function isGateRow(row: unknown): boolean {
  return isProviderModelId((row as PickerRow | null)?.model);
}

export function pickerRow(entry: CatalogueEntry): PickerRow {
  return {
    model: entry.id,
    label: entry.display_name || entry.id,
    ...(entry.description ? { description: entry.description } : {}),
    behavesAs: PICKER_BEHAVES_AS,
  };
}

function readOptions(settings: Record<string, unknown>): { picker: Record<string, unknown>; options: unknown[] } {
  const picker = (settings.modelPicker && typeof settings.modelPicker === "object" && !Array.isArray(settings.modelPicker)
    ? (settings.modelPicker as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  return { picker, options: Array.isArray(picker.options) ? (picker.options as unknown[]) : [] };
}

/**
 * Puts these rows in the settings object, in place of the ones gate wrote
 * last time and after every row somebody else did. Mutates and returns it.
 */
export function withPickerRows(settings: Record<string, unknown>, rows: PickerRow[]): Record<string, unknown> {
  const { picker, options } = readOptions(settings);
  const foreign = options.filter((row) => !isGateRow(row));
  const next = [...foreign, ...rows];
  if (next.length) settings.modelPicker = { ...picker, options: next };
  else delete settings.modelPicker;
  return settings;
}

/** Takes gate's rows out again, leaving every other row and key as it was. */
export function withoutPickerRows(settings: Record<string, unknown>): Record<string, unknown> {
  if (!settings.modelPicker) return settings;
  const { picker, options } = readOptions(settings);
  const foreign = options.filter((row) => !isGateRow(row));
  if (foreign.length) settings.modelPicker = { ...picker, options: foreign };
  else delete settings.modelPicker;
  return settings;
}
