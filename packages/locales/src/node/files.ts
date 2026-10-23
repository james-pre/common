// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { deepAssign } from 'utilium';
import { extend, type Data } from '../data.js';
import { fallback } from '../locale.js';

/**
 * Read every `<locale>.json` file in a directory, without loading them.
 */
export function read(dir: string): Record<string, Data> {
	const locales: Record<string, Data> = {};

	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith('.json')) continue;
		locales[basename(entry, '.json')] = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
	}

	return locales;
}

/**
 * Load the translations in a directory into the current process.
 * @returns the locales that were loaded
 */
export function load(dir: string): string[] {
	const locales = read(dir);
	for (const [locale, data] of Object.entries(locales)) extend(locale, data);
	return Object.keys(locales);
}

/**
 * Merge several locales into a single object, applying the reference locale last.
 */
export function merge(locales: Record<string, Data>, reference: string = fallback): Data {
	const merged: Data = {};
	for (const [locale, data] of Object.entries(locales)) {
		if (locale != reference) deepAssign(merged, data);
	}
	if (locales[reference]) deepAssign(merged, locales[reference]);
	return merged;
}
