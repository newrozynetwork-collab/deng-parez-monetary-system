const { google } = require('googleapis');
const crypto = require('crypto');

const API_KEY = process.env.YT_API_KEY;
const CLIENT_ID = process.env.YT_CLIENT_ID;
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET;
const REDIRECT_URI = process.env.YT_REDIRECT_URI || 'http://localhost:3000/api/youtube/callback';

// ============ ENCRYPTION (for refresh tokens) ============

function getEncryptionKey() {
  // Derive a 32-byte key from SESSION_SECRET
  const secret = process.env.SESSION_SECRET || 'default-insecure-secret';
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const [ivHex, dataHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getEncryptionKey(), iv);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

// ============ PUBLIC DATA (API KEY - no OAuth) ============

const youtube = google.youtube({ version: 'v3', auth: API_KEY });

/**
 * Extract channel ID from various YouTube URL formats
 * Supports: @handle, /channel/UC..., /c/name, /user/name
 */
async function resolveChannelId(input) {
  if (!input) return null;
  input = input.trim();

  // Already a channel ID (starts with UC, 24 chars)
  if (/^UC[\w-]{22}$/.test(input)) {
    return input;
  }

  // Extract from URL
  let handle = null, channelId = null, username = null;
  try {
    if (input.includes('youtube.com') || input.includes('youtu.be')) {
      const url = new URL(input.startsWith('http') ? input : 'https://' + input);
      const parts = url.pathname.split('/').filter(Boolean);

      if (parts[0] === 'channel' && parts[1]) channelId = parts[1];
      else if (parts[0] === 'c' && parts[1]) handle = parts[1];
      else if (parts[0] === 'user' && parts[1]) username = parts[1];
      else if (parts[0]?.startsWith('@')) handle = parts[0].substring(1);
    } else if (input.startsWith('@')) {
      handle = input.substring(1);
    } else {
      handle = input; // try as handle/search
    }
  } catch (e) {
    handle = input;
  }

  if (channelId) return channelId;

  // Try handle search
  if (handle) {
    try {
      const res = await youtube.channels.list({
        part: 'id',
        forHandle: '@' + handle
      });
      if (res.data.items && res.data.items.length > 0) {
        return res.data.items[0].id;
      }
    } catch (e) { /* fall through */ }
  }

  // Try username (legacy)
  if (username || handle) {
    try {
      const res = await youtube.channels.list({
        part: 'id',
        forUsername: username || handle
      });
      if (res.data.items && res.data.items.length > 0) {
        return res.data.items[0].id;
      }
    } catch (e) { /* fall through */ }
  }

  // Last resort: search
  const term = handle || username || input;
  try {
    const res = await youtube.search.list({
      part: 'snippet',
      q: term,
      type: 'channel',
      maxResults: 1
    });
    if (res.data.items && res.data.items.length > 0) {
      return res.data.items[0].snippet.channelId;
    }
  } catch (e) { /* fall through */ }

  return null;
}

/**
 * Fetch public channel info by channel ID (no OAuth needed)
 */
async function getChannelInfo(channelId) {
  const res = await youtube.channels.list({
    part: 'snippet,statistics,brandingSettings',
    id: channelId
  });

  if (!res.data.items || res.data.items.length === 0) {
    return null;
  }

  const ch = res.data.items[0];
  return {
    channel_id: ch.id,
    title: ch.snippet.title,
    description: ch.snippet.description,
    custom_url: ch.snippet.customUrl,
    thumbnail: ch.snippet.thumbnails?.medium?.url || ch.snippet.thumbnails?.default?.url,
    country: ch.snippet.country,
    published_at: ch.snippet.publishedAt,
    subscriber_count: parseInt(ch.statistics.subscriberCount || 0),
    view_count: parseInt(ch.statistics.viewCount || 0),
    video_count: parseInt(ch.statistics.videoCount || 0),
    hidden_subscribers: ch.statistics.hiddenSubscriberCount || false
  };
}

/**
 * Get recent videos for a channel (public)
 */
async function getChannelVideos(channelId, max = 10) {
  // First, get the uploads playlist ID
  const channelRes = await youtube.channels.list({
    part: 'contentDetails',
    id: channelId
  });

  if (!channelRes.data.items || channelRes.data.items.length === 0) {
    return [];
  }

  const uploadsPlaylistId = channelRes.data.items[0].contentDetails.relatedPlaylists.uploads;

  const videosRes = await youtube.playlistItems.list({
    part: 'snippet,contentDetails',
    playlistId: uploadsPlaylistId,
    maxResults: max
  });

  return (videosRes.data.items || []).map(item => ({
    video_id: item.contentDetails.videoId,
    title: item.snippet.title,
    thumbnail: item.snippet.thumbnails?.medium?.url,
    published_at: item.contentDetails.videoPublishedAt || item.snippet.publishedAt,
    description: item.snippet.description?.slice(0, 200)
  }));
}

// ============ OAUTH (for private/revenue data) ============

function getOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

/**
 * Generate the OAuth consent URL for an artist
 */
function getAuthUrl(state) {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',           // needed for refresh token
    prompt: 'consent',                 // force refresh token on re-auth
    scope: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/yt-analytics-monetary.readonly'
    ],
    state: state                       // artist_id as state
  });
}

/**
 * Exchange auth code for tokens
 */
async function exchangeCodeForTokens(code) {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, scope, ... }
}

/**
 * Get an authenticated client from a stored refresh token
 */
function getAuthenticatedClient(refreshTokenEncrypted) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    refresh_token: decrypt(refreshTokenEncrypted)
  });
  return oauth2Client;
}

/**
 * Get revenue data via YouTube Analytics API
 */
async function getRevenue(refreshTokenEncrypted, channelId, startDate, endDate) {
  const auth = getAuthenticatedClient(refreshTokenEncrypted);
  const youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth });

  const res = await youtubeAnalytics.reports.query({
    ids: 'channel==' + channelId,
    startDate: startDate,
    endDate: endDate,
    metrics: 'views,estimatedRevenue,estimatedAdRevenue,grossRevenue,cpm,monetizedPlaybacks',
    dimensions: 'month'
  });

  return res.data;
}

/**
 * Authenticated channel info (confirms which channel the OAuth belongs to)
 */
async function getAuthenticatedChannel(refreshTokenEncrypted) {
  const auth = getAuthenticatedClient(refreshTokenEncrypted);
  const yt = google.youtube({ version: 'v3', auth });
  const res = await yt.channels.list({
    part: 'snippet,statistics',
    mine: true
  });
  if (!res.data.items || res.data.items.length === 0) return null;
  const ch = res.data.items[0];
  return {
    channel_id: ch.id,
    title: ch.snippet.title,
    thumbnail: ch.snippet.thumbnails?.default?.url
  };
}

module.exports = {
  resolveChannelId,
  getChannelInfo,
  getChannelVideos,
  getAuthUrl,
  exchangeCodeForTokens,
  getAuthenticatedChannel,
  getRevenue,
  encrypt,
  decrypt,
  API_KEY_CONFIGURED: !!API_KEY,
  OAUTH_CONFIGURED: !!(CLIENT_ID && CLIENT_SECRET)
};
