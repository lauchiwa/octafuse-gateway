/**
 * Proxy Node 运行时打包：把 `@octafuse/*` workspace 源码打进 bundle，
 * 其余裸导入（hono、postgres、drizzle-orm…）保持 external。
 *
 * 避免 `--packages=external` 把 `@octafuse/core/lib/*` 子路径留成运行时依赖
 * （core 子路径 exports 指向 `.ts`，镜像 runner 只有 `dist`，会 ERR_MODULE_NOT_FOUND）。
 */
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const outfile = join(pkgRoot, 'dist/runtime/node.js');

/** 裸导入中仅 `@octafuse/*` 走默认解析（打进 bundle）；其余 external。 */
const bundleWorkspacePackages = {
	name: 'bundle-workspace-packages',
	setup(build) {
		build.onResolve({ filter: /^[^./]/ }, (args) => {
			if (args.path.startsWith('@octafuse/')) {
				return undefined;
			}
			return { path: args.path, external: true };
		});
	},
};

await esbuild.build({
	entryPoints: [join(pkgRoot, 'src/runtime/node.ts')],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile,
	logLevel: 'warning',
	plugins: [bundleWorkspacePackages],
});

/** 产物不得再含 `@octafuse/*` 外部说明符。 */
const source = readFileSync(outfile, 'utf8');
const re = /(?:from\s+|import\s*\(\s*)["'](@octafuse\/[^"']+)["']/g;
const found = new Set();
for (const m of source.matchAll(re)) {
	found.add(m[1]);
}
if (found.size > 0) {
	console.error('[proxy/build] bundle still references @octafuse/* as external:');
	for (const id of [...found].sort()) {
		console.error(`  ${id}`);
	}
	process.exit(1);
}
console.log('[proxy/build] OK: no @octafuse/* externals in', outfile);
