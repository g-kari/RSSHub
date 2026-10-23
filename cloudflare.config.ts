import { bindings, defineConfig } from 'cf/config';

// Keep the existing Worker identity and bindings. Shared browser sessions are optional.
export default defineConfig({
    worker: {
        name: 'rsshub',
        compatibilityDate: '2026-09-01',
        compatibilityFlags: ['global_fetch_strictly_public'],
        entrypoint: 'dist-worker/worker.mjs',
        observability: {
            enabled: true,
        },
        env: {
            CACHE: bindings.kv(),
            BROWSER: bindings.browser(),
        },
    },
});
