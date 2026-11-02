'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { json, readJsonBody, redact, appendLogLine } = require('../http');
const { getAuthService } = require('../auth/service');
const { RapidOcrWorker } = require('../../automation/ocr');
const { YunmomoClient } = require('../../index');
const { extractDeviceInfo } = require('../../workflows/v2/import-real-params');
const { SCRIPT_DEFINITIONS, scriptById } = require('../script-catalog');
const { readRunOwner } = require('../script-runner');
const {
  PROJECT_ROOT,
  CLOUD_DISK_ROOT,
  HOST,
  activeToken,
  getRuntimeToken,
  getLocalEnv,
  activeScriptRuns,
  manualBridges,
  selectedDevice,
  screenshotJobs,
  client,
  listDevices,
  listDevicesWithToken,
  clearDeviceCache
} = require('../context');

const authService = getAuthService();

function requireAdmin(user, response) {
  if (!user || user.role !== 'admin') {
    json(response, 403, { ok: false, error: '无管理员访问权限' });
    return false;
  }
  return true;
}

function safeCloudDiskDir(dir) {
  return dir === '头像' ? '头像' : '真参';
}

function getCloudDiskFiles(dirName) {
  const dir = safeCloudDiskDir(dirName);
  const dirPath = path.join(CLOUD_DISK_ROOT, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dirPath, entry.name);
    try {
      const stat = fs.statSync(filePath);
      const ext = path.extname(entry.name).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext);
      const isText = ['.txt', '.json', '.xml', '.log', '.csv'].includes(ext);
      let previewInfo = null;
      if (dir === '真参' && (ext === '.txt' || ext === '.json')) {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          const info = extractDeviceInfo(parsed);
          if (info.brand || info.model) {
            previewInfo = info;
          }
        } catch {}
      }
      let zhencanStatus = null;
      if (dir === '真参') {
        const rec = authService.getZhencanFileRecord(entry.name);
        zhencanStatus = {
          status: rec?.status || 'available',
          isUsed: rec?.status === 'used',
          usedAt: rec?.used_at || null,
          usedAtFormatted: rec?.used_at ? new Date(rec.used_at).toLocaleString('zh-CN') : '',
          usedOnDeviceId: rec?.used_on_device_id || '',
          usedOnDeviceName: rec?.used_on_device_name || ''
        };
      }
      files.push({
        name: entry.name,
        size: stat.size,
        sizeFormatted: stat.size > 1024 * 1024
          ? (stat.size / (1024 * 1024)).toFixed(2) + ' MB'
          : (stat.size / 1024).toFixed(1) + ' KB',
        mtime: stat.mtimeMs,
        ext,
        isImage,
        isText,
        previewInfo,
        zhencanStatus
      });
    } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

async function previewImage(deviceId, tokenOrUser = null) {
  let token = typeof tokenOrUser === 'string' ? tokenOrUser : null;
  if (!token && tokenOrUser?.id) {
    token = authService.getDeviceAccessToken(tokenOrUser, deviceId);
  }
  const device = await selectedDevice(deviceId, token);
  const c = token ? new YunmomoClient({ token, timeoutMs: 15000 }) : client();
  const jobKey = `${deviceId}_${token || 'global'}`;
  if (screenshotJobs.has(jobKey)) return screenshotJobs.get(jobKey);
  const pending = c.screenshot(deviceId, {
    source: 'stream',
    udid: device.udid || undefined,
    maxSize: 1280,
    bitrate: 4194304,
    maxAgeMs: 400,
    timeoutMs: 15000
  });
  screenshotJobs.set(jobKey, pending);
  try {
    return await pending;
  } finally {
    if (screenshotJobs.get(jobKey) === pending) screenshotJobs.delete(jobKey);
  }
}

let sharedOcrWorker = null;
function getOcrWorker() {
  if (!sharedOcrWorker || sharedOcrWorker.closed) {
    sharedOcrWorker = new RapidOcrWorker();
  }
  return sharedOcrWorker;
}

async function inspectVision(deviceId, tokenOrUser = null) {
  const result = await previewImage(deviceId, tokenOrUser);
  try {
    const worker = getOcrWorker();
    const ocr = await worker.recognize(result.data);
    return {
      ok: true,
      deviceId,
      width: result.width || ocr.width || 720,
      height: result.height || ocr.height || 1280,
      count: (ocr.items || []).length,
      items: ocr.items || [],
      keyboardSwitches: ocr.keyboardSwitches || [],
      elapsed: ocr.elapsed || []
    };
  } catch (err) {
    return {
      ok: false,
      deviceId,
      error: err.message,
      items: []
    };
  }
}

