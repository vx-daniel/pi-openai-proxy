/**
 * Typed environment variables for the proxy.
 * Allows dot-notation access without noPropertyAccessFromIndexSignature errors.
 */

declare namespace NodeJS {
  interface ProcessEnv {
    HOME?: string | undefined
    XDG_CONFIG_HOME?: string | undefined
    CUSTOM_DATA_DIR?: string | undefined
    PI_CODING_AGENT_DIR?: string | undefined
    PI_PROXY_HOST?: string | undefined
    PI_PROXY_PORT?: string | undefined
    PI_PROXY_AUTH_TOKEN?: string | undefined
    PI_PROXY_AGENTIC?: string | undefined
    PI_PROXY_REMOTE_IMAGES?: string | undefined
    PI_PROXY_MAX_BODY_SIZE?: string | undefined
    PI_PROXY_UPSTREAM_TIMEOUT_MS?: string | undefined
    PI_PROXY_LOG_LEVEL?: string | undefined
    PI_PROXY_LOG_FORMAT?: string | undefined
    /** Opt-in: a file path the pi extension writes its logs to. Unset = the extension logs nowhere. */
    PI_PROXY_EXTENSION_LOG_FILE?: string | undefined
    /** `1` turns on the `live` test project (test/conformance); set by `pnpm run test:live`. */
    PI_PROXY_LIVE_TESTS?: string | undefined
    /** scripts/record-fixtures.ts: the pi agent dir holding the login used for recording. */
    PI_PROXY_RECORD_AGENT_DIR?: string | undefined
    /** scripts/record-fixtures.ts: where the recorder forwards to (default api.anthropic.com). */
    PI_PROXY_RECORD_UPSTREAM?: string | undefined
    /** Set by the package manager running a script; read by `scripts/gate.ts`. */
    npm_config_user_agent?: string | undefined
  }
}
