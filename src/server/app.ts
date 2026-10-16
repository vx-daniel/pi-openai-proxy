/**
 * Hono application assembly: middleware + routes.
 */

import { Hono } from "hono";
import type { ServerConfig } from "@proxy/config/env";
import {
	bodySizeLimitMiddleware,
	disconnectMiddleware,
	proxyAuthMiddleware,
	requestIdMiddleware,
} from "@proxy/server/middleware";
import { createRoutes, type ExposureConfigReader } from "@proxy/server/routes";
import type { ProxyEnv } from "@proxy/server/types";

export function createApp(
	config: ServerConfig,
	configReader?: ExposureConfigReader,
): Hono<ProxyEnv> {
	const app = new Hono<ProxyEnv>();

	// Global middleware
	app.use("*", requestIdMiddleware());
	app.use("*", disconnectMiddleware());
	app.use("*", bodySizeLimitMiddleware(config));
	app.use("/v1/*", proxyAuthMiddleware(config));

	// Routes
	app.route("/", createRoutes(config, configReader));

	return app;
}
