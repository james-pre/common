#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-or-later
import cli from './cli.js';

try {
	cli.parse();
} catch (error) {
	cli.error(`error: ${error instanceof Error ? error.message : String(error)}`);
}
