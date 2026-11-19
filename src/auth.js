const encoder = new TextEncoder();

export async function isAuthorized(request, env) {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match || !env.ADMIN_TOKEN) return false;

  const [providedDigest, expectedDigest] = await Promise.all([
    digest(match[1]),
    digest(env.ADMIN_TOKEN),
  ]);

  let difference = 0;
  for (let i = 0; i < providedDigest.length; i++) {
    difference |= providedDigest[i] ^ expectedDigest[i];
  }
  return difference === 0;
}

async function digest(value) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value))
  );
}
