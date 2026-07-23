const axios = require('axios');

// Only proxy images actually hosted on our own ImageKit account - the
// original Next.js version of this endpoint proxied any URL (open proxy).
const ALLOWED_HOST = 'ik.imagekit.io';

exports.proxyImage = async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ success: false, message: 'url query parameter is required' });
    }

    let target;
    try {
      target = new URL(url);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Invalid url' });
    }

    if (target.hostname !== ALLOWED_HOST) {
      return res.status(403).json({ success: false, message: 'This host is not allowed to be proxied' });
    }

    const response = await axios.get(target.toString(), {
      responseType: 'arraybuffer',
      timeout: 15000
    });

    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000');
    return res.status(200).send(response.data);
  } catch (err) {
    console.error('Error proxying image:', err.message);
    return res.status(502).json({ success: false, message: 'Failed to fetch image' });
  }
};
