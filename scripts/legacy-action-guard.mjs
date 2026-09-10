/**
 * Blocks the ambiguous default `reload` / `release` commands.
 *
 * The plain commands used to target the upstream dev extension ID, restart the
 * legacy relay on 19988, or talk to the upstream Chrome Web Store listing,
 * which is wrong for this fork. The legacy flows stay available under explicit
 * `*:legacy` names so nobody triggers them by accident.
 */

const action = process.argv[2]

const messages = {
  reload: `Refusing the default reload: it restarts the legacy relay on port 19988 and opens the upstream dev extension.
Use \`pnpm reload:fork\` for the fork extension, or \`pnpm reload:legacy\` if you really need the legacy flow.`,
  release: `Refusing the default release: it targets the upstream Chrome Web Store listing and publish flow.
Use \`pnpm release:legacy\` only if you own that listing; this fork is not published.`,
}

console.error(messages[action] ?? `Unknown guarded action "${action}".`)
process.exit(1)
