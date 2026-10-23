import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('fork Worker deployment scope', () => {
    it.each(['wrangler.toml', 'wrangler.production.toml'])('keeps %s on the existing bindings without migrations', (filename) => {
        const source = fs.readFileSync(filename, 'utf8');
        expect(source).toContain('name = "rsshub"');
        expect(source).toContain('binding = "BROWSER"');
        expect(source).toContain('binding = "CACHE"');
        expect(source).not.toMatch(/durable_objects|new_sqlite_classes|\[\[migrations\]\]|\[\[services\]\]/);
        expect(source).not.toContain('cloudflare-patchright');
        expect(source).toContain('find_additional_modules = true');
        expect(source).toContain('base_dir = "dist-worker/modules"');
    });

    it('does not export an unmigrated Durable Object or change the deployment CLI', () => {
        const entrypoint = fs.readFileSync('lib/worker.ts', 'utf8');
        const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        const config = fs.readFileSync('cloudflare.config.ts', 'utf8');
        expect(entrypoint).not.toContain('BrowserSession');
        expect(config).not.toMatch(/durableObject|bindings\.worker|BrowserSession/);
        expect(packageJson.scripts['worker-deploy']).toBe('npm run worker-build && wrangler deploy --config wrangler.toml');
        expect(packageJson.scripts['worker-dev']).toBe('npm run worker-build && wrangler dev --config wrangler.toml');
    });
});
