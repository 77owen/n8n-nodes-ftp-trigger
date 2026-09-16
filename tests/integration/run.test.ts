import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const enabled = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!enabled)('integration: real FTP/SFTP servers', () => {
	it(
		'passes all harness checks against a real ftp-srv FTP server and an in-process ssh2 SFTP server',
		() => {
			const result = spawnSync('node', [join(process.cwd(), 'tests/integration/harness.cjs')], {
				encoding: 'utf8',
				timeout: 120_000,
			});
			if (result.status !== 0) {
				console.error('--- harness stdout ---\n' + result.stdout);
				console.error('--- harness stderr ---\n' + result.stderr);
			}
			expect(result.status).toBe(0);
		},
		150_000,
	);
});
