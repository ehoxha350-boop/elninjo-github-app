const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === "/posts") {
      if (method === "GET") {
        return Response.json(await listPublishedPosts(env.DB));
      }
      if (method === "POST") {
        if (!(await isAuthorized(request, env))) return unauthorized();
        return handleCreatePost(request, env);
      }
      return methodNotAllowed("GET, POST");
    }

    const match = /^\/posts\/([^/]+)$/.exec(url.pathname);
    if (match) {
      let slug;
      try {
        slug = decodeURIComponent(match[1]);
      } catch {
        return Response.json({ error: "Invalid slug" }, { status: 400 });
      }

      if (method === "GET") {
        const post = await getPublishedPost(env.DB, slug);
        return post
          ? Response.json(post)
          : Response.json({ error: "Post not found" }, { status: 404 });
      }

      if (method === "PUT" || method === "DELETE") {
        if (!(await isAuthorized(request, env))) return unauthorized();
        if (method === "PUT") return handleUpdatePost(request, env, slug);
        const deleted = await deletePost(env.DB, slug);
        return deleted
          ? new Response(null, { status: 204 })
          : Response.json({ error: "Post not found" }, { status: 404 });
      }

      return methodNotAllowed("GET, PUT, DELETE");
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

async function isAuthorized(request, env) {
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

async function listPublishedPosts(db) {
  const { results } = await db
    .prepare(
      `SELECT id, slug, title, body, status, created_at, updated_at
       FROM posts
       WHERE status = 'published'
       ORDER BY created_at DESC`
    )
    .all();
  return results;
}

async function getPublishedPost(db, slug) {
  return db
    .prepare(
      `SELECT id, slug, title, body, status, created_at, updated_at
       FROM posts
       WHERE slug = ? AND status = 'published'`
    )
    .bind(slug)
    .first();
}

async function createPost(db, { slug, title, body, status }) {
  return db
    .prepare(
      `INSERT INTO posts (slug, title, body, status)
       VALUES (?, ?, ?, ?)
       RETURNING id, slug, title, body, status, created_at, updated_at`
    )
    .bind(slug, title, body, status)
    .first();
}

async function updatePost(db, slug, { title, body, status }) {
  return db
    .prepare(
      `UPDATE posts
       SET title = ?, body = ?, status = COALESCE(?, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE slug = ?
       RETURNING id, slug, title, body, status, created_at, updated_at`
    )
    .bind(title, body, status ?? null, slug)
    .first();
}

async function deletePost(db, slug) {
  const result = await db
    .prepare("DELETE FROM posts WHERE slug = ?")
    .bind(slug)
    .run();
  return result.meta.changes > 0;
}

async function handleCreatePost(request, env) {
  const input = await readPostInput(request);
  if (input instanceof Response) return input;
  if (!isValidPost(input, true)) {
    return Response.json(
      {
        error:
          "slug, title, and body are required; status must be draft or published",
      },
      { status: 400 }
    );
  }

  const post = await createPost(env.DB, {
    slug: input.slug.trim(),
    title: input.title.trim(),
    body: input.body,
    status: input.status ?? "draft",
  });
  return Response.json(post, { status: 201 });
}

async function handleUpdatePost(request, env, slug) {
  const input = await readPostInput(request);
  if (input instanceof Response) return input;
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.title !== "string" ||
    !input.title.trim() ||
    typeof input.body !== "string" ||
    !input.body.trim() ||
    (input.status !== undefined &&
      input.status !== "draft" &&
      input.status !== "published")
  ) {
    return Response.json(
      { error: "title and body are required; status must be draft or published" },
      { status: 400 }
    );
  }

  const post = await updatePost(env.DB, slug, {
    title: input.title.trim(),
    body: input.body,
    status: input.status,
  });
  return post
    ? Response.json(post)
    : Response.json({ error: "Post not found" }, { status: 404 });
}

async function readPostInput(request) {
  try {
    return await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

function isValidPost(input, includeSlug) {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    (!includeSlug || (typeof input.slug === "string" && !!input.slug.trim())) &&
    typeof input.title === "string" &&
    !!input.title.trim() &&
    typeof input.body === "string" &&
    !!input.body.trim() &&
    (input.status === undefined ||
      input.status === "draft" ||
      input.status === "published")
  );
}

function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function methodNotAllowed(allow) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: allow },
  });
}
