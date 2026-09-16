export function assertFirefoxCsp(manifest) {
  const policy = manifest.content_security_policy?.extension_pages
  const directives =
    typeof policy === 'string'
      ? policy
          .split(';')
          .map((directive) => {
            return directive.trim().replace(/\s+/g, ' ')
          })
          .filter(Boolean)
          .sort()
      : []
  if (directives.length !== 2 || directives[0] !== "object-src 'self'" || directives[1] !== "script-src 'self'") {
    throw new Error(
      "Firefox extension CSP must explicitly use script-src 'self'; object-src 'self'; without upgrade-insecure-requests",
    )
  }
}
