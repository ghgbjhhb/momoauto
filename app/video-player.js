'use strict';

// Native Annex-B decoding. Video stays compressed until it reaches the browser;
// only the newest decoded frame is retained for the next display refresh.
(() => {
  const MAX_PACKET = 4 * 1024 * 1024;

  function nalUnits(data) {
    const starts = [];
    for (let i = 0; i + 3 < data.length; i++) {
      if (data[i] !== 0 || data[i + 1] !== 0) continue;
      const size = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
      if (size) { starts.push({ start: i, header: i + size }); i += size - 1; }
    }
    return starts.map((n, i) => ({ ...n, end: starts[i + 1]?.start ?? data.length, type: data[n.header] & 31 }));
  }

  function join(parts) {
    const result = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }

  class CloudVideoPlayer {
    static canReconnect(code) {
      return !['DEVICE_BUSY', 'VIDEO_LIMIT', 'VIEWER_LIMIT', 'VIDEO_CLOSED',
        'VIDEO_DECODER_UNSUPPORTED', 'VIDEO_CODEC_UNSUPPORTED', 'INPUT_BACKPRESSURE'].includes(code);
    }

    constructor({ canvas, deviceId, interactive = false, onMessage = () => {}, onFrame = () => {},
      onError = () => {}, onClose = () => {} }) {
      this.canvas = canvas;
      this.onMessage = onMessage;
      this.onFrame = onFrame;
      this.onError = onError;
      this.onClose = onClose;
      this.closed = false;
      this.epoch = 0;
      this.waitingForKey = true;
      this.pending = [];
      this.pendingBytes = 0;
      this.arrivals = new Map();
      this.stats = { packets: 0, bytes: 0, decoded: 0, rendered: 0, dropped: 0,
        resets: 0, frameAt: 0, decodeMs: 0, error: null };
      const url = new URL(interactive ? '/api/control' : '/api/video', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('deviceId', deviceId);
      this.socket = new WebSocket(url);
      this.socket.binaryType = 'arraybuffer';
      this.lastMessageAt = Date.now();
      this.visibleSince = Date.now();
      this.firstFrameDeadline = Date.now() + 15000;
      this.visibilityChanged = () => {
        if (this.closed) return;
        this.discardDisplayFrame();
        if (document.hidden) return;
        // Timers/RAF can be suspended by the browser while hidden. Discard old
        // decoded frames and request a keyframe instead of replaying that backlog.
        this.visibleSince = this.lastMessageAt = Date.now();
        this.firstFrameDeadline = Date.now() + 15000;
        if (this.codec) { this.stats.resets++; this.configure(); }
        this.refresh();
      };
      document.addEventListener('visibilitychange', this.visibilityChanged);
      this.socket.onmessage = event => {
        if (this.closed) return;
        this.lastMessageAt = Date.now();
        try {
          if (typeof event.data === 'string') {
            const message = JSON.parse(event.data);
            if (message.type === 'error' && message.code !== 'INPUT_FAILED') this.stats.error = message.code;
            this.onMessage(message);
            if (message.type === 'size') this.recoverFromDiscontinuity(false);
          } else {
            try {
              this.push(new Uint8Array(event.data));
            } catch {
              // A bad binary packet must not poison the decoder. Drop it and
              // restart the local reference chain at a fresh IDR frame.
              this.stats.dropped++;
              this.recoverFromDiscontinuity();
            }
          }
        } catch (error) { this.fail(error.code || 'VIDEO_DECODE_FAILED', '视频解码失败'); }
      };
      this.socket.onerror = () => { this.stats.error = 'VIDEO_CONNECTION_FAILED'; };
      this.socket.onclose = () => {
        if (this.closed) return;
        this.dispose();
        this.onClose(this.stats.error);
      };
      this.watchdog = setInterval(() => {
        const now = Date.now();
        if (now - this.lastMessageAt > 10000) {
          this.fail('VIDEO_FRAME_TIMEOUT', '视频画面等待超时');
        } else if (!document.hidden) {
          const fresh = this.stats.rendered && this.stats.frameAt >= this.visibleSince;
          if ((!fresh && now > this.firstFrameDeadline) || (fresh && now - this.stats.frameAt > 20000)) {
            this.fail('VIDEO_FRAME_STALLED', '视频画面停止更新');
          } else if (fresh && now - this.stats.frameAt > 4000) this.refresh();
        }
      }, 2000);
      if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
        queueMicrotask(() => this.fail('VIDEO_DECODER_UNSUPPORTED', '当前浏览器不支持 H.264 实时解码'));
      }
    }

    send(message) {
      if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
      if (this.socket.bufferedAmount > 32768) { this.fail('INPUT_BACKPRESSURE', '输入连接积压，已停止'); return false; }
      this.socket.send(JSON.stringify(message));
      return true;
    }

    refresh() {
      if (Date.now() - (this.lastRefreshAt || 0) < 800) return;
      if (this.send({ type: 'refresh' })) this.lastRefreshAt = Date.now();
    }

    push(data) {
      if (this.closed) return;
      if (!data.length || data.length > MAX_PACKET) throw new Error('Invalid video packet');
      this.stats.packets++;
      this.stats.bytes += data.length;
      const units = nalUnits(data);
      if (!units.length) throw new Error('Expected Annex-B video');
      let key = false, picture = false;
      for (const unit of units) {
        if (unit.type === 7) {
          if (unit.end - unit.header < 4 || unit.end - unit.start > 8192) throw new Error('Invalid SPS');
          const sps = data.slice(unit.start, unit.end);
          const signature = Array.from(sps).join(',');
          if (signature !== this.signature) {
            this.sps = sps;
            this.signature = signature;
            this.codec = 'avc1.' + Array.from(data.subarray(unit.header + 1, unit.header + 4), n => n.toString(16).padStart(2, '0')).join('');
            this.configure();
          }
        } else if (unit.type === 8) {
          if (unit.end - unit.start > 8192) throw new Error('Invalid PPS');
          this.pps = data.slice(unit.start, unit.end);
        }
        if (unit.type === 1 || unit.type === 5) picture = true;
        if (unit.type === 5) key = true;
      }
      if (!picture) return;
      const packet = { data, key, receivedAt: Date.now() };
      if (this.configuring) {
        if (this.pending.length >= 8 || this.pendingBytes + data.length > MAX_PACKET) {
          this.pending = []; this.pendingBytes = 0; this.waitingForKey = true; this.refresh();
          if (!key) return;
        }
        this.pending.push(packet); this.pendingBytes += data.length;
      } else this.decode(packet);
    }

    async configure() {
      const epoch = ++this.epoch;
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
      this.decoder = null;
      this.latest?.frame.close(); this.latest = null;
      this.arrivals.clear();
      this.waitingForKey = true;
      this.pending = []; this.pendingBytes = 0;
      this.configuring = true;
      try {
        const config = { codec: this.codec, optimizeForLatency: true,
          hardwareAcceleration: this.softwareFallback ? 'no-preference' : 'prefer-hardware' };
        let support = await VideoDecoder.isConfigSupported(config);
        if (!support.supported && !this.softwareFallback) {
          config.hardwareAcceleration = 'no-preference';
          support = await VideoDecoder.isConfigSupported(config);
        }
        if (this.closed || epoch !== this.epoch) return;
        if (!support.supported) { this.fail('VIDEO_CODEC_UNSUPPORTED', '当前浏览器无法解码此 H.264 视频'); return; }
        this.decoder = new VideoDecoder({
          output: frame => {
            if (this.closed || epoch !== this.epoch) { frame.close(); return; }
            this.output(frame);
          },
          error: () => {
            if (this.closed || epoch !== this.epoch) return;
            if (!this.softwareFallback) { this.softwareFallback = true; this.stats.resets++; this.configure(); this.refresh(); }
            else this.fail('VIDEO_DECODE_FAILED', 'H.264 视频解码失败');
          }
        });
        this.decoder.configure(config);
        this.decoderConfig = config;
        this.configuring = false;
        const pending = this.pending;
        this.pending = []; this.pendingBytes = 0;
        for (const packet of pending) this.decode(packet);
      } catch {
        if (!this.closed && epoch === this.epoch) this.fail('VIDEO_DECODER_FAILED', '视频解码器启动失败');
      }
    }

    decode({ data, key, receivedAt }) {
      if (!this.decoder || this.decoder.state !== 'configured' || !this.sps || !this.pps) return;

      // A stale delta frame must never be submitted after the decoder has been
      // marked discontinuous. Close the old reference chain and resume from a
      // fresh IDR instead of mixing old and new encoder generations.
      if (this.decoder.decodeQueueSize > 16 || Date.now() - receivedAt > 2000) {
        this.stats.dropped++;
        this.recoverFromDiscontinuity();
        return;
      }

      // 如果正在等待关键帧，丢弃所有无参考帧的 P 帧（防止参考帧缺失产生绿块/马赛克花屏）
      if (this.waitingForKey && !key) {
        this.stats.dropped++;
        return;
      }

      // 关键帧处理：检查数据包本身是否已包含 SPS/PPS，避免重复拼装导致 NAL 错乱花屏
      if (key) {
        this.waitingForKey = false;
        const units = nalUnits(data);
        const hasSps = units.some(u => u.type === 7);
        const hasPps = units.some(u => u.type === 8);
        if (!hasSps || !hasPps) {
          const parts = [];
          if (!hasSps && this.sps) parts.push(this.sps);
          if (!hasPps && this.pps) parts.push(this.pps);
          parts.push(data);
          data = join(parts);
        }
      }

      const timestamp = Math.max((this.timestamp || 0) + 1, Math.round(performance.now() * 1000));
      this.timestamp = timestamp;
      this.arrivals.set(timestamp, receivedAt);
      if (this.arrivals.size > 64) this.arrivals.delete(this.arrivals.keys().next().value);

      try {
        this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
      } catch {
        this.recoverFromDiscontinuity();
      }
    }

    recoverFromDiscontinuity(requestRefresh = true) {
      if (this.closed) return;
      this.waitingForKey = true;
      this.pending = []; this.pendingBytes = 0;
      this.arrivals.clear();
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
      this.decoder = null;
      if (!this.configuring && this.codec) {
        this.stats.resets++;
        this.configure();
      }
      if (requestRefresh) this.refresh();
    }

    output(frame) {
      this.stats.decoded++;
      const receivedAt = this.arrivals.get(frame.timestamp) || Date.now();
      for (const timestamp of this.arrivals.keys()) { if (timestamp <= frame.timestamp) this.arrivals.delete(timestamp); }
      if (document.hidden) { frame.close(); this.stats.dropped++; return; }
      if (this.latest) { this.latest.frame.close(); this.stats.dropped++; }
      this.latest = { frame, receivedAt };
      if (this.animation) return;
      this.animation = requestAnimationFrame(() => {
        this.animation = null;
        const latest = this.latest; this.latest = null;
        if (!latest) return;
        try {
          const { frame: image } = latest;
          if (this.canvas.width !== image.displayWidth) this.canvas.width = image.displayWidth;
          if (this.canvas.height !== image.displayHeight) this.canvas.height = image.displayHeight;
          // Keep the visible canvas synchronized with the compositor. The
          // desynchronized hint can expose a partially painted buffer while
          // high-rate H.264 frames are being replaced during screen motion.
          const ctx = this.context ||= this.canvas.getContext('2d', { alpha: false });
          ctx.drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
          this.stats.rendered++;
          this.stats.frameAt = latest.receivedAt;
          this.stats.decodeMs = Date.now() - latest.receivedAt;
          this.onFrame({ width: this.canvas.width, height: this.canvas.height, frameAt: latest.receivedAt });
        } catch { this.fail('VIDEO_RENDER_FAILED', '视频画面绘制失败'); }
        finally { latest.frame.close(); }
      });
    }

    fail(code, message) {
      if (this.closed) return;
      this.stats.error = code;
      this.onError({ code, message });
      this.dispose();
      this.socket.close();
      this.onClose(code);
    }

    discardDisplayFrame() {
      cancelAnimationFrame(this.animation); this.animation = null;
      this.latest?.frame.close(); this.latest = null;
    }

    dispose() {
      if (this.closed) return;
      this.closed = true; this.epoch++;
      clearInterval(this.watchdog);
      document.removeEventListener('visibilitychange', this.visibilityChanged);
      this.discardDisplayFrame();
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
      this.decoder = null; this.pending = []; this.pendingBytes = 0; this.arrivals.clear();
    }

    close() { this.dispose(); this.socket.close(); }
  }

  window.CloudVideoPlayer = CloudVideoPlayer;
})();
