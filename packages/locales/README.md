# @james-pre/locales

A small library for translations, with types for each translation key and the replacements it needs.

The core works cross-host:

```ts
import { extendLocale, text, useLocale } from '@james-pre/locales';

extendLocale('en', { duck: { name: 'Duck Name', greeting: 'Hello {name}!' } });
extendLocale('fr', { duck: { name: 'Nom du canard' } });

useLocale('fr');

text('duck.name'); // 'Nom du canard'
text('duck.greeting', { name: 'Jerry' }); // 'Hello Jerry!', from the fallback locale (`en`)
```

`resolveLocale('en-US')` finds the best loaded locale for a language tag, and `countryName`, `dateField`, `conjoin`, `disjoin`, and `currentMonthNames` follow the current locale.

## Node.js

`@james-pre/locales/node` has everything in the core, plus loading `<locale>.json` files from a directory:

```ts
import * as locales from '@james-pre/locales/node';

locales.load('path/to/locales');
```

## Types

The `locales-typegen` command generates a module declaring the keys in a package's `locales` directory, so that `text` checks keys and replacements:

```sh
locales-typegen                      # writes src/.locale.ts
locales-typegen packages/* -o src/.locale.ts -r en
```

## Zod

`zod` is a registry for attaching translation keys to schemas:

```ts
import * as locales from '@james-pre/locales';
import * as z from 'zod';

const Duck = z.object({
	name: z.string().register(locales.zod, { key: 'duck.name' }),
});

locales.zod.get(Duck.shape.name); // { key: 'duck.name' }
```

Other metadata can be attached by augmenting `ZodInfo`:

```ts
declare module '@james-pre/locales' {
	interface ZodInfo {
		experimental?: boolean;
	}
}
```

Zod is an optional peer dependency, needed only for `locales.zod`, which is `undefined` without it.
