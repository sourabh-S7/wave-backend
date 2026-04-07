const express = require('express');
const cors = require('cors');
const ytdlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs').promises;
const { existsSync } = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

const downloadsDir = path.join(__dirname, 'downloads');
if (!existsSync(downloadsDir)) {
  require('fs').mkdirSync(downloadsDir, { recursive: true });
}



/** Sanitize a string to be safe for filenames */
const sanitize = (str) => str.replace(/[^a-z0-9\-_\.]/gi, '_').substring(0, 100);

/** Build a public download URL from a filename */
const buildDownloadUrl = (req, filename) =>
  `${req.protocol}://${req.get('host')}/downloads/${filename}`;

/** Find the file that starts with a given timestamp prefix */
const findFileByTimestamp = async (timestamp) => {
  const files = await fs.readdir(downloadsDir);
  return files.find((f) => f.startsWith(timestamp.toString())) || null;
};

const cleanOldFiles = async () => {
  try {
    const files = await fs.readdir(downloadsDir);
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    for (const file of files) {
      const filePath = path.join(downloadsDir, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtimeMs > oneHour) {
        await fs.unlink(filePath);
        console.log(`🗑  Deleted old file: ${file}`);
      }
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
};
setInterval(cleanOldFiles, 30 * 60 * 1000);

app.get('/', (req, res) => {
  res.json({
    status: '🎵 Music Downloader API is running',
    version: '2.0.0',
    endpoints: {
      // YouTube
      youtubeInfo:             'GET  /api/info/youtube?url=VIDEO_URL',
      youtubeDownload:         'POST /api/download/youtube         body: { url }',
      youtubeStream:           'GET  /api/stream/youtube?url=VIDEO_URL',
      youtubePlaylistInfo:     'GET  /api/info/youtube/playlist?url=PLAYLIST_URL',
      youtubePlaylistDownload: 'POST /api/download/youtube/playlist body: { url }',
      // Spotify
      spotifyInfo:             'GET  /api/info/spotify?url=SPOTIFY_URL',
      spotifyDownload:         'POST /api/download/spotify         body: { url }',
      spotifyPlaylistInfo:     'GET  /api/info/spotify/playlist?url=SPOTIFY_PLAYLIST_URL',
      spotifyPlaylistDownload: 'POST /api/download/spotify/playlist body: { url }',
    },
  });
});

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
        duration: info.duration,           // seconds
        thumbnail: info.thumbnail,
        channel: info.channel || info.uploader,
        description: info.description ? info.description.substring(0, 300) + '…' : '',
        viewCount: info.view_count,
        uploadDate: info.upload_date,
      },
    });
  } catch (err) {
    console.error('YouTube info error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch video info', details: err.message });
  }
});

app.post('/api/download/youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required in body' });

  try {
    const timestamp = Date.now();
    const outputTemplate = path.join(downloadsDir, `${timestamp}-%(title)s.%(ext)s`);

    await ytdlp(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      output: outputTemplate,
      noCheckCertificates: true,
      preferFreeFormats: true,
      addMetadata: true,
      embedThumbnail: false,          // avoid ffmpeg thumbnail issues on Render free tier
    });

    const downloadedFile = await findFileByTimestamp(timestamp);
    if (!downloadedFile) throw new Error('Downloaded file not found on disk');

    res.json({
      success: true,
      message: 'Download completed',
      filename: downloadedFile,
      downloadUrl: buildDownloadUrl(req, downloadedFile),
    });
  } catch (err) {
    console.error('YouTube download error:', err.message);
    res.status(500).json({ success: false, error: 'Download failed', details: err.message });
  }
});

app.get('/api/stream/youtube', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });

    const filename = `${sanitize(info.title)}.mp3`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'audio/mpeg');

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
      // Client disconnected – kill the child process
      try { stream.kill(); } catch (_) {}
    });
  } catch (err) {
    console.error('Stream setup error:', err.message);
    if (!res.headersSent)
      res.status(500).json({ success: false, error: 'Failed to setup stream', details: err.message });
  }
});

app.get('/api/info/youtube/playlist', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    // --flat-playlist returns metadata without downloading
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      noCheckCertificates: true,
    });

    const entries = (info.entries || []).map((e) => ({
      id: e.id,
      title: e.title,
      duration: e.duration,
      url: `https://www.youtube.com/watch?v=${e.id}`,
      thumbnail: e.thumbnail || `https://img.youtube.com/vi/${e.id}/hqdefault.jpg`,
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
    res.status(500).json({ success: false, error: 'Failed to fetch playlist info', details: err.message });
  }
});

app.post('/api/download/youtube/playlist', async (req, res) => {
  const { url, maxTracks } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required in body' });

  const limit = Math.min(parseInt(maxTracks) || 50, 50); // cap at 50 tracks for server safety

  try {
    // Step 1 – get playlist metadata
    const playlistInfo = await ytdlp(url, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      noCheckCertificates: true,
    });

    const entries = (playlistInfo.entries || []).slice(0, limit);
    if (!entries.length) throw new Error('No tracks found in playlist');

    const results = [];
    const errors = [];

    // Step 2 – download each track sequentially (avoids rate limits)
    for (const entry of entries) {
      const videoUrl = `https://www.youtube.com/watch?v=${entry.id}`;
      const timestamp = Date.now();
      const outputTemplate = path.join(downloadsDir, `${timestamp}-%(title)s.%(ext)s`);

      try {
        await ytdlp(videoUrl, {
          extractAudio: true,
          audioFormat: 'mp3',
          audioQuality: 0,
          output: outputTemplate,
          noCheckCertificates: true,
          preferFreeFormats: true,
          addMetadata: true,
        });

        const downloadedFile = await findFileByTimestamp(timestamp);
        if (downloadedFile) {
          results.push({
            title: entry.title,
            filename: downloadedFile,
            downloadUrl: buildDownloadUrl(req, downloadedFile),
          });
        }
      } catch (trackErr) {
        errors.push({ title: entry.title, error: trackErr.message });
      }

      // Small delay between tracks to be polite to YouTube
      await new Promise((r) => setTimeout(r, 1500));
    }

    res.json({
      success: true,
      playlistTitle: playlistInfo.title,
      totalRequested: entries.length,
      totalDownloaded: results.length,
      failed: errors.length,
      tracks: results,
      errors,
    });
  } catch (err) {
    console.error('Playlist download error:', err.message);
    res.status(500).json({ success: false, error: 'Playlist download failed', details: err.message });
  }
});


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
    res.status(500).json({ success: false, error: 'Failed to fetch Spotify info', details: err.message });
  }
});


