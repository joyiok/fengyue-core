import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `output: 'standalone'` is what makes the Docker image small: the runtime copies
 * `.next/standalone` plus the static assets instead of the whole node_modules.
 *
 * There is no rewrites() block on purpose. `/api/*` is proxied by the explicit
 * route handler in app/api/v1/, which forwards the SSE body as a stream — a
 * rewrite goes through a layer that is free to buffer, and buffering is exactly
 * what turns "typing" into "the model hung".
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    reactStrictMode: true,
    // This directory has a package.json of its own but lives inside the
    // story-core checkout, which has one too. Say which tree the trace belongs
    // to instead of letting Next guess from the lockfiles.
    outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
