import { Buffer } from 'buffer'

// NEAR wallet libraries expect Node's Buffer in the browser.
// Imported first in main.tsx so it exists before any library module runs.
;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer
