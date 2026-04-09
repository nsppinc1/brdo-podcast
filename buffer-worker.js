// BRDO Buffer Worker
// Deploy this code to your brdo-buffer-worker Cloudflare Worker
// Required secrets:  BUFFER_API_KEY  (set in Worker Settings → Variables and Secrets)
// Required bindings: CLIPS_BUCKET    (R2 bucket: brdo-clips)

const BUFFER_API = 'https://api.buffer.com';
const ALLOWED_ORIGINS = [
  'https://brdostudios.com',
  'https://www.brdostudios.com',
  'http://localhost',
  'http://127.0.0.1'
];

// ─── CORS headers ────────────────────────────────────────
function cors(origin) {
  const o = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) }
  });
}

// ─── Buffer GraphQL helper ────────────────────────────────
async function gql(query, variables = {}, apiKey) {
  const res = await fetch(BUFFER_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

// ─── Main handler ─────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // ── GET /channels ─────────────────────────────────────
    // Returns org ID and all connected channels
    if (request.method === 'GET' && url.pathname === '/channels') {
      const orgQuery = `
        query {
          account {
            organizations { id name }
          }
        }`;

      const orgRes = await gql(orgQuery, {}, env.BUFFER_API_KEY);
      if (orgRes.errors) return json({ error: orgRes.errors[0].message }, 400, origin);

      const orgId = orgRes.data.account.organizations[0]?.id;
      if (!orgId) return json({ error: 'No organization found' }, 404, origin);

      const chanQuery = `
        query GetChannels($orgId: OrganizationId!) {
          channels(input: { organizationId: $orgId, filter: { isLocked: false } }) {
            id name displayName service avatar
          }
        }`;

      const chanRes = await gql(chanQuery, { orgId }, env.BUFFER_API_KEY);
      if (chanRes.errors) return json({ error: chanRes.errors[0].message }, 400, origin);

      return json({
        orgId,
        channels: chanRes.data.channels
      }, 200, origin);
    }

    // ── POST /upload ──────────────────────────────────────
    // Receives a video file, stores in R2, returns public URL
    if (request.method === 'POST' && url.pathname === '/upload') {
      const formData = await request.formData();
      const file = formData.get('video');

      if (!file) return json({ error: 'No video file provided' }, 400, origin);

      const ext      = file.name.split('.').pop() || 'mp4';
      const key      = `clips/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const buffer   = await file.arrayBuffer();

      await env.CLIPS_BUCKET.put(key, buffer, {
        httpMetadata: { contentType: file.type || 'video/mp4' }
      });

      // Public R2 dev URL — replace with your actual bucket public URL
      const publicBase = env.R2_PUBLIC_URL; // set this as a secret too
      const videoUrl   = `${publicBase}/${key}`;

      return json({ url: videoUrl, key }, 200, origin);
    }

    // ── POST /publish ─────────────────────────────────────
    // Creates a post on Buffer for each selected channel
    if (request.method === 'POST' && url.pathname === '/publish') {
      const { channelIds, text, videoUrl, thumbnailUrl, title, igType } = await request.json();

      if (!channelIds?.length) return json({ error: 'No channels selected' }, 400, origin);
      if (!text)               return json({ error: 'Caption is required' },  400, origin);
      if (!videoUrl)           return json({ error: 'No video URL provided' }, 400, origin);

      const mutation = `
        mutation CreatePost($input: CreatePostInput!) {
          createPost(input: $input) {
            ... on PostActionSuccess {
              post { id status }
            }
            ... on MutationError {
              message
            }
          }
        }`;

      const results = await Promise.all(channelIds.map(channelId =>
        gql(mutation, {
          input: {
            text,
            channelId,
            schedulingType: 'automatic',
            mode: 'shareNow',
            assets: {
              videos: [{
                url: videoUrl,
                ...(thumbnailUrl && { thumbnailUrl }),
                ...(title && { metadata: { title } })
              }]
            },
            metadata: {
              instagram: {
                type: igType || 'reel',
                shouldShareToFeed: igType !== 'story'
              }
            }
          }
        }, env.BUFFER_API_KEY)
      ));

      const errors = results
        .map((r, i) => {
          if (r.errors?.length)              return { channelId: channelIds[i], error: r.errors[0].message };
          if (r.data?.createPost?.message)   return { channelId: channelIds[i], error: r.data.createPost.message };
          if (!r.data?.createPost?.post)     return { channelId: channelIds[i], error: 'No post returned', raw: JSON.stringify(r) };
          return null;
        })
        .filter(Boolean);

      const successes = results
        .map((r, i) => r.data?.createPost?.post ? { channelId: channelIds[i], postId: r.data.createPost.post.id } : null)
        .filter(Boolean);

      return json({ successes, errors }, 200, origin);
    }

    return json({ error: 'Not found' }, 404, origin);
  }
};
