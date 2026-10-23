// SPDX-License-Identifier: LGPL-3.0-or-later
import type { $ZodRegistry } from 'zod/v4/core';

const zod = await import('zod/v4/core').catch(() => null);

/**
 * Translation metadata for a schema.
 * Augment it to attach other metadata using the same registry.
 */
export interface ZodInfo {
	/**
	 * Translation key for this schema
	 */
	key?: string;
	/**
	 * Key prefix for objects, enums, and literal collections
	 * @example
	 * ```ts
	 * const Duck = z.object({
	 * 	name: z.string(),
	 * 	type: z.literal(['mallard', 'gadwall', 'pintail']).register(locales.zod, { key: 'duck.type', prefix: 'duck_type' }),
	 * }).register(locales.zod, { key: 'animals.duck', prefix: 'duck' });
	 *
	 * text('duck.name'); // 'Duck Name'
	 * text('duck_type.mallard') // 'Mallard'
	 * ```
	 */
	prefix?: string;
}

/**
 * Zod registry for attaching translation keys to schemas, which is `undefined` when Zod is not installed
 */
export default zod?.registry<ZodInfo>() as $ZodRegistry<ZodInfo>;
