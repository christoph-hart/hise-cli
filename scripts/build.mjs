import { build } from "esbuild";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

{
	const result = spawnSync(process.execPath, ["scripts/generate-agent-context.mjs"], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		process.stderr.write("[build] agent context generation failed\n");
		process.exit(1);
	}
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

// Build the SPA first; the Node bundle ships the dist/web/ tree alongside.
{
	const result = spawnSync(process.execPath, ["scripts/build-web.mjs"], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		process.stderr.write("[build] SPA build failed\n");
		process.exit(1);
	}
}

// Embed dist/web/* into src/web/embedded-assets.ts so the compiled
// binary serves them from memory.
{
	const result = spawnSync(process.execPath, ["scripts/embed-web-assets.mjs"], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		process.stderr.write("[build] web asset embed failed\n");
		process.exit(1);
	}
}

// Build the docs-site embed bundle (browser-targeted ESM).
{
	const result = spawnSync(process.execPath, ["scripts/build-embed.mjs"], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		process.stderr.write("[build] embed build failed\n");
		process.exit(1);
	}
}

await build({
	entryPoints: ["src/index.ts"],
	bundle: true,
	platform: "node",
	target: "node18",
	format: "esm",
	outfile: "dist/index.js",
	banner: {
		js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
	},
	define: {
		"__APP_VERSION__": JSON.stringify(pkg.version),
	},
	loader: {
		".yaml": "text",
	},
	sourcemap: false,
	logLevel: "info",
});

try {
	chmodSync("dist/index.js", 0o755);
} catch {
	// Best effort on Windows.
}
