/**
 * elninjo — GitHub App Worker
 * 
 * A real GitHub App that:
 * - Verifies webhook signatures (HMAC SHA-256)
 * - Authenticates as a GitHub App (JWT RS256 → installation tokens)
 * - Caches installation tokens in KV (55-min TTL)
 * - Handles ping, installation, push, pull_request, and issues events
 * - Posts a comment on new pull requests and issues
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- Routes ---
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    if (url.pathname === "/") {
      return Response.json({
        name: "elninjo",
        type: "github-app",
        status: "running",
        endpoints: {
          webhook: "POST /webhook",
          health: "GET /health",
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ─── Webhook Handler ──────────────────────────────────────────────

async function handleWebhook(request, env) {
  const signature = request.headers.get("X-Hub-Signature-256");
  const event = request.headers.get("X-GitHub-Event");
  const deliveryId = request.headers.get("X-GitHub-Delivery");

  if (!signature || !event) {
    return Response.json({ error: "Missing required GitHub headers" }, { status: 400 });
  }

  const payload = await request.text();

  // Verify webhook signature
  const valid = await verifySignature(payload, signature, env.GITHUB_WEBHOOK_SECRET);
  if (!valid) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  const body = JSON.parse(payload);
  let result;

  try {
    switch (event) {
      case "ping":
        result = { event: "ping", zen: body.zen };
        break;
      case "installation":
        result = await handleInstallation(body, env);
        break;
      case "push":
        result = await handlePush(body, env);
        break;
      case "pull_request":
        result = await handlePullRequest(body, env);
        break;
      case "issues":
        result = await handleIssue(body, env);
        break;
      default:
        result = { event, message: "Received but not handled" };
    }
  } catch (err) {
    return Response.json({ ok: false, event, deliveryId, error: err.message }, { status: 500 });
  }

  return Response.json({ ok: true, event, deliveryId, result });
}

// ─── Event Handlers ──────────────────────────────────────────────

async function handleInstallation(body, env) {
  const action = body.action;
  const installationId = body.installation?.id;
  const account = body.installation?.account?.login;

  if (action === "deleted" && installationId) {
    // Clean up cached token
    await env.ELNINJO_KV.delete(`token:${installationId}`);
  }

  return { action, installationId, account };
}

async function handlePush(body, env) {
  const repo = body.repository?.full_name;
  const ref = body.ref;
  const commits = body.commits?.length ?? 0;
  const pusher = body.pusher?.name;
  const installationId = body.installation?.id;

  return { repo, ref, commits, pusher, installationId };
}

async function handlePullRequest(body, env) {
  const action = body.action;
  const pr = body.pull_request;
  const repo = body.repository?.full_name;
  const installationId = body.installation?.id;

  // Only act on newly opened PRs
  if (action === "opened" && pr && installationId) {
    const token = await getInstallationToken(installationId, env);
    await postIssueComment(
      token,
      repo,
      pr.number,
      `## 🤖 elninjo bot\nThanks for opening this PR! I'm reviewing the changes.\n\n**PR #${pr.number}**: ${pr.title}\n**Author**: @${pr.user?.login}`,
      env
    );
  }

  return { action, repo, prNumber: pr?.number, installationId };
}

async function handleIssue(body, env) {
  const action = body.action;
  const issue = body.issue;
  const repo = body.repository?.full_name;
  const installationId = body.installation?.id;

  // Only act on newly opened issues
  if (action === "opened" && issue && installationId) {
    const token = await getInstallationToken(installationId, env);
    await postIssueComment(
      token,
      repo,
      issue.number,
      `## 🤖 elninjo bot\nThanks for opening this issue! I'll take a look.\n\n**Issue #${issue.number}**: ${issue.title}\n**Author**: @${issue.user?.login}`,
      env
    );
  }

  return { action, repo, issueNumber: issue?.number, installationId };
}

// ─── GitHub API Helpers ──────────────────────────────────────────

async function postIssueComment(token, repo, issueNumber, body, env) {
  const resp = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API error ${resp.status}: ${text}`);
  }

  return resp.json();
}

// ─── GitHub App Authentication ────────────────────────────────────

async function getInstallationToken(installationId, env) {
  const cacheKey = `token:${installationId}`;
  const cached = await env.ELNINJO_KV.get(cacheKey, "json");

  // Return cached token if still valid (with 5-min buffer)
  if (cached && new Date(cached.expiresAt) > new Date(Date.now() + 5 * 60 * 1000)) {
    return cached.token;
  }

  // Generate a fresh JWT
  const jwt = await generateAppJWT(env);

  // Request a new installation token
  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to get installation token (${resp.status}): ${text}`);
  }

  const data = await resp.json();

  // Cache the token (GitHub tokens expire in 1 hour; cache for 55 min)
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
  await env.ELNINJO_KV.put(cacheKey, JSON.stringify({ token: data.token, expiresAt }));

  return data.token;
}

async function generateAppJWT(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60, // 1 min clock tolerance
    exp: now + 9 * 60, // 9 min max (GitHub allows max 10)
    iss: env.GITHUB_APP_ID,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importPrivateKey(env.GITHUB_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = base64UrlEncode(new Uint8Array(signature));
  return `${signingInput}.${sigB64}`;
}

// ─── Crypto Helpers ──────────────────────────────────────────────

async function verifySignature(payload, signature, secret) {
  if (!secret) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const computed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );

  const computedHex = "sha256=" + toHex(new Uint8Array(computed));
  return computedHex === signature;
}

async function importPrivateKey(pem) {
  // Convert PEM to DER ArrayBuffer
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const binaryDer = base64ToArrayBuffer(pemContents);

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function base64UrlEncode(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
