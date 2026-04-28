const express = require('express');
const cors = require('cors');
const ytdlp = require('yt-dlp-exec');

const app = express();

app.use(cors());
app.use(express.json());

/** Sanitize a string to be safe for filenames */
const sanitize = (str) =>
  str.replace(/[^a-z0-9\-_\.]/gi, '_').substring(0, 100);

// ─── Root ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: '🎵 Music Downloader API is running (Vercel)',
    version: '3.0.0',
    note: 'Vercel edition — downloads are streamed directly, no disk storage.',
    endpoints: {
      youtubeInfo:             'GET  /api/info/youtube?url=VIDEO_URL',
      youtubeStream:           'GET  /api/stream/youtube?url=VIDEO_URL  (direct MP3 stream / download)',
      youtubePlaylistInfo:     'GET  /api/info/youtube/playlist?url=PLAYLIST_URL',
      spotifyInfo:             'GET  /api/info/spotify?url=SPOTIFY_URL',
      spotifyStream:           'GET  /api/stream/spotify?url=SPOTIFY_URL  (finds on YT, streams MP3)',
      spotifyPlaylistInfo:     'GET  /api/info/spotify/playlist?url=PLAYLIST_URL',
    },
  });
});

// ─── YouTube Info ─────────────────────────────────────────────────────────────

app.get('/api/info/youtube', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
    });

    res.json({
      success: true,
      data: {
        id: info.id,
        title: info.title,
        duration: info.duration,
        thumbnail: info.thumbnail,
        channel: info.channel || info.uploader,
        description: info.description
          ? info.description.substring(0, 300) + '…'
          : '',
        viewCount: info.view_count,
        uploadDate: info.upload_date,
      },
    });
  } catch (err) {
    console.error('YouTube info error:', err.message);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch video info', details: err.message });
  }
});

// ─── YouTube Stream (replaces download — pipes MP3 directly to client) ────────
//
//  On Vercel Pro the function timeout is 60 s which is enough for most songs.
//  On the free Hobby plan the limit is 10 s — consider upgrading or using
//  a different host (Railway, Render, Fly.io) for playlist/long-track use-cases.

app.get('/api/stream/youtube', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    // Fetch title first so we can set a nice filename header
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });

    const filename = `${sanitize(info.title)}.mp3`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Song-Title', info.title || '');
    res.setHeader('X-Song-Channel', info.channel || info.uploader || '');
    res.setHeader('X-Song-Duration', String(info.duration || 0));
    res.setHeader('X-Song-Thumbnail', info.thumbnail || '');

    const stream = ytdlp.exec(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      output: '-',
      noCheckCertificates: true,
    });

    stream.stdout.pipe(res);

    stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
    });

    req.on('close', () => {
      try { stream.kill(); } catch (_) {}
    });
  } catch (err) {
    console.error('Stream setup error:', err.message);
    if (!res.headersSent)
      res
        .status(500)
        .json({ success: false, error: 'Failed to setup stream', details: err.message });
  }
});

// ─── YouTube Playlist Info ────────────────────────────────────────────────────

