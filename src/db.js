export async function listPublishedPosts(db) {
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

export async function getPublishedPost(db, slug) {
  return db
    .prepare(
      `SELECT id, slug, title, body, status, created_at, updated_at
       FROM posts
       WHERE slug = ? AND status = 'published'`
    )
    .bind(slug)
    .first();
}

export async function createPost(db, { slug, title, body, status }) {
  return db
    .prepare(
      `INSERT INTO posts (slug, title, body, status)
       VALUES (?, ?, ?, ?)
       RETURNING id, slug, title, body, status, created_at, updated_at`
    )
    .bind(slug, title, body, status)
    .first();
}

export async function updatePost(db, slug, { title, body, status }) {
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

export async function deletePost(db, slug) {
  const result = await db
    .prepare("DELETE FROM posts WHERE slug = ?")
    .bind(slug)
    .run();
  return result.meta.changes > 0;
}
