// SPDX-License-Identifier: LGPL-3.0-or-later
import * as io from 'ioium';
import { getByString } from 'utilium';
import { loaded, type Key, type Keys, type Value } from './data.js';

/** The locale `text` translates to */
export let current = 'en';

/** The locale `text` uses for translations missing from the current locale */
export let fallback = 'en';

let regionNames: Intl.DisplayNames;
let dateFields: Intl.DisplayNames;
let conjunction: Intl.ListFormat;
let disjunction: Intl.ListFormat;

/** The names of the months in the current locale, starting with January */
export let monthNames: string[];

function useFormatters(locale: string): void {
	regionNames = new Intl.DisplayNames(locale, { type: 'region' });
	dateFields = new Intl.DisplayNames(locale, { type: 'dateTimeField' });
	conjunction = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
	disjunction = new Intl.ListFormat(locale, { style: 'long', type: 'disjunction' });

	const formatter = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
	monthNames = Array.from({ length: 12 }, (_, month) => formatter.format(new Date(Date.UTC(2000, month, 1))));
}

useFormatters(current);

/** Start translating to a loaded locale. */
export function use(locale: string): void {
	if (!(locale in loaded)) throw new Error('Locale is not available: ' + locale);
	current = locale;
	useFormatters(locale);
}

/** Set the locale used for missing translations, which does not need to be loaded yet. */
export function useFallback(locale: string): void {
	fallback = locale;
}

/** The name of a country or region in the current locale, from its ISO 3166 code */
export function countryName(code: string): string | undefined {
	return regionNames.of(code);
}

/** The name of a date field (e.g. `year` or `weekday`) in the current locale */
export function dateField(name: string): string | undefined {
	return dateFields.of(name);
}

/** Join a list with "and" in the current locale */
export function conjoin(list: Iterable<string>): string {
	return conjunction.format(list);
}

/** Join a list with "or" in the current locale */
export function disjoin(list: Iterable<string>): string {
	return disjunction.format(list);
}

const escapePattern = /[&<>"']/g;

const escapes: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

/** Escape text for use in HTML */
export function escape(text: string): string {
	return text.replaceAll(escapePattern, character => escapes[character]);
}

export interface ReplacementOptions {
	/** Used when the current locale has no translation for the key */
	$default?: string;
	/** Whether to escape replacements for use in HTML */
	$html?: boolean;
}

export type Replacements<K extends string> = ReplacementOptions
	& (K extends Key ? Keys[K & Key] : Record<string, Value>);

type ReplacementsArgs<K extends string> =
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	{} extends Replacements<K> ? [replacements?: Replacements<K>] : [replacements: Replacements<K>];

const replacementPattern = /\{(\w+)\}/g;

/**
 * Get localized text for a given translation key
 * @example
 * ```ts
 * text(`example.translation.key.${dynamicPart}`, { a: 1, b: 2 });
 * ```
 */
export function text<const K extends string = Key>(key: K, ...args: ReplacementsArgs<K>): string {
	const values: Record<string, any> & ReplacementOptions = Object.assign(Object.create(null), args[0]);

	let translation: string | object | undefined = getByString(loaded[current], key) || values.$default;

	if (!translation && current != fallback) {
		io.warn(`Missing translation in ${current}: ` + key);
		translation = getByString(loaded[fallback], key);
	}

	if (!translation) {
		io.error('Missing translation for key:', key);
		translation = `?${key}?`;
	}

	if (typeof translation == 'object') {
		io.error('Invalid translation key:', key);
		translation = values.$default || `!${key}!`;
	}

	return translation.replaceAll(replacementPattern, (_, name) => {
		if (!Object.hasOwn(values, name)) {
			io.error(new Error(`Missing replacement value for ${key}: ${name}`));
			values[name] = `<missing: ${name}>`;
		}
		return values.$html ? escape(String(values[name])) : String(values[name]);
	});
}