app.post('/api/download/spotify', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required in body' });

  try {
    const { getData } = await import('spotify-url-info');
    const track = await getData(url);

    if (!track || !track.name) throw new Error('Could not parse Spotify track data');

    const artist = track.artists?.[0]?.name || '';
    const name = track.name;
    const searchQuery = `${artist} ${name} official audio`;

    console.log('🔍 Searching YouTube for:', searchQuery);

    const searchResult = await ytdlp(`ytsearch1:${searchQuery}`, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });

    if (!searchResult?.id) throw new Error('No YouTube result found for this track');

    const youtubeUrl = `https://www.youtube.com/watch?v=${searchResult.id}`;
    const timestamp = Date.now();
    const outputTemplate = path.join(downloadsDir, `${timestamp}-%(title)s.%(ext)s`);

    await ytdlp(youtubeUrl, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      output: outputTemplate,
      noCheckCertificates: true,
      preferFreeFormats: true,
      addMetadata: true,
    });

    const downloadedFile = await findFileByTimestamp(timestamp);
    if (!downloadedFile) throw new Error('Downloaded file not found on disk');

    res.json({
      success: true,
      message: 'Download completed',
      spotifyInfo: { track: name, artist, album: track.album?.name || 'Unknown' },
      youtubeUrl,
      filename: downloadedFile,
      downloadUrl: buildDownloadUrl(req, downloadedFile),
    });
  } catch (err) {
    console.error('Spotify download error:', err.message);
    res.status(500).json({ success: false, error: 'Spotify download failed', details: err.message });
  }
});


app.get('/api/info/spotify/playlist', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    const { getData } = await import('spotify-url-info');
    const playlist = await getData(url);

    if (!playlist) throw new Error('Could not fetch Spotify playlist data');


    const items = playlist.tracks?.items || [];
    const tracks = items.map((item) => {
      const t = item.track || item;
      return {
        name: t.name,
        artist: t.artists?.[0]?.name || 'Unknown',
        album: t.album?.name || 'Unknown',
        duration: t.duration_ms ? Math.floor(t.duration_ms / 1000) : 0,
        coverImage: t.album?.images?.[0]?.url || null,
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
    res.status(500).json({ success: false, error: 'Failed to fetch Spotify playlist', details: err.message });
  }
});

app.post('/api/download/spotify/playlist', async (req, res) => {
  const { url, maxTracks } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required in body' });

  const limit = Math.min(parseInt(maxTracks) || 20, 20); // cap at 20 for Render free tier

  try {
    const { getData } = await import('spotify-url-info');
    const playlist = await getData(url);

    if (!playlist || !playlist.tracks) throw new Error('Could not fetch Spotify playlist data');

    const items = (playlist.tracks?.items || []).slice(0, limit);
    if (!items.length) throw new Error('No tracks found in playlist');

    const results = [];
    const errors = [];

    for (const item of items) {
      const t = item.track || item;
      if (!t?.name) continue;

      const artist = t.artists?.[0]?.name || '';
      const name = t.name;
      const searchQuery = `${artist} ${name} official audio`;

      try {
        console.log(`🔍 Searching: ${searchQuery}`);

        const searchResult = await ytdlp(`ytsearch1:${searchQuery}`, {
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
        });

        if (!searchResult?.id) throw new Error('No YouTube result found');

        const youtubeUrl = `https://www.youtube.com/watch?v=${searchResult.id}`;
        const timestamp = Date.now();
        const outputTemplate = path.join(downloadsDir, `${timestamp}-%(title)s.%(ext)s`);

        await ytdlp(youtubeUrl, {
          extractAudio: true,
          audioFormat: 'mp3',
          audioQuality: 0,
          output: outputTemplate,
          noCheckCertificates: true,
          preferFreeFormats: true,
          addMetadata: true,
        });

        const downloadedFile = await findFileByTimestamp(timestamp);
        if (downloadedFile) {
          results.push({
            track: name,
            artist,
            filename: downloadedFile,
            downloadUrl: buildDownloadUrl(req, downloadedFile),
          });
        }
      } catch (trackErr) {
        errors.push({ track: name, artist, error: trackErr.message });
      }

      // Delay between each track
      await new Promise((r) => setTimeout(r, 2000));
    }

    res.json({
      success: true,
      playlistName: playlist.name,
      totalRequested: items.length,
      totalDownloaded: results.length,
      failed: errors.length,
      tracks: results,
      errors,
    });
  } catch (err) {
    console.error('Spotify playlist download error:', err.message);
    res.status(500).json({ success: false, error: 'Spotify playlist download failed', details: err.message });
  }
});


app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ success: false, error: 'Internal server error', details: err.message });
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Downloads directory: ${downloadsDir}`);
});