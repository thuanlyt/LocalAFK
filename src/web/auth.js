const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');

const router = express.Router();

router.get('/config', (req, res) => {
  res.json({
    oauthEnabled: config.oauthEnabled,
    passwordEnabled: config.passwordEnabled,
  });
});

router.get('/login', async (req, res) => {
  if (!config.oauthEnabled) return res.status(404).send('OAuth login chưa được cấu hình.');
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  try {
    await saveSession(req);
  } catch (err) {
    console.error('[auth] OAuth state session save failed:', err.message);
    return res.status(500).send('Không thể bắt đầu đăng nhập OAuth.');
  }

  const params = new URLSearchParams({
    client_id: config.oauth.clientId,
    redirect_uri: config.oauth.redirectUri,
    response_type: 'code',
    scope: 'identify',
    prompt: 'consent',
    state,
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

router.get('/callback', async (req, res) => {
  if (!config.oauthEnabled) return res.status(404).send('OAuth login chưa được cấu hình.');
  const { code, state } = req.query;
  if (!code) return res.redirect('/?error=missing_code');

  const expectedState = req.session.oauthState;
  delete req.session.oauthState;
  if (!state || !expectedState || state !== expectedState) {
    return res.redirect('/?error=invalid_state');
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.oauth.clientId,
        client_secret: config.oauth.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.oauth.redirectUri,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
    const tokenJson = await tokenRes.json();

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!userRes.ok) throw new Error(`failed to fetch user (${userRes.status})`);
    const user = await userRes.json();

    if (!config.ownerIds.includes(user.id)) {
      return res.status(403).send('Tài khoản Discord này không có quyền truy cập dashboard.');
    }

    const authedUser = {
      id: user.id,
      username: user.username,
      avatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : null,
      via: 'oauth',
    };

    // Regenerate the session (new ID) before attaching the authenticated user, to
    // avoid session fixation across the pre-auth -> authenticated transition.
    await regenerateSession(req);
    req.session.user = authedUser;
    await saveSession(req);
    res.redirect('/');
  } catch (err) {
    console.error('[auth] OAuth callback failed:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

router.post('/password', express.json(), async (req, res) => {
  if (!config.passwordEnabled) return res.status(404).json({ error: 'password_login_disabled' });
  const { password } = req.body || {};
  if (password !== config.dashboardPassword) {
    return res.status(401).json({ error: 'invalid_password' });
  }

  try {
    await regenerateSession(req);
    req.session.user = { id: 'dashboard', username: 'Dashboard', avatar: null, via: 'password' };
    await saveSession(req);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] password session save failed:', err.message);
    res.status(500).json({ error: 'session_error' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'unauthenticated' });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { router, requireAuth, saveSession, regenerateSession };
