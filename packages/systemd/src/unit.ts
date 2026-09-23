// SPDX-License-Identifier: LGPL-3.0-or-later

export type UnitValue = string | number | boolean;

/** A section's settings. A list repeats its key once per item, and a nullish value is left out. */
export type UnitSection = Record<string, UnitValue | readonly UnitValue[] | null | undefined>;

/** A unit file's sections, such as `Unit`, `Service`, and `Install`. */
export type UnitFile = Record<string, UnitSection>;

export function stringify(unit: UnitFile): string {
	const sections: string[] = [];

	for (const [name, settings] of Object.entries(unit)) {
		let text = `[${name}]\n`;

		for (const [key, value] of Object.entries(settings)) {
			if (value === null || value === undefined) continue;

			for (const item of typeof value == 'object' ? value : [value]) {
				const line = String(item);
				if (/[\r\n]/.test(line)) throw new SyntaxError(`${name}.${key} can not span multiple lines`);
				text += `${key}=${line}\n`;
			}
		}

		sections.push(text);
	}

	return sections.join('\n');
}

/** A setting value that systemd reads literally, rather than expanding the specifiers (like `%h`) in it. */
export function literal(value: string): string {
	return value.replaceAll('%', '%%');
}

function quote(arg: string): string {
	const escaped = literal(arg).replaceAll('$', () => '$$');
	if (escaped && !/[\s"'\\;]/.test(escaped)) return escaped;
	return '"' + escaped.replace(/["\\]/g, '\\$&') + '"';
}

/** A command line for `ExecStart=` and the like, which passes every argument through literally. */
export function command(...argv: string[]): string {
	return argv.map(quote).join(' ');
}
