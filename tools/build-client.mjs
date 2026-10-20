/**
 * A single dependency-free module needs transpilation, not a bundled dependency graph.
 *
 * The emit goes through the project's own `tsc` command rather than the
 * compiler's JavaScript API: TypeScript 7 ships a native compiler whose package
 * no longer exports that API (its main entry answers only the version), while
 * the `tsc` command and the CommonJS emit it produces are the same on 6 and 7.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const SOURCE = new URL('src/tier-client.ts', ROOT)
const OUTPUT = new URL('dist/client.js', ROOT)
const METADATA = new URL('package.json', ROOT)
const ENCODING = 'utf8'
const RUNTIME_IMPORT = 'tier-client must not contain runtime imports'
/** Prefix of the throwaway directory holding the emit config and output; removed after every build. */
const SCRATCH_PREFIX = 'dsh-provider-extra-client-'
/** File name tsc emits for the source above under the scratch output directory. */
const EMITTED_NAME = 'tier-client.js'
/** Emit settings matching the browser loader: one CommonJS factory body, no ambient Node types. */
const COMPILER_OPTIONS = {
  target: 'es2023',
  module: 'commonjs',
  strict: true,
  skipLibCheck: true,
  types: [],
  noEmitOnError: true,
  // Each file must stand alone, as the loader evaluates this one module by itself.
  isolatedModules: true,
}
/**
 * A CommonJS emit spells every runtime import, re-export, and dynamic import as
 * a require call, and erases type-only imports, so its absence is the
 * no-runtime-import contract the loader's single factory relies on.
 */
const RUNTIME_REQUIRE = /\brequire\s*\(/u

/** The project's own `tsc` entry, so the build uses the pinned compiler and never a global one. */
function projectCompiler() {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('typescript/package.json')
  const manifest = require(manifestPath)
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsc
  if (typeof bin !== 'string') throw new Error('typescript declares no tsc command')
  return join(dirname(manifestPath), bin)
}

const scratch = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX))
try {
  const config = join(scratch, 'tsconfig.json')
  const outDir = join(scratch, 'out')
  const sourcePath = fileURLToPath(SOURCE)
  await writeFile(config, JSON.stringify({
    compilerOptions: { ...COMPILER_OPTIONS, rootDir: dirname(sourcePath), outDir },
    files: [sourcePath],
  }), ENCODING)
  execFileSync(process.execPath, [projectCompiler(), '-p', config], { stdio: 'inherit' })
  const compiled = await readFile(join(outDir, EMITTED_NAME), ENCODING)
  if (RUNTIME_REQUIRE.test(compiled)) throw new Error(RUNTIME_IMPORT)
  const metadata = JSON.parse(await readFile(METADATA, ENCODING))
  const wrapper = 'window.__ModuleLoader__.load({id:' + JSON.stringify(metadata.name)
    + ',factory(require){const exports={};\n' + compiled + '\nreturn exports;}});\n'
  await mkdir(new URL('dist/', ROOT), { recursive: true })
  await writeFile(OUTPUT, wrapper, ENCODING)
} finally {
  // The scratch path comes from mkdtemp above, never from input, so removing it cannot reach other files.
  await rm(scratch, { recursive: true, force: true })
}
