function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type Pkce = { verifier: string; challenge: string; state: string };

/** Browser-only: needs WebCrypto, which is available on https and localhost. */
export async function createPkce(): Promise<Pkce> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: base64url(new Uint8Array(digest)), state };
}
