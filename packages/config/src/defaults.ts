import * as z from 'zod';

/**
 * Remove `.default()` and `.prefault()` from a schema and everything nested within it.
 */
export function strip(schema: z.ZodType): z.ZodType {
	const def = schema._zod.def as any;

	switch (def.type) {
		case 'default':
		case 'prefault':
			return strip(def.innerType);
		case 'object':
			return z.core.clone(schema, {
				...def,
				shape: Object.fromEntries(
					Object.entries<z.ZodType>(def.shape).map(([key, member]) => [key, strip(member)])
				),
				catchall: def.catchall && strip(def.catchall),
			});
		case 'array':
			return z.core.clone(schema, { ...def, element: strip(def.element) });
		case 'record':
		case 'map':
		case 'set':
			return z.core.clone(schema, { ...def, valueType: strip(def.valueType) });
		case 'union':
			return z.core.clone(schema, { ...def, options: (def.options as z.ZodType[]).map(strip) });
		case 'tuple':
			return z.core.clone(schema, {
				...def,
				items: (def.items as z.ZodType[]).map(strip),
				rest: def.rest && strip(def.rest),
			});
		case 'optional':
		case 'nullable':
		case 'readonly':
		case 'nonoptional':
		case 'catch':
			return z.core.clone(schema, { ...def, innerType: strip(def.innerType) });
		default:
			return schema;
	}
}

/**
 * Compute a schema's default value from `.default()` on it and on anything nested within it.
 * Members without a default are left out, so the result is not necessarily a complete config.
 */
export function of(schema: z.ZodType): unknown {
	const def = schema._zod.def as any;

	switch (def.type) {
		case 'default':
		case 'prefault':
		case 'catch':
			try {
				return schema.parse(undefined);
			} catch {
				return of(def.innerType);
			}
		case 'object': {
			const value: Record<string, unknown> = {};
			for (const [key, member] of Object.entries<z.ZodType>(def.shape)) {
				const inner = of(member);
				if (inner !== undefined) value[key] = inner;
			}
			return Object.keys(value).length ? value : undefined;
		}
		default:
			return def.innerType ? of(def.innerType) : undefined;
	}
}

/**
 * Fill in defaults for anything missing from `value` in place, including within records, maps, arrays, and tuples.
 */
function _with(schema: z.ZodType, value: unknown): unknown {
	const def = schema._zod.def as any;

	switch (def.type) {
		case 'default':
		case 'prefault':
		case 'catch':
			return value === undefined ? of(schema) : _with(def.innerType, value);
		case 'optional':
		case 'nullable':
		case 'readonly':
		case 'nonoptional':
			return value == null ? value : _with(def.innerType, value);
		case 'object': {
			if (typeof value != 'object' || value === null) return value;
			const object = value as Record<string, unknown>;
			for (const [key, member] of Object.entries<z.ZodType>(def.shape)) {
				const filled = _with(member, object[key]);
				if (filled !== undefined) object[key] = filled;
			}
			return object;
		}
		case 'record': {
			if (typeof value != 'object' || value === null) return value;
			const record = value as Record<string, unknown>;
			for (const key of Object.keys(record)) record[key] = _with(def.valueType, record[key]);
			return record;
		}
		case 'map':
			if (!(value instanceof Map)) return value;
			for (const [key, entry] of value) value.set(key, _with(def.valueType, entry));
			return value;
		case 'array':
			if (!Array.isArray(value)) return value;
			for (let i = 0; i < value.length; i++) value[i] = _with(def.element, value[i]);
			return value;
		case 'tuple':
			if (!Array.isArray(value)) return value;
			for (let i = 0; i < value.length; i++) {
				const item = i < def.items.length ? def.items[i] : def.rest;
				if (item) value[i] = _with(item, value[i]);
			}
			return value;
		default:
			return value;
	}
}

export { _with as with };
