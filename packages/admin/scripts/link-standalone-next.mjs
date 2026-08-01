/**
 * npm workspaces + `outputFileTracingRoot` 时，Next standalone 输出在
 * `.next/standalone/packages/<pkg>/.next/`，而 OpenNext 期望 `.next/standalone/.next/`。
 * 在 standalone 根目录创建指向真实 `.next` 的符号链接。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, '..');
const standaloneDir = path.join(pkgRoot, '.next/standalone');
const nestedNext = path.join(standaloneDir, 'packages/admin/.next');
const linkNext = path.join(standaloneDir, '.next');

if (!fs.existsSync(nestedNext)) {
	console.warn('[link-standalone-next] skip: nested .next not found', nestedNext);
	process.exit(0);
}

try {
	if (fs.existsSync(linkNext)) {
		const st = fs.lstatSync(linkNext);
		if (st.isSymbolicLink()) {
			fs.unlinkSync(linkNext);
		} else {
			fs.rmSync(linkNext, { recursive: true, force: true });
		}
	}
	// Windows: 普通用户无权创建 symlink（EPERM），改用 junction。
	// junction 仅支持目录 + 绝对路径，对上层程序读取行为与 symlink 等价。
	// 其他平台保持原有的相对路径 + 'dir' symlink，行为不变。
	if (process.platform === 'win32') {
		fs.symlinkSync(nestedNext, linkNext, 'junction');
		console.log('[link-standalone-next] junction', linkNext, '->', nestedNext);
	} else {
		const relative = path.relative(standaloneDir, nestedNext);
		fs.symlinkSync(relative, linkNext, 'dir');
		console.log('[link-standalone-next] linked', linkNext, '->', relative);
	}
} catch (e) {
	console.error('[link-standalone-next] failed', e);
	process.exit(1);
}
