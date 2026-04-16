const router = require('express').Router();
const crypto = require('crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const yt = require('../services/youtube');

// Configuration check
router.get('/config', requireAuth, (req, res) => {
  res.json({
    apiKeyConfigured: yt.API_KEY_CONFIGURED,
    oauthConfigured: yt.OAUTH_CONFIGURED
  });
});

/**
 * Link a YouTube channel to an artist (by channel ID, URL, handle, or name)
 * Fetches public info and caches it.
 */
router.post('/link/:artistId', requireAdmin, async (req, res) => {
  try {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: 'Channel ID, URL, or handle required' });

    const channelId = await yt.resolveChannelId(input);
    if (!channelId) return res.status(404).json({ error: 'Could not find a YouTube channel for "' + input + '"' });

    const info = await yt.getChannelInfo(channelId);
    if (!info) return res.status(404).json({ error: 'Channel not found' });

    // Update artist
    await req.db('artists').where({ id: req.params.artistId }).update({
      youtube_channel_id: info.channel_id,
      youtube_channel_url: 'https://www.youtube.com/channel/' + info.channel_id,
      youtube_channel_title: info.title
    });

    // Upsert stats cache
    await req.db('youtube_channel_stats').insert({
      artist_id: req.params.artistId,
      channel_id: info.channel_id,
      subscriber_count: info.subscriber_count,
      view_count: info.view_count,
      video_count: info.video_count,
      channel_thumbnail: info.thumbnail,
      channel_description: info.description?.slice(0, 1000),
      fetched_at: new Date()
    }).onConflict('artist_id').merge();

    res.json({ ok: true, channel: info });
  } catch (err) {
    console.error('YouTube link error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Unlink YouTube channel from an artist
 */
router.post('/unlink/:artistId', requireAdmin, async (req, res) => {
  try {
    await req.db('artists').where({ id: req.params.artistId }).update({
      youtube_channel_id: null,
      youtube_channel_url: null,
      youtube_channel_title: null,
      youtube_last_sync: null
    });
    await req.db('youtube_channel_stats').where({ artist_id: req.params.artistId }).del();
    await req.db('youtube_accounts').where({ artist_id: req.params.artistId }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get combined channel status: linked channel stats + OAuth authorization info
 * Always returns status object even if nothing is set, so UI can react.
 */
router.get('/stats/:artistId', requireAuth, async (req, res) => {
  try {
    const artist = await req.db('artists').where({ id: req.params.artistId }).first();
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    const oauth = await req.db('youtube_accounts').where({ artist_id: req.params.artistId }).first();

    const response = {
      artist_id: artist.id,
      linked: !!artist.youtube_channel_id,
      linked_channel_id: artist.youtube_channel_id,
      linked_channel_title: artist.youtube_channel_title,
      linked_channel_url: artist.youtube_channel_url,
      oauth_connected: !!oauth,
      oauth_channel_id: oauth ? oauth.channel_id : null,
      oauth_channel_title: oauth ? oauth.channel_title : null,
      oauth_last_synced_at: oauth ? oauth.last_synced_at : null,
      oauth_sync_status: oauth ? oauth.sync_status : null,
      oauth_matches_linked: oauth && oauth.channel_id === artist.youtube_channel_id
    };

    if (!artist.youtube_channel_id) {
      return res.json(response);
    }

    let stats = await req.db('youtube_channel_stats').where({ artist_id: req.params.artistId }).first();

    const stale = !stats || (Date.now() - new Date(stats.fetched_at).getTime()) > 60 * 60 * 1000;
    const forceRefresh = req.query.refresh === '1';

    if (stale || forceRefresh) {
      const info = await yt.getChannelInfo(artist.youtube_channel_id);
      if (info) {
        await req.db('youtube_channel_stats').insert({
          artist_id: req.params.artistId,
          channel_id: info.channel_id,
          subscriber_count: info.subscriber_count,
          view_count: info.view_count,
          video_count: info.video_count,
          channel_thumbnail: info.thumbnail,
          channel_description: info.description?.slice(0, 1000),
          fetched_at: new Date()
        }).onConflict('artist_id').merge();
        stats = await req.db('youtube_channel_stats').where({ artist_id: req.params.artistId }).first();
      }
    }

    if (stats) {
      response.subscriber_count = parseInt(stats.subscriber_count || 0);
      response.view_count = parseInt(stats.view_count || 0);
      response.video_count = parseInt(stats.video_count || 0);
      response.channel_thumbnail = stats.channel_thumbnail;
      response.channel_description = stats.channel_description;
      response.fetched_at = stats.fetched_at;
    }

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Link the OAuth-authorized channel to the artist (explicit admin action)
 */
router.post('/link-authorized/:artistId', requireAdmin, async (req, res) => {
  try {
    const artistId = parseInt(req.params.artistId);
    const oauth = await req.db('youtube_accounts').where({ artist_id: artistId }).first();
    if (!oauth) return res.status(404).json({ error: 'No OAuth authorization found' });

    await req.db('artists').where({ id: artistId }).update({
      youtube_channel_id: oauth.channel_id,
      youtube_channel_url: 'https://www.youtube.com/channel/' + oauth.channel_id,
      youtube_channel_title: oauth.channel_title
    });

    // Cache public stats now (explicit)
    const info = await yt.getChannelInfo(oauth.channel_id);
    if (info) {
      await req.db('youtube_channel_stats').insert({
        artist_id: artistId,
        channel_id: info.channel_id,
        subscriber_count: info.subscriber_count,
        view_count: info.view_count,
        video_count: info.video_count,
        channel_thumbnail: info.thumbnail,
        channel_description: info.description?.slice(0, 1000),
        fetched_at: new Date()
      }).onConflict('artist_id').merge();
    }

    res.json({ ok: true, channel: info });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get recent videos
 */
router.get('/videos/:artistId', requireAuth, async (req, res) => {
  try {
    const artist = await req.db('artists').where({ id: req.params.artistId }).first();
    if (!artist || !artist.youtube_channel_id) {
      return res.status(404).json({ error: 'No YouTube channel linked' });
    }
    const max = Math.min(parseInt(req.query.limit) || 10, 50);
    const videos = await yt.getChannelVideos(artist.youtube_channel_id, max);
    res.json(videos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ OAUTH FLOW (for revenue data) ============

/**
 * Start OAuth flow (admin) — redirects to Google consent page
 */
router.get('/connect/:artistId', requireAdmin, (req, res) => {
  if (!yt.OAUTH_CONFIGURED) {
    return res.status(500).json({ error: 'YouTube OAuth is not configured. Set YT_CLIENT_ID and YT_CLIENT_SECRET.' });
  }
  const state = 'admin:' + req.params.artistId;
  const url = yt.getAuthUrl(state);
  res.redirect(url);
});

/**
 * Generate a shareable connect token for an artist (admin only)
 * Returns the URL to share with the artist
 */
router.post('/share-link/:artistId', requireAdmin, async (req, res) => {
  try {
    const artistId = parseInt(req.params.artistId);
    const artist = await req.db('artists').where({ id: artistId }).first();
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    // Generate a new token (invalidate any old ones)
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    // Remove any unused tokens for this artist
    await req.db('youtube_connect_tokens')
      .where({ artist_id: artistId })
      .whereNull('used_at')
      .del();

    await req.db('youtube_connect_tokens').insert({
      artist_id: artistId,
      token: token,
      expires_at: expiresAt
    });

    const host = req.get('host');
    const protocol = req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const fullUrl = `${protocol}://${host}/connect/${token}`;

    res.json({
      ok: true,
      token,
      url: fullUrl,
      expires_at: expiresAt,
      artist: { id: artist.id, name: artist.name }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Public: start OAuth flow for an orphan (unassigned) channel.
 * Artist doesn't need to identify themselves. Admin matches them later.
 * state format: "orphan"
 */
router.get('/orphan-connect', async (req, res) => {
  try {
    if (!yt.OAUTH_CONFIGURED) {
      return res.status(500).send('<h2>YouTube OAuth is not configured</h2>');
    }
    const url = yt.getAuthUrl('orphan');
    res.redirect(url);
  } catch (err) {
    res.status(500).send('<h2>Error: ' + err.message + '</h2>');
  }
});

/**
 * List all connected YouTube channels (standalone, no matching needed)
 */
router.get('/pending', requireAuth, async (req, res) => {
  try {
    const channels = await req.db('youtube_pending_connections')
      .orderBy('connected_at', 'desc');
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Admin: match a pending connection to an artist
 */
router.post('/match-pending/:pendingId/:artistId', requireAdmin, async (req, res) => {
  try {
    const pendingId = parseInt(req.params.pendingId);
    const artistId = parseInt(req.params.artistId);

    const pending = await req.db('youtube_pending_connections').where({ id: pendingId }).first();
    if (!pending) return res.status(404).json({ error: 'Pending connection not found' });

    const artist = await req.db('artists').where({ id: artistId }).first();
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    // Create OAuth account for the artist
    await req.db('youtube_accounts').insert({
      artist_id: artistId,
      channel_id: pending.channel_id,
      channel_title: pending.channel_title,
      refresh_token_encrypted: pending.refresh_token_encrypted,
      connected_at: pending.connected_at,
      sync_status: 'connected'
    }).onConflict('artist_id').merge();

    // Link the channel to the artist
    await req.db('artists').where({ id: artistId }).update({
      youtube_channel_id: pending.channel_id,
      youtube_channel_url: 'https://www.youtube.com/channel/' + pending.channel_id,
      youtube_channel_title: pending.channel_title
    });

    // Cache stats
    await req.db('youtube_channel_stats').insert({
      artist_id: artistId,
      channel_id: pending.channel_id,
      subscriber_count: pending.subscriber_count,
      view_count: pending.view_count,
      video_count: pending.video_count,
      channel_thumbnail: pending.channel_thumbnail,
      fetched_at: new Date()
    }).onConflict('artist_id').merge();

    // Mark pending as matched
    await req.db('youtube_pending_connections').where({ id: pendingId }).update({
      matched_at: new Date(),
      matched_artist_id: artistId
    });

    res.json({ ok: true, artist: artist.name, channel: pending.channel_title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Admin: delete a pending connection (reject)
 */
router.delete('/pending/:pendingId', requireAdmin, async (req, res) => {
  try {
    await req.db('youtube_pending_connections').where({ id: req.params.pendingId }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Public: get artist info by token (for the connect page)
 */
router.get('/connect-info/:token', async (req, res) => {
  try {
    const row = await req.db('youtube_connect_tokens')
      .join('artists', 'youtube_connect_tokens.artist_id', 'artists.id')
      .where('youtube_connect_tokens.token', req.params.token)
      .select(
        'youtube_connect_tokens.*',
        'artists.name as artist_name',
        'artists.nickname',
        'artists.youtube_channel_id',
        'artists.youtube_channel_title'
      )
      .first();

    if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This link has expired. Please request a new one from the admin.' });
    }

    // Check if there's already an OAuth connection
    const oauth = await req.db('youtube_accounts').where({ artist_id: row.artist_id }).first();

    res.json({
      artist_name: row.artist_name,
      nickname: row.nickname,
      already_connected: !!oauth,
      connected_channel_title: oauth ? oauth.channel_title : null,
      used: !!row.used_at,
      channel_title: row.youtube_channel_title
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Public: start OAuth flow using a token (no admin auth required)
 */
router.get('/public-connect/:token', async (req, res) => {
  try {
    if (!yt.OAUTH_CONFIGURED) {
      return res.status(500).send('<h2>YouTube OAuth is not configured</h2>');
    }
    const row = await req.db('youtube_connect_tokens').where({ token: req.params.token }).first();
    if (!row) return res.status(404).send('<h2>Invalid or expired link</h2>');
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return res.status(410).send('<h2>This link has expired. Please request a new one.</h2>');
    }

    // Start OAuth with token-based state
    const state = 'token:' + req.params.token;
    const url = yt.getAuthUrl(state);
    res.redirect(url);
  } catch (err) {
    res.status(500).send('<h2>Error: ' + err.message + '</h2>');
  }
});

/**
 * OAuth callback — Google redirects here after consent
 * State is either "admin:ID" (from admin panel) or "token:TOKEN" (from public link)
 */
router.get('/callback', async (req, res) => {
  const db = require('knex')(require('../knexfile'));
  try {
    const { code, state, error } = req.query;
    if (error) {
      return res.send(errorPage('Authorization cancelled', error, '/'));
    }
    if (!code || !state) {
      return res.status(400).send(errorPage('Missing code or state', 'Try again from the connect link.', '/'));
    }

    // Determine flow type from state
    let artistId, isPublicFlow = false, tokenRow = null, isOrphan = false;
    if (state === 'orphan') {
      // Orphan: no artist selected. Goes to pending queue.
      isOrphan = true;
      isPublicFlow = true;
    } else if (state.startsWith('admin:')) {
      artistId = parseInt(state.replace('admin:', ''));
    } else if (state.startsWith('token:')) {
      const token = state.replace('token:', '');
      tokenRow = await db('youtube_connect_tokens').where({ token }).first();
      if (!tokenRow) return res.status(404).send(errorPage('Invalid link', 'This connection link is no longer valid.', null));
      if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
        return res.status(410).send(errorPage('Link expired', 'Ask the admin for a new link.', null));
      }
      artistId = tokenRow.artist_id;
      isPublicFlow = true;
    } else if (state.startsWith('public:')) {
      artistId = parseInt(state.replace('public:', ''));
      isPublicFlow = true;
    } else {
      artistId = parseInt(state);
    }

    const tokens = await yt.exchangeCodeForTokens(code);

    if (!tokens.refresh_token) {
      return res.send(errorPage(
        'No refresh token received',
        "This usually happens if you have already authorized this app before. To fix: <ol><li>Go to <a href='https://myaccount.google.com/permissions' target='_blank'>Google Account Permissions</a></li><li>Remove access for 'Deng Parez Monetary System'</li><li>Try connecting again</li></ol>",
        isPublicFlow ? null : '/artists/' + artistId
      ));
    }

    const encryptedRefresh = yt.encrypt(tokens.refresh_token);
    const channelInfo = await yt.getAuthenticatedChannel(encryptedRefresh);

    if (!channelInfo) {
      return res.status(400).send(errorPage(
        'Could not identify channel',
        'Make sure the Google account you signed in with owns a YouTube channel.',
        isPublicFlow ? null : '/artists/' + artistId
      ));
    }

    let artist = null;

    if (isOrphan) {
      // Orphan flow: save to pending queue; admin will match later
      // Fetch public stats to include in pending entry
      const publicInfo = await yt.getChannelInfo(channelInfo.channel_id);
      await db('youtube_pending_connections').insert({
        channel_id: channelInfo.channel_id,
        channel_title: channelInfo.title,
        channel_thumbnail: publicInfo ? publicInfo.thumbnail : null,
        custom_url: publicInfo ? publicInfo.custom_url : null,
        refresh_token_encrypted: encryptedRefresh,
        subscriber_count: publicInfo ? publicInfo.subscriber_count : 0,
        view_count: publicInfo ? publicInfo.view_count : 0,
        video_count: publicInfo ? publicInfo.video_count : 0,
        connected_at: new Date()
      }).onConflict('channel_id').merge();
    } else {
      // Save OAuth tokens for specific artist
      await db('youtube_accounts').insert({
        artist_id: artistId,
        channel_id: channelInfo.channel_id,
        channel_title: channelInfo.title,
        refresh_token_encrypted: encryptedRefresh,
        connected_at: new Date(),
        sync_status: 'connected'
      }).onConflict('artist_id').merge();

      artist = await db('artists').where({ id: artistId }).first();

      // Mark token as used
      if (tokenRow) {
        await db('youtube_connect_tokens').where({ id: tokenRow.id }).update({
          used_at: new Date(),
          used_channel_id: channelInfo.channel_id
        });
      }
    }

    await db.destroy();

    // Success page
    const backButton = isPublicFlow
      ? ''
      : `<a class="btn" href="/artists/${artistId}">Back to Artist</a>`;
    const redirectScript = isPublicFlow
      ? ''
      : `<script>setTimeout(() => window.location.href = '/artists/${artistId}', 3000);</script>`;
    const artistName = isOrphan ? 'your account' : (artist ? artist.name : 'the artist');
    const orphanNote = isOrphan
      ? `<p style="color:#6b7280;font-size:14px;margin-top:14px;">Our team will link this channel to your profile shortly.</p>`
      : '';

    res.send(`
      <html><head><title>YouTube Connected</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:40px 20px;text-align:center;background:linear-gradient(135deg,#1e3a8a 0%,#3b82f6 100%);min-height:100vh;margin:0;}
        .card{background:#fff;border-radius:16px;padding:40px;max-width:500px;margin:40px auto;box-shadow:0 10px 40px rgba(0,0,0,0.15);}
        .icon{width:80px;height:80px;background:#10b981;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;}
        .icon svg{width:40px;height:40px;color:#fff;stroke:#fff;stroke-width:3;fill:none;}
        h2{color:#10b981;margin:0 0 10px;font-size:28px;}
        p{color:#4b5563;font-size:16px;line-height:1.5;}
        .channel{background:#f3f4f6;padding:15px;border-radius:8px;margin:20px 0;}
        .channel strong{color:#1f2937;font-size:18px;display:block;margin-bottom:4px;}
        .btn{background:#3b82f6;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:20px;font-weight:500;}
      </style>
      </head><body>
      <div class="card">
        <div class="icon">
          <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <h2>You're all set!</h2>
        <p>Your YouTube channel has been successfully connected for <strong>${artistName}</strong>.</p>
        <div class="channel">
          <strong>${channelInfo.title}</strong>
          <span style="color:#6b7280;font-size:14px;">Channel ID: ${channelInfo.channel_id}</span>
        </div>
        <p>${isPublicFlow ? 'You can now close this page. Deng Parez will sync your revenue data automatically.' : 'Revenue data is now available for syncing.'}</p>
        ${orphanNote}
        ${backButton}
      </div>
      ${redirectScript}
      </body></html>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err);
    await db.destroy().catch(() => {});
    res.status(500).send(errorPage('Error', err.message, null));
  }
});

function errorPage(title, message, backUrl) {
  const back = backUrl ? `<a href="${backUrl}" style="background:#3b82f6;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:20px;">Go Back</a>` : '';
  return `
    <html><head><title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:40px 20px;text-align:center;background:#f5f7fa;min-height:100vh;margin:0;}
      .card{background:#fff;border-radius:16px;padding:40px;max-width:500px;margin:40px auto;box-shadow:0 10px 40px rgba(0,0,0,0.08);}
      h2{color:#ef4444;margin:0 0 15px;}
      p,li{color:#4b5563;font-size:16px;line-height:1.6;}
      ol,ul{text-align:left;}
      a{color:#3b82f6;}
    </style>
    </head><body>
    <div class="card">
      <h2>${title}</h2>
      <div style="text-align:left;">${message}</div>
      ${back}
    </div>
    </body></html>
  `;
}

/**
 * Sync revenue for an artist (uses OAuth). Stores in youtube_revenue_history.
 */
router.post('/sync/:artistId', requireAdmin, async (req, res) => {
  try {
    const artistId = parseInt(req.params.artistId);
    const oauth = await req.db('youtube_accounts').where({ artist_id: artistId }).first();
    if (!oauth) return res.status(404).json({ error: 'YouTube account not connected for this artist' });

    // Default: last 12 months
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 12);

    const fmt = d => d.toISOString().slice(0, 10);

    const revenueData = await yt.getRevenue(
      oauth.refresh_token_encrypted,
      oauth.channel_id,
      req.body.startDate || fmt(startDate),
      req.body.endDate || fmt(endDate)
    );

    // Parse rows and store in history
    // columnHeaders order: month, views, estimatedRevenue, estimatedAdRevenue, grossRevenue, cpm, monetizedPlaybacks
    const rows = revenueData.rows || [];
    const saved = [];
    for (const r of rows) {
      const record = {
        artist_id: artistId,
        channel_id: oauth.channel_id,
        month: r[0],
        views: parseInt(r[1]) || 0,
        estimated_revenue: parseFloat(r[2]) || 0,
        estimated_ad_revenue: parseFloat(r[3]) || 0,
        gross_revenue: parseFloat(r[4]) || 0,
        cpm: parseFloat(r[5]) || 0,
        monetized_playbacks: parseInt(r[6]) || 0,
        synced_at: new Date()
      };
      await req.db('youtube_revenue_history').insert(record).onConflict(['artist_id', 'month']).merge();
      saved.push(record);
    }

    // Update last sync
    await req.db('youtube_accounts').where({ artist_id: artistId }).update({
      last_synced_at: new Date(),
      sync_status: 'success',
      last_error: null
    });

    res.json({
      ok: true,
      monthsSynced: saved.length,
      totalRevenue: saved.reduce((s, r) => s + r.estimated_revenue, 0),
      rows: saved
    });
  } catch (err) {
    console.error('Sync error:', err);
    await req.db('youtube_accounts').where({ artist_id: req.params.artistId }).update({
      sync_status: 'error',
      last_error: err.message
    }).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get stored revenue history for an artist
 */
router.get('/revenue-history/:artistId', requireAuth, async (req, res) => {
  try {
    const rows = await req.db('youtube_revenue_history')
      .where({ artist_id: req.params.artistId })
      .orderBy('month');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Overview: stats from ALL connected YouTube channels
 * (both standalone/orphan channels and artist-linked ones)
 */
router.get('/overview', requireAuth, async (req, res) => {
  try {
    // Get standalone connected channels (from /connect universal link)
    const standalone = await req.db('youtube_pending_connections').orderBy('connected_at', 'desc');

    // Get artist-linked channels
    const linked = await req.db('artists')
      .whereNotNull('youtube_channel_id')
      .leftJoin('youtube_channel_stats', 'artists.id', 'youtube_channel_stats.artist_id')
      .leftJoin('youtube_accounts', 'artists.id', 'youtube_accounts.artist_id')
      .select(
        'artists.id', 'artists.name', 'artists.nickname',
        'artists.youtube_channel_id', 'artists.youtube_channel_url', 'artists.youtube_channel_title',
        'youtube_channel_stats.subscriber_count', 'youtube_channel_stats.view_count',
        'youtube_channel_stats.video_count', 'youtube_channel_stats.channel_thumbnail',
        'youtube_accounts.last_synced_at', 'youtube_accounts.sync_status'
      );

    // Combine totals from both sources
    let totalSubs = 0, totalViews = 0, totalVideos = 0;

    standalone.forEach(c => {
      totalSubs += parseInt(c.subscriber_count || 0);
      totalViews += parseInt(c.view_count || 0);
      totalVideos += parseInt(c.video_count || 0);
    });

    linked.forEach(a => {
      totalSubs += parseInt(a.subscriber_count || 0);
      totalViews += parseInt(a.view_count || 0);
      totalVideos += parseInt(a.video_count || 0);
    });

    // Avoid double-counting if a channel is both standalone and linked
    const standaloneIds = new Set(standalone.map(c => c.channel_id));
    const uniqueLinked = linked.filter(a => !standaloneIds.has(a.youtube_channel_id));
    const totalChannels = standalone.length + uniqueLinked.length;

    const totals = {
      channels: totalChannels,
      subscribers: totalSubs,
      views: totalViews,
      videos: totalVideos,
      connected: standalone.length + linked.filter(a => a.sync_status).length,
      revenue: 0 // Will be populated from youtube_revenue_history if any
    };

    // Check for any revenue data
    const revTotal = await req.db('youtube_revenue_history').sum('estimated_revenue as total').first();
    totals.revenue = parseFloat(revTotal.total) || 0;

    res.json({ artists: linked, standalone, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Aggregate revenue trend across all artists (monthly)
 */
router.get('/trends', requireAuth, async (req, res) => {
  try {
    const trend = await req.db('youtube_revenue_history')
      .groupBy('month')
      .select('month')
      .sum('estimated_revenue as revenue')
      .sum('views as views')
      .sum('monetized_playbacks as monetized_playbacks')
      .orderBy('month');
    res.json(trend.map(t => ({
      month: t.month,
      revenue: parseFloat(t.revenue) || 0,
      views: parseInt(t.views) || 0,
      monetized_playbacks: parseInt(t.monetized_playbacks) || 0
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Disconnect OAuth
 */
router.post('/disconnect/:artistId', requireAdmin, async (req, res) => {
  try {
    await req.db('youtube_accounts').where({ artist_id: req.params.artistId }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