async function handleConsoleRoutes(ctx, request, response, url) {
  const { user } = ctx;

  // --- Client & Server Logs ---
  if (request.method === 'POST' && url.pathname === '/api/client-logs') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const body = await readJsonBody(request);
    const level = String(body?.level || 'info').toUpperCase();
    const flatten = value => String(value).replace(/[\r\n]+/g, ' | ');
    const message = flatten(body?.message || '').slice(0, 500);
    const rawDetails = body?.details ? (typeof body.details === 'string' ? body.details : JSON.stringify(body.details)) : '';
    const details = flatten(rawDetails).slice(0, 2000);
    const userTag = user ? `[${user.email}]` : '[guest]';
    const logLine = `[Client ${level}] ${new Date().toISOString()} ${userTag} ${message} ${details}\n`;
    await appendLogLine(path.join(PROJECT_ROOT, 'logs', 'client.log'), logLine);
    console.log(`[ClientLog] ${level} ${userTag}: ${message}`);
    json(response, 200, { ok: true });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/client-logs') {
    if (!requireAdmin(user, response)) return true;
    try {
      const logPath = path.join(PROJECT_ROOT, 'logs', 'client.log');
      const content = await fs.promises.readFile(logPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean).slice(-100);
      json(response, 200, { ok: true, logs: lines });
    } catch {
      json(response, 200, { ok: true, logs: [] });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/server-logs') {
    if (!requireAdmin(user, response)) return true;
    try {
      const logPath = path.join(PROJECT_ROOT, 'logs', 'server.log');
      const content = await fs.promises.readFile(logPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean).slice(-300);
      json(response, 200, { ok: true, logs: lines });
    } catch {
      json(response, 200, { ok: true, logs: [] });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/server-logs/clear') {
    if (!requireAdmin(user, response)) return true;
    try {
      const logPath = path.join(PROJECT_ROOT, 'logs', 'server.log');
      await fs.promises.writeFile(logPath, '', 'utf8');
    } catch {}
    json(response, 200, { ok: true, message: '系统运行日志已清空' });
    return true;
  }

  // --- System Status & Runtime State ---
  if (request.method === 'GET' && url.pathname === '/api/status') {
    const runtimeTok = getRuntimeToken();
    const lEnv = getLocalEnv();
    const userToken = user ? authService.getUserPlatformToken(user.id) : '';
    const effectiveToken = userToken || activeToken();
    json(response, 200, {
      ok: true,
      tokenConfigured: Boolean(effectiveToken),
      sessionSource: userToken ? 'user-db' : (runtimeTok || lEnv.YUNMOMO_TOKEN ? 'local-session' : activeToken() ? 'environment' : 'none'),
      host: HOST
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/runtime-state') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const pageId = /^[A-Za-z0-9_-]{8,128}$/.test(url.searchParams.get('pageId') || '')
      ? url.searchParams.get('pageId') : '';
    const visibleRuns = [...activeScriptRuns.values()].filter(run =>
      user.role === 'admin' || (run.ownerUserId && run.ownerUserId === user.id));
    const runs = visibleRuns.map(run => ({
      scriptRunId: run.scriptRunId,
      scriptId: run.scriptId,
      title: scriptById(run.scriptId)?.title || run.scriptId,
      deviceId: run.deviceId,
      status: run.status,
      currentPage: Boolean(pageId && run.pageId === pageId)
    }));
    const manualByDevice = new Map();
    for (const bridge of manualBridges) {
      for (const item of bridge.getState(pageId)) {
        if (user.role !== 'admin' && !authService.canAccessDevice(user, item.deviceId)) continue;
        const current = manualByDevice.get(item.deviceId);
        if (!current) manualByDevice.set(item.deviceId, item);
        else {
          current.windows += item.windows;
          if (item.lastInputAt > current.lastInputAt) {
            current.lastInputAt = item.lastInputAt;
            current.lastInputFromCurrentPage = item.lastInputFromCurrentPage;
          }
        }
      }
    }
    json(response, 200, { ok: true, runs, manualDevices: [...manualByDevice.values()] });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/logs') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const scriptRunId = String(url.searchParams.get('scriptRunId') || url.searchParams.get('runId') || '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(scriptRunId)) {
      json(response, 400, { ok: false, error: '无效的日志调用编号' });
      return true;
    }
    const ownerUserId = await readRunOwner(scriptRunId);
    if (user.role !== 'admin' && ownerUserId !== user.id) {
      json(response, 403, { ok: false, error: '无权读取其他用户的执行日志' });
      return true;
    }
    const logPath = path.join(PROJECT_ROOT, 'logs', 'runs', `${scriptRunId}.log`);
    try {
      const content = await fs.promises.readFile(logPath, 'utf8');
      json(response, 200, { ok: true, scriptRunId, content: redact(content) });
    } catch {
      json(response, 404, { ok: false, error: '未找到指定调用的日志文件' });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/scripts') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const db = authService.db;
    const visibility = db.getScriptVisibility();
    const bundles = db.getScriptBundles();
    const isAdmin = Boolean(user && user.role === 'admin');

    json(response, 200, {
      ok: true,
      scripts: SCRIPT_DEFINITIONS,
      bundles,
      visibility,
      isAdmin
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/devices') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    if (user.role === 'admin') {
      json(response, 200, { ok: true, devices: await listDevices() });
    } else {
      // 自有云机和卡密租赁是并列的授权来源，不应该互相覆盖。
      const userToken = authService.getUserPlatformToken(user.id);
      let ownedDevices = [];
      if (userToken) {
        try {
          ownedDevices = await listDevicesWithToken(userToken);
          authService.setUserOwnedDevices(user.id, ownedDevices.map(device => device.deviceId), userToken);
        } catch (error) {
          // 平台临时超时不应撤销此前已核实的设备所有权；新 Token 会清除旧缓存。
          console.warn(`[User Devices] 用户 ${user.id} 自有云机拉取异常: ${error.message}`);
        }
      }

      // 租赁数据始终来自权益数据库；管理员平台暂时离线时仍可显示已分配的设备。
      let masterDevices = [];
      if (authService.db.getActiveAllocationsForUser(user.id).length) {
        try {
          masterDevices = await listDevices();
        } catch (error) {
          console.warn(`[User Devices] 租赁设备状态拉取异常: ${error.message}`);
        }
      }
      json(response, 200, {
        ok: true,
        devices: authService.getAccessibleDevices(user.id, ownedDevices, masterDevices)
      });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/vision-inspect') {
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) throw new Error('缺少 deviceId 参数');
    if (!user || !await authService.ensureDeviceAccess(user, deviceId)) {
      json(response, 403, { ok: false, error: '无权查看此设备或该设备已到期回收' });
      return true;
    }
    const inspection = await inspectVision(deviceId, user);
    json(response, 200, inspection);
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/screenshot') {
    const deviceId = url.searchParams.get('deviceId');
    if (!user || !await authService.ensureDeviceAccess(user, deviceId)) {
      json(response, 403, { ok: false, error: '无权查看此设备画面或该设备已到期回收' });
      return true;
    }
    const result = await previewImage(deviceId, user);
    response.writeHead(200, {
      'Content-Type': result.contentType || 'image/jpeg',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Screenshot-Source': result.source,
      'X-Image-Width': String(result.width),
      'X-Image-Height': String(result.height),
      'X-Frame-Decoded-At': result.decodedAt
    });
    response.end(result.data);
    return true;
  }

  // --- Cloud Disk Routes ---
  if (request.method === 'GET' && url.pathname === '/api/cloud-disk/files') {
    if (!requireAdmin(user, response)) return true;
    const dir = safeCloudDiskDir(url.searchParams.get('dir'));
    const files = getCloudDiskFiles(dir);
    const counts = {
      '真参': getCloudDiskFiles('真参').length,
      '头像': getCloudDiskFiles('头像').length
    };
    json(response, 200, { ok: true, dir, files, counts });
    return true;
  }

  if (request.method === 'GET' && (url.pathname === '/api/cloud-disk/file' || url.pathname === '/api/cloud-disk/preview' || url.pathname === '/api/cloud-disk/download')) {
    if (!requireAdmin(user, response)) return true;
    const dir = safeCloudDiskDir(url.searchParams.get('dir'));
    const rawName = url.searchParams.get('name') || '';
    const name = path.basename(rawName);
    if (!name) {
      json(response, 400, { ok: false, error: '缺少文件名' });
      return true;
    }
    let filePath = path.join(CLOUD_DISK_ROOT, dir, name);
    let exists = fs.existsSync(filePath);

    // 若本地不存在且为头像图片，尝试从云机平台私有网盘回源拉取
    if (!exists && dir === '头像') {
      try {
        const userToken = user ? authService.getUserPlatformToken(user.id) : '';
        const token = userToken || (user.role === 'admin' ? getRuntimeToken() : (process.env.YUNMOMO_TOKEN || getRuntimeToken()));
        if (token) {
          const c = new YunmomoClient({ token, timeoutMs: 15000 });
          const disk = c.cloudDisk();
          const listRes = await disk.list({ name, size: 5 });
          const match = (listRes.records || []).find(r => r.name === name);
          if (match && match.url) {
            const previewRes = await disk.resolveUrl(match);
            const downloadUrl = previewRes?.data || previewRes;
            if (typeof downloadUrl === 'string' && downloadUrl.startsWith('http')) {
              const remoteRes = await fetch(downloadUrl);
              if (remoteRes.ok) {
                const buf = Buffer.from(await remoteRes.arrayBuffer());
                fs.writeFileSync(filePath, buf);
                exists = true;
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[CloudDisk] 远端回源拉取失败 [${name}]: ${err.message}`);
      }
    }

    if (!exists) {
      json(response, 404, { ok: false, error: `文件 [${name}] 在云盘【${dir}】目录中不存在` });
      return true;
    }
    const ext = path.extname(name).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const fileBuffer = fs.readFileSync(filePath);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileBuffer.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(url.pathname.includes('download') || ext === '.svg'
        ? { 'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"` } : {})
    });
    response.end(fileBuffer);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/cloud-disk/upload') {
    if (!requireAdmin(user, response)) return true;
    const body = await readJsonBody(request, 50 * 1024 * 1024);
    const dir = safeCloudDiskDir(body?.dir);
    const rawName = body?.name || '';
    const name = path.basename(rawName.trim());
    const base64Data = body?.contentBase64 || '';
    if (!name || !base64Data) {
      json(response, 400, { ok: false, error: '缺少文件名或文件内容' });
      return true;
    }
    const buffer = Buffer.from(base64Data, 'base64');
    const targetPath = path.join(CLOUD_DISK_ROOT, dir, name);
    fs.writeFileSync(targetPath, buffer);
    json(response, 200, { ok: true, name, dir, size: buffer.length });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/cloud-disk/delete') {
    if (!requireAdmin(user, response)) return true;
    const body = await readJsonBody(request);
    const dir = safeCloudDiskDir(body?.dir);
    const rawName = body?.name || '';
    const name = path.basename(rawName.trim());
    if (!name) {
      json(response, 400, { ok: false, error: '缺少文件名' });
      return true;
    }
    const targetPath = path.join(CLOUD_DISK_ROOT, dir, name);
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    json(response, 200, { ok: true, name, dir });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/cloud-disk/zhencan/toggle-status') {
    if (!requireAdmin(user, response)) return true;
    const body = await readJsonBody(request);
    const rawName = body?.fileName || body?.name || '';
    const name = path.basename(String(rawName).trim());
    const targetStatus = body?.status === 'used' ? 'used' : 'available';
    if (!name) {
      json(response, 400, { ok: false, error: '缺少文件名' });
      return true;
    }
    authService.setZhencanFileStatus(name, targetStatus);
    const statusLabel = targetStatus === 'available' ? '【可用】' : '【已使用】';
    json(response, 200, {
      ok: true,
      fileName: name,
      status: targetStatus,
      message: `真参配置 [${name}] 状态已变更为: ${statusLabel}`
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/cloud-disk/send-to-device') {
    if (!requireAdmin(user, response)) return true;
    const body = await readJsonBody(request);
    const deviceId = String(body?.deviceId || '').trim();
    const dir = safeCloudDiskDir(body?.dir);
    const rawName = body?.name || '';
    const name = path.basename(rawName.trim());

    if (!deviceId) {
      json(response, 400, { ok: false, error: '请先选择目标云机' });
      return true;
    }
    if (!name) {
      json(response, 400, { ok: false, error: '缺少目标文件名' });
      return true;
    }
    if (user.role !== 'admin' && !await authService.ensureDeviceAccess(user, deviceId)) {
      json(response, 403, { ok: false, error: '无权操作此设备或该设备已到期回收' });
      return true;
    }

    const filePath = path.join(CLOUD_DISK_ROOT, dir, name);
    if (!fs.existsSync(filePath)) {
      json(response, 404, { ok: false, error: `文件 [${name}] 在 ${dir} 目录中不存在` });
      return true;
    }

    const c = client();
    if (!c.token) {
      json(response, 400, { ok: false, error: '平台会话令牌尚未配置，无法下发到云机' });
      return true;
    }

    if (dir === '真参') {
      // 校验真参文件使用状态 (单机单参规则)
      const record = authService.getZhencanFileRecord(name);
      if (record && record.status === 'used' && !body?.force) {
        const dateText = record.used_at ? new Date(record.used_at).toLocaleString('zh-CN') : '此前';
        const devText = record.used_on_device_name || record.used_on_device_id || '其他云机';
        json(response, 400, {
          ok: false,
          error: `该真参文件已于 ${dateText} 导入过云机 (${devText})！默认每个参数只能使用一次。如需重新使用，请先将其状态重置为【启用】。`
        });
        return true;
      }

      // 校验操作用户真参配额
      if (user.role !== 'admin') {
        const balance = authService.getUserZhencanBalance(user.id);
        if (balance <= 0) {
          json(response, 400, {
            ok: false,
            error: '真参额度不足（剩余 0 套）！请先通过卡密兑换真参配额后再执行推送。'
          });
          return true;
        }
      }

      const fileContent = fs.readFileSync(filePath, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(fileContent);
      } catch (err) {
        json(response, 400, { ok: false, error: `真参文件不是合法的 JSON 格式: ${err.message}` });
        return true;
      }
      const deviceInfo = extractDeviceInfo(parsed);
      if (!deviceInfo.brand || !deviceInfo.model) {
        json(response, 400, { ok: false, error: '真参文件中未解析到有效的手机品牌或型号' });
        return true;
      }
      const cloudRes = await c.device(deviceId).setDeviceInfo({
        brand: deviceInfo.brand,
        marketName: deviceInfo.marketName,
        model: deviceInfo.model,
        androidVersion: deviceInfo.androidVersion,
        devinfo: fileContent
      });
      const replyMsg = typeof cloudRes === 'string' ? cloudRes : (cloudRes?.message || cloudRes?.data || '设置成功');

      // 标记真参为已使用并核销额度
      let targetDevName = 'SF';
      try {
        const devList = await listDevices();
        targetDevName = devList.find(d => d.deviceId === deviceId)?.name || 'SF';
      } catch {}
      authService.markZhencanFileUsed(name, {
        userId: user.id,
        deviceId,
        deviceName: targetDevName
      });
      if (user.role !== 'admin') {
        authService.consumeZhencanQuota(user, 1, { fileName: name, deviceId, deviceName: targetDevName });
      }

      json(response, 200, {
        ok: true,
        message: `真参配置 [${name}] 已成功下发并应用到云机！已标记为已使用。品牌: ${deviceInfo.brand}, 型号: ${deviceInfo.model}`,
        deviceInfo,
        cloudResult: replyMsg
      });
      return true;
    }

    if (dir === '头像') {
      const fileBuffer = fs.readFileSync(filePath);
      const disk = c.cloudDisk();
      let listRes = await disk.list({ name });
      let fileRecord = listRes.records?.find(r => r.name === name);
      if (!fileRecord) {
        await disk.upload(fileBuffer, { fileName: name });
        listRes = await disk.list({ name });
        fileRecord = listRes.records?.find(r => r.name === name);
      }
      if (!fileRecord || !fileRecord.url) {
        json(response, 500, { ok: false, error: `未能获取到中转站文件记录: ${name}` });
        return true;
      }

      const sendRes = await disk.sendToDevices([deviceId], [fileRecord], { fileType: 'auto' });
      json(response, 200, {
        ok: true,
        message: `头像图片 [${name}] 已成功推送到云机相册！`,
        sendResult: sendRes
      });
      return true;
    }

    json(response, 400, { ok: false, error: '不支持的目录类别' });
    return true;
  }

  return false;
}

module.exports = {
  handleConsoleRoutes,
  safeCloudDiskDir,
  getCloudDiskFiles,
  previewImage,
  getOcrWorker,
  inspectVision
};
