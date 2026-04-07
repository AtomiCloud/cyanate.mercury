// @ts-check

import react from "@astrojs/react";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
	integrations: [react()],
	// Enable TypeScript strict mode for better type checking
	vite: {
		resolve: {
			alias: {
				"@": new URL("./src", import.meta.url).pathname,
			},
		},
	},
});
