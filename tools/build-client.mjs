/** A single dependency-free module needs transpilation, not a bundled dependency graph. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import ts from 'typescript'

const ROOT = new URL('../', import.meta.url)
const SOURCE = new URL('src/tier-client.ts', ROOT)
const OUTPUT = new URL('dist/client.js', ROOT)
const METADATA = new URL('package.json', ROOT)
const ENCODING = 'utf8'
const RUNTIME_IMPORT = 'tier-client must not contain runtime imports'
const COMPILER_HOST = { getCanonicalFileName: name => name, getCurrentDirectory: () => ROOT.pathname, getNewLine: () => '\n' }
const source = await readFile(SOURCE, ENCODING)
const syntax = ts.createSourceFile(SOURCE.pathname, source, ts.ScriptTarget.ES2023, true)
for (const statement of syntax.statements) {
  if ((ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly)
    || (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly)
    || ts.isImportEqualsDeclaration(statement)) throw new Error(RUNTIME_IMPORT)
}
const compiled = ts.transpileModule(source, {
  fileName: SOURCE.pathname,
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, strict: true },
})
const errors = compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
if (errors.length) throw new Error(ts.formatDiagnostics(errors, COMPILER_HOST))
const metadata = JSON.parse(await readFile(METADATA, ENCODING))
const wrapper = 'window.__ModuleLoader__.load({id:' + JSON.stringify(metadata.name)
  + ',factory(require){const exports={};\n' + compiled.outputText + '\nreturn exports;}});\n'
await mkdir(new URL('dist/', ROOT), { recursive: true })
await writeFile(OUTPUT, wrapper, ENCODING)
