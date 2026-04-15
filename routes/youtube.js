const router = require('express').Router();
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
 * Get cached channel stats (and refresh if stale)
 */
router.get('/stats/:artistId', requireAuth, async (req, res) => {
  try {
    const artist = await req.db('artists').where({ id: req.params.artistId }).first();
    if (!artist || !artist.youtube_channel_id) {
      return res.status(404).json({ error: 'No YouTube channel linked' });
    }

    let stats = await req.db('youtube_channel_stats').where({ artist_id: req.params.artistId }).first();

    // Refresh if older than 1 hour or on-demand
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

    // Check if this artist has OAuth connected
    const oauth = await req.db('youtube_accounts').where({ artist_id: req.params.artistId }).first();
    stats.oauth_connected = !!oauth;
    stats.last_synced_at = oauth ? oauth.last_synced_at : null;
    stats.sync_status = oauth ? oauth.sync_status : null;

    res.json(stats);
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
 * Start OAuth flow — redirects artist to Google consent page
 */
router.get('/connect/:artistId', requireAdmin, (req, res) => {
  if (!yt.OAUTH_CONFIGURED) {
    return res.status(500).json({ error: 'YouTube OAuth is not configured. Set YT_CLIENT_ID and YT_CLIENT_SECRET.' });
  }
  const url = yt.getAuthUrl(req.params.artistId);
  res.redirect(url);
});

/**
 * OAuth callback — Google redirects here after consent
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) {
      return res.send('<h2>Authorization cancelled</h2><p>' + error + '</p><p><a href="/artists">Back to Artists</a></p>');
    }
    if (!code || !state) {
      return res.status(400).send('<h2>Missing code or state</h2>');
    }

    const artistId = parseInt(state);
    const tokens = await yt.exchangeCodeForTokens(code);

    if (!tokens.refresh_token) {
      return res.send(`
        <h2>⚠️ No refresh token received</h2>
        <p>This usually happens if you've already authorized this app before. To fix:</p>
        <ol>
          <li>Go to <a href="https://myaccount.google.com/permissions" target="_blank">Google Account Permissions</a></li>
          <li>Remove access for "Deng Parez Monetary System"</li>
          <li>Try connecting again</li>
        </ol>
        <p><a href="/artists/${artistId}">Back to Artist</a></p>
      `);
    }

    // Figure out which channel the OAuth belongs to
    const encryptedRefresh = yt.encrypt(tokens.refresh_token);
    const channelInfo = await yt.getAuthenticatedChannel(encryptedRefresh);

    if (!channelInfo) {
      return res.status(400).send('<h2>Could not identify channel</h2><p>Make sure the Google account you signed in with owns a YouTube channel.</p>');
    }

    // Save to DB
    const db = require('knex')(require('../knexfile'));
    await db('youtube_accounts').insert({
      artist_id: artistId,
      channel_id: channelInfo.channel_id,
      channel_title: channelInfo.title,
      refresh_token_encrypted: encryptedRefresh,
      connected_at: new Date(),
      sync_status: 'connected'
    }).onConflict('artist_id').merge();

    // If artist doesn't have channel linked yet, link it now
    const artist = await db('artists').where({ id: artistId }).first();
    if (artist && !artist.youtube_channel_id) {
      await db('artists').where({ id: artistId }).update({
        youtube_channel_id: channelInfo.channel_id,
        youtube_channel_url: 'https://www.youtube.com/channel/' + channelInfo.channel_id,
        youtube_channel_title: channelInfo.title
      });
    }

    await db.destroy();

    res.send(`
      <html><head><title>YouTube Connected</title>
      <style>body{font-family:system-ui,sans-serif;padding:40px;text-align:center;background:#f5f7fa;}
        .card{background:#fff;border-radius:12px;padding:30px;max-width:500px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,0.08);}
        h2{color:#10b981;} .btn{background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:20px;}</style>
      </head><body>
      <div class="card">
        <h2>✅ YouTube Connected!</h2>
        <p><strong>${channelInfo.title}</strong> is now linked.</p>
        <p>You can now pull revenue data for this channel.</p>
        <a class="btn" href="/artists/${artistId}">Back to Artist</a>
      </div>
      <script>setTimeout(() => window.location.href = '/artists/${artistId}', 3000);</script>
      </body></html>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('<h2>Error: ' + err.message + '</h2><p><a href="/artists">Back</a></p>');
  }
});

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
 * Overview: all linked YouTube channels with stats
 */
router.get('/overview', requireAuth, async (req, res) => {
  try {
    const artists = await req.db('artists')
      .whereNotNull('youtube_channel_id')
      .select('id', 'name', 'nickname', 'youtube_channel_id', 'youtube_channel_url', 'youtube_channel_title');

    if (artists.length === 0) {
      return res.json({ artists: [], totals: { channels: 0, subscribers: 0, views: 0, videos: 0, connected: 0, revenue: 0 } });
    }

    const artistIds = artists.map(a => a.id);

    // Stats
    const stats = await req.db('youtube_channel_stats').whereIn('artist_id', artistIds);
    const statsMap = {};
    stats.forEach(s => { statsMap[s.artist_id] = s; });

    // OAuth accounts
    const accounts = await req.db('youtube_accounts').whereIn('artist_id', artistIds);
    const accountMap = {};
    accounts.forEach(a => { accountMap[a.artist_id] = a; });

    // Revenue totals from history
    const revenueTotals = await req.db('youtube_revenue_history')
      .whereIn('artist_id', artistIds)
      .groupBy('artist_id')
      .select('artist_id')
      .sum('estimated_revenue as total_revenue')
      .sum('views as total_views')
      .max('month as last_month');
    const revMap = {};
    revenueTotals.forEach(r => { revMap[r.artist_id] = r; });

    artists.forEach(a => {
      const s = statsMap[a.id] || {};
      const acc = accountMap[a.id];
      const rev = revMap[a.id] || {};
      a.stats = {
        subscriber_count: parseInt(s.subscriber_count || 0),
        view_count: parseInt(s.view_count || 0),
        video_count: parseInt(s.video_count || 0),
        channel_thumbnail: s.channel_thumbnail,
        fetched_at: s.fetched_at
      };
      a.oauth = acc ? {
        connected: true,
        channel_title: acc.channel_title,
        last_synced_at: acc.last_synced_at,
        sync_status: acc.sync_status,
        last_error: acc.last_error
      } : { connected: false };
      a.revenue_total = parseFloat(rev.total_revenue) || 0;
      a.views_tracked = parseInt(rev.total_views) || 0;
      a.last_month = rev.last_month;
    });

    // Aggregate totals
    const totals = {
      channels: artists.length,
      subscribers: artists.reduce((s, a) => s + a.stats.subscriber_count, 0),
      views: artists.reduce((s, a) => s + a.stats.view_count, 0),
      videos: artists.reduce((s, a) => s + a.stats.video_count, 0),
      connected: artists.filter(a => a.oauth.connected).length,
      revenue: artists.reduce((s, a) => s + a.revenue_total, 0)
    };

    res.json({ artists, totals });
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
