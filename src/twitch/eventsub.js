import WebSocket from 'ws';

import { getTwitchHeaders, isUnauthorizedStatus, refreshAccessToken } from './auth.js';

const DEFAULT_EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

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

  _buildSubscription(type, version = '1') {
    return {
      type,
      version,
      condition: {
        broadcaster_user_id: this.broadcasterId,
      },
      transport: {
        method: 'websocket',
        session_id: this.sessionId,
      },
    };
  }

  _subscribeToDefaults() {
    const types = [
      'channel.chat.message',
      'channel.subscribe',
      'channel.subscription.gift',
      'channel.raid',
      'channel.cheer',
      'channel.channel_points_custom_reward_redemption.add',
    ];

    for (const type of types) {
      const payload = this._buildSubscription(type);
      this.subscriptions.set(type, payload);
      this._send({
        type: 'subscribe',
        payload,
      });
      this.logger.info(`[eventsub] subscribed to ${type}`);
    }
  }

  _send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.logger.warn('[eventsub] websocket not open, dropping message', message.type);
      return;
    }

    this.socket.send(JSON.stringify(message));
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
      this._subscribeToDefaults();
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
      user: event.user_name || event.user_login || event.chatter_user_name || 'unknown',
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
