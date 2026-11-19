# elninjo-github-app

## Local dev

Run the Worker locally with:

```sh
npx wrangler dev
```

Apply the initial D1 migration to the remote database once:

```sh
npx wrangler d1 migrations apply bin --remote
```

Set the admin token as a secret before using the protected post routes:

```sh
npx wrangler secret put ADMIN_TOKEN
```

## Deploy

Cloudflare Workers Builds handles deploy on push to `main`.