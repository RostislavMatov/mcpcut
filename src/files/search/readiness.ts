/** Placeholder with the final signature (phase 5 shared definitions); part A implements it. */

/**
 * `null` when the search runtime and the model files are in place under
 * `<modulesDir>/search` (a size check, no hashing), else the one line that
 * says what is missing and the command that installs it.
 */
export async function searchRuntimeProblem(modulesDir: string, cli: string): Promise<string | null> {
  return `search by meaning is not installed in ${modulesDir}: run \`${cli} files setup --search\``
}
