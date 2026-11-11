import { isIP } from "node:net";

const privateIpv4 = hostname => {
  if (isIP(hostname) !== 4) return false;
  const [a, b] = hostname.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};
export function postgresOptions(
  url,
  { ssl = "require", network = "remote" } = {},
) {
  if (!url) throw new Error("database_not_configured");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // URL TypeError.input contains the original credential-bearing value.
    throw new Error("invalid_database_url");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw new Error("invalid_database_url");
  if (
    !["local", "private", "remote"].includes(network) ||
    !["off", "require", "verify-full"].includes(ssl)
  )
    throw new Error("invalid_database_security");
  if (
    ssl === "off" &&
    !((network === "private" && privateIpv4(parsed.hostname)) ||
     (network === "local" &&
      [
        "localhost",
        "127.0.0.1",
        "[::1]",
        "postgres",
        "newsletter-db",
      ].includes(parsed.hostname)))
  )
    throw new Error("insecure_database");
  // pg applies URL query fields after explicit options, including host and ssl.
  // Use only the checked URL authority/path plus the explicit network/TLS policy.
  parsed.search = "";
  return {
    connectionString: parsed.toString(),
    ssl: ssl === "off" ? false : { rejectUnauthorized: true },
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  };
}
