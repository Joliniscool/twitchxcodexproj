import WebSocket from 'ws';

import { getTwitchHeaders, isUnauthorizedStatus, refreshAccessToken, validateToken } from './auth.js';

const DEFAULT_EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const SUBSCRIPTIONS_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';

export class EventSubClient {
  constructor({ accessToken, broadcasterId, onEvent, logger = console }) {
    this.accessToken = accessToken;
    this.broadcasterId = broadcasterId;
    this.onEvent = onEvent;
    this.logger = logger;
    this.socket = null;
    this.subscriptions = new Map();
    this.reconnectTimer = null;
    this.sessionId = null;
    this.isConnected = false;
  }

  async _refreshTokenIfNeeded(responseStatus) {
    if (!isUnauthorizedStatus(responseStatus)) {
      return false;
    }

    try {
      const refreshed = await refreshAccessToken({
        clientId: process.env.TWITCH_CLIENT_ID,
        refreshToken: process.env.TWITCH_REFRESH_TOKEN,
      });

      this.accessToken = refreshed.access_token;
      process.env.TWITCH_TOKEN = refreshed.access_token;
      this.logger.warn('[eventsub] token refreshed after 401');
      return true;
    } catch (error) {
      this.logger.error('[eventsub] failed to refresh token', error.message);
      return false;
    }
  }

  // The token's own user reads chat, and doubles as the broadcaster when BROADCASTER_ID is unset.
  async _ensureUserId() {
    if (this.userId) {
      return;
    }

    const info = await validateToken(this.accessToken);
    this.userId = info.user_id;
    this.broadcasterId = this.broadcasterId || info.user_id;
    this.logger.info('[eventsub] token valid', { login: info.login, scopes: info.scopes });
  }

  _buildSubscription(type, condition, version = '1') {
    return {
      type,
      version,
      condition,
      transport: {
        method: 'websocket',
        session_id: this.sessionId,
      },
    };
  }

  // EventSub over WebSocket only delivers events; subscriptions must be created through Helix.
  async _createSubscription(payload, retried = false) {
    const response = await fetch(SUBSCRIPTIONS_URL, {
      method: 'POST',
      headers: getTwitchHeaders(this.accessToken),
      body: JSON.stringify(payload),
    });

    if (!retried && await this._refreshTokenIfNeeded(response.status)) {
      return this._createSubscription(payload, true);
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(`${response.status} ${data?.message || response.statusText}`);
    }
  }

  async _subscribeToDefaults() {
    await this._ensureUserId();

    const broadcaster = { broadcaster_user_id: this.broadcasterId };
    const definitions = [
      ['channel.chat.message', { ...broadcaster, user_id: this.userId }],
      ['channel.subscribe', broadcaster],
      ['channel.subscription.gift', broadcaster],
      ['channel.raid', { to_broadcaster_user_id: this.broadcasterId }],
      ['channel.cheer', broadcaster],
      ['channel.channel_points_custom_reward_redemption.add', broadcaster],
    ];

    await Promise.all(definitions.map(async ([type, condition]) => {
      const payload = this._buildSubscription(type, condition);
      try {
        await this._createSubscription(payload);
        this.subscriptions.set(type, payload);
        this.logger.info(`[eventsub] subscribed to ${type}`);
      } catch (error) {
        this.logger.error(`[eventsub] failed to subscribe to ${type}: ${error.message}`);
      }
    }));
  }

  _handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.logger.error('[eventsub] invalid websocket payload', error.message);
      return;
    }

    const { metadata, payload } = message;

    if (metadata && metadata.message_type === 'session_welcome') {
      this.sessionId = payload.session.id;
      this.isConnected = true;
      this.logger.info('[eventsub] session welcome received', { sessionId: this.sessionId });
      this._subscribeToDefaults().catch((error) => {
        this.logger.error('[eventsub] subscription setup failed', error.message);
      });
      return;
    }

    if (metadata && metadata.message_type === 'keepalive') {
      this.logger.info('[eventsub] keepalive');
      return;
    }

    if (metadata && metadata.message_type === 'session_reconnect') {
      this.logger.warn('[eventsub] reconnect requested');
      this.reconnect();
      return;
    }

    if (!payload || !payload.event) {
      return;
    }

    const event = payload.event;
    const normalized = {
      type: 'chat',
      user: event.user_name || event.user_login || event.chatter_user_name || event.from_broadcaster_user_name || 'unknown',
      text: event.message || event.reward || event.message?.text || '',
      emotes: event.emotes || [],
      badges: event.badges || [],
      at: Date.now(),
      raw: event,
    };

    if (payload.subscription && payload.subscription.type === 'channel.subscribe') {
      normalized.type = 'sub';
      normalized.text = `${normalized.user} subscribed`;
    }

    if (payload.subscription && payload.subscription.type === 'channel.subscription.gift') {
      normalized.type = 'sub';
      normalized.text = `${normalized.user} gifted a subscription`;
    }

    if (payload.subscription && payload.subscription.type === 'channel.raid') {
      normalized.type = 'raid';
      normalized.text = `${normalized.user} raided the channel`;
    }

    if (payload.subscription && payload.subscription.type === 'channel.cheer') {
      normalized.type = 'cheer';
      normalized.text = `${normalized.user} cheered ${event.bits || 0} bits`;
    }

    if (payload.subscription && payload.subscription.type === 'channel.channel_points_custom_reward_redemption.add') {
      normalized.type = 'redemption';
      normalized.text = `${normalized.user} redeemed ${event.reward?.title || 'reward'}`;
    }

    if (payload.subscription && payload.subscription.type === 'channel.chat.message') {
      normalized.type = 'chat';
      normalized.text = event.message?.text || event.message || '';
    }

    if (typeof this.onEvent === 'function') {
      this.onEvent(normalized);
    }
  }

  reconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 1000);
  }

  connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (!this.accessToken) {
      this.logger.warn('[eventsub] no access token provided; skipping EventSub connection');
      return;
    }

    this.logger.info('[eventsub] connecting to Twitch EventSub');
    this.socket = new WebSocket(DEFAULT_EVENTSUB_URL, {
      headers: getTwitchHeaders(this.accessToken),
    });

    this.socket.on('open', () => {
      this.logger.info('[eventsub] websocket open');
    });

    this.socket.on('message', (data) => {
      this._handleMessage(data.toString());
    });

    this.socket.on('error', (error) => {
      this.logger.error('[eventsub] websocket error', error.message || error);
    });

    this.socket.on('close', (code, reason) => {
      this.isConnected = false;
      this.logger.warn('[eventsub] websocket closed', { code, reason: reason?.toString() });
      this.reconnect();
    });
  }
}
