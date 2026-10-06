import react from "@astrojs/react";
import { defineConfig } from "astro/config";

// Translate only a verified local same-origin request. Keep cross-site origins
// unchanged so the Worker rejects them; preserve Sec-Fetch-Site as well.
const actionProxy = {
	target: "http://127.0.0.1:8787",
	changeOrigin: true,
	configure(proxy) {
		proxy.on("proxyReq", (proxyRequest, request) => {
			if (request.headers.host && request.headers.origin === `http://${request.headers.host}`) {
				proxyRequest.setHeader("origin", "http://127.0.0.1:8787");
			}
		});
	},
};

export default defineConfig({
	outDir: "build",
	site: "https://photos.hackthehill.com",
	integrations: [react()],
	vite: { server: { proxy: { "^/(?:restore/?)?\\?action=": actionProxy } } },
});