app.get('/api/info/youtube/playlist', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      noCheckCertificates: true,
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const entries = (info.entries || []).map((e) => ({
      id: e.id,
      title: e.title,
      duration: e.duration,
      url: `https://www.youtube.com/watch?v=${e.id}`,
      thumbnail: e.thumbnail || `https://img.youtube.com/vi/${e.id}/hqdefault.jpg`,
      // Each track gets its own ready-to-use stream URL
      streamUrl: `${baseUrl}/api/stream/youtube?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${e.id}`
      )}`,
    }));

    res.json({
      success: true,
      data: {
        playlistId: info.id,
        title: info.title,
        channel: info.channel || info.uploader,
        totalTracks: entries.length,
        tracks: entries,
      },
    });
  } catch (err) {
    console.error('Playlist info error:', err.message);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch playlist info', details: err.message });
  }
});

// ─── Spotify Info ─────────────────────────────────────────────────────────────

app.get('/api/info/spotify', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    const { getData } = await import('spotify-url-info');
    const track = await getData(url);
    if (!track || !track.name) throw new Error('Could not parse Spotify track data');

    res.json({
      success: true,
      data: {
        name: track.name,
        artist: track.artists?.[0]?.name || 'Unknown Artist',
        artists: track.artists?.map((a) => a.name) || [],
        album: track.album?.name || 'Unknown Album',
        duration: track.duration_ms ? Math.floor(track.duration_ms / 1000) : 0,
        coverImage: track.coverArt?.sources?.[0]?.url || track.image || null,
        releaseDate: track.releaseDate || null,
        popularity: track.popularity || null,
        previewUrl: track.preview || null,
      },
    });
  } catch (err) {
    console.error('Spotify info error:', err.message);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch Spotify info', details: err.message });
  }
});

// ─── Spotify Stream ───────────────────────────────────────────────────────────
//  Resolves the Spotify track → finds best YouTube match → streams MP3

app.get('/api/stream/spotify', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    const { getData } = await import('spotify-url-info');
    const track = await getData(url);
    if (!track || !track.name) throw new Error('Could not parse Spotify track data');

    const artist = track.artists?.[0]?.name || '';
    const searchQuery = `${artist} ${track.name} official audio`;
    console.log('🔍 Searching YouTube for:', searchQuery);

    const searchResult = await ytdlp(`ytsearch1:${searchQuery}`, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });

    if (!searchResult?.id) throw new Error('No YouTube result found for this track');

    const youtubeUrl = `https://www.youtube.com/watch?v=${searchResult.id}`;
    const filename = `${sanitize(artist + '_' + track.name)}.mp3`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Song-Title', track.name || '');
    res.setHeader('X-Song-Artist', artist || '');
    res.setHeader('X-Song-Album', track.album?.name || '');
    res.setHeader('X-Song-Duration', String(track.duration_ms ? Math.floor(track.duration_ms / 1000) : 0));
    res.setHeader('X-Song-Thumbnail', track.coverArt?.sources?.[0]?.url || track.image || '');
    res.setHeader('X-Youtube-Url', youtubeUrl);

    const stream = ytdlp.exec(youtubeUrl, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      output: '-',
      noCheckCertificates: true,
    });

    stream.stdout.pipe(res);

    stream.on('error', (err) => {
      console.error('Spotify stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
    });

    req.on('close', () => {
      try { stream.kill(); } catch (_) {}
    });
  } catch (err) {
    console.error('Spotify stream setup error:', err.message);
    if (!res.headersSent)
      res
        .status(500)
        .json({ success: false, error: 'Failed to stream Spotify track', details: err.message });
  }
});

// ─── Spotify Playlist Info ────────────────────────────────────────────────────

app.get('/api/info/spotify/playlist', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    const { getData } = await import('spotify-url-info');
    const playlist = await getData(url);
    if (!playlist) throw new Error('Could not fetch Spotify playlist data');

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const items = playlist.tracks?.items || [];

    const tracks = items.map((item) => {
      const t = item.track || item;
      const artist = t.artists?.[0]?.name || 'Unknown';
      const spotifyTrackUrl = t.external_urls?.spotify || '';
      return {
        name: t.name,
        artist,
        album: t.album?.name || 'Unknown',
        duration: t.duration_ms ? Math.floor(t.duration_ms / 1000) : 0,
        coverImage: t.album?.images?.[0]?.url || null,
        // Each track gets a ready-to-use stream URL via our Spotify stream endpoint
        streamUrl: spotifyTrackUrl
          ? `${baseUrl}/api/stream/spotify?url=${encodeURIComponent(spotifyTrackUrl)}`
          : null,
      };
    });

    res.json({
      success: true,
      data: {
        name: playlist.name,
        description: playlist.description || '',
        owner: playlist.owner?.display_name || 'Unknown',
        totalTracks: tracks.length,
        coverImage: playlist.images?.[0]?.url || null,
        tracks,
      },
    });
  } catch (err) {
    console.error('Spotify playlist info error:', err.message);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch Spotify playlist', details: err.message });
  }
});

// ─── Global error handler ─────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ success: false, error: 'Internal server error', details: err.message });
});

module.exports = app;