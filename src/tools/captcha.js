'use strict';

/**
 * ============================================================================
 * 点选验证码 DeepSeek 视觉解析工具 (Single-File Captcha Solver)
 * ============================================================================
 *
 * 【功能说明】：
 * 输入点选验证码图片（按顺序点击类），调用 DeepSeek 多模态视觉 API：
 * 1. 识别顶部提示栏要求点击的各个参考图标（按从左到右顺序：第1个、第2个、第3个...）；
 * 2. 在下方混淆图片中按顺序定位目标图标（支持旋转抗畸变、排除干扰项）；
 * 3. 输出顺序、目标名称、像素绝对坐标 (x, y) 与归一化相对坐标，以及“确定”按钮坐标。
 *
 * 【用法 1：作为独立脚本在命令行运行】
 *   node src/tools/captcha.js "d:/path/to/captcha.png"
 *
 * 【用法 2：在其他代码中导入调用】
 *   const { solveCaptcha } = require('./src/tools/captcha');
 *
 *   // 方式 A: 传入本地图片路径
 *   const res1 = await solveCaptcha('./captcha.png');
 *
 *   // 方式 B: 传入图片 Buffer (如真机截图)
 *   const res2 = await solveCaptcha(imageBuffer);
 *
 *   // 方式 C: 传入 Base64 字符串
 *   const res3 = await solveCaptcha('data:image/png;base64,iVBORw0KG...');
 *
 * 【输出数据结构】：
 * {
 *   "ok": true,
 *   "promptOrder": ["药箱", "日历", "方向盘"],       // 顶部要求的顺序
 *   "targets": [
 *     {
 *       "order": 1,                                  // 点击顺序 (1, 2, 3...)
 *       "name": "药箱",                              // 图标名称
 *       "feature": "蓝色线框药箱，旋转约45度呈菱形",  // 视觉特征
 *       "x": 165,                                    // 真实像素 X 坐标 (若能解析图片宽高)
 *       "y": 236,                                    // 真实像素 Y 坐标
 *       "normalizedX": 0.44,                         // 归一化 X (0.0~1.0)
 *       "normalizedY": 0.55                          // 归一化 Y (0.0~1.0)
 *     },
 *     ...
 *   ],
 *   "confirmButton": {                               // 底部“确定”按钮坐标
 *     "x": 188,
 *     "y": 330,
 *     "normalizedX": 0.5,
 *     "normalizedY": 0.77
 *   }
 * }
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 自动获取 DeepSeek API Key（无需额外模块依赖）
 */
function resolveApiKey(customKey) {
  if (customKey && typeof customKey === 'string' && customKey.trim()) {
    return customKey.trim();
  }
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) {
    return process.env.DEEPSEEK_API_KEY.trim();
  }
  // 读取项目本地运行时配置
  try {
    const configPath = path.join(__dirname, '../../.runtime/ai-reply/settings.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed.apiKey && parsed.apiKey.trim()) return parsed.apiKey.trim();
    }
  } catch {}
  // 读取 .env.local
  try {
    const envPath = path.join(__dirname, '../../.env.local');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/DEEPSEEK_API_KEY\s*=\s*["']?([^"'\r\n]+)/);
      if (match) return match[1].trim();
    }
  } catch {}
  return '';
}

/**
 * 从 Buffer 二进制头部解析 PNG / JPEG 的像素宽高
 */
function getImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xFF) break;
      const marker = buffer[offset + 1];
      if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC9 && marker <= 0xCB)) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return null;
}

/**
 * 核心解析函数：输入图片 -> 输出坐标与顺序
 *
 * @param {string | Buffer | object} imageInput 图片路径、Base64 字符串、Buffer 或带 data 的截图对象
 * @param {object} [options]
 * @param {string} [options.apiKey] 显式传入 API Key（可选，默认自动读取配置）
 * @param {string} [options.endpoint] 接口地址（默认 https://api.deepseek.com）
 * @param {string} [options.model] 模型名（默认 deepseek-flash）
 * @param {number} [options.timeoutMs] 超时毫秒（默认 60000）
 */
async function solveCaptcha(imageInput, options = {}) {
  const started = Date.now();
  if (!imageInput) {
    throw new TypeError('solveCaptcha 必须传入图像参数（支持图片文件路径、Buffer 二进制、Base64 或截图对象）');
  }

  let buffer = null;
  let base64 = '';
  let mimeType = 'image/png';
  let width = options.width || null;
  let height = options.height || null;

  // 1. 提取 Base64 与图像尺寸
  if (typeof imageInput === 'string') {
    const trimmed = imageInput.trim();
    if (trimmed.startsWith('data:image/')) {
      const match = trimmed.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        mimeType = match[1];
        base64 = match[2];
        buffer = Buffer.from(base64, 'base64');
      } else {
        base64 = trimmed;
      }
    } else if (fs.existsSync(trimmed)) {
      buffer = await fs.promises.readFile(trimmed);
      base64 = buffer.toString('base64');
      const ext = path.extname(trimmed).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
      else if (ext === '.webp') mimeType = 'image/webp';
    } else {
      base64 = trimmed;
      try { buffer = Buffer.from(base64, 'base64'); } catch {}
    }
  } else if (Buffer.isBuffer(imageInput)) {
    buffer = imageInput;
    base64 = buffer.toString('base64');
  } else if (typeof imageInput === 'object' && imageInput !== null) {
    if (Buffer.isBuffer(imageInput.data)) {
      buffer = imageInput.data;
      base64 = buffer.toString('base64');
    } else if (typeof imageInput.data === 'string') {
      const trimmed = imageInput.data.trim();
      const match = trimmed.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        mimeType = match[1];
        base64 = match[2];
        buffer = Buffer.from(base64, 'base64');
      } else {
        base64 = trimmed;
      }
    }
    if (imageInput.width) width ||= imageInput.width;
    if (imageInput.height) height ||= imageInput.height;
  }

  if (!base64) {
    throw new Error('无法从输入参数中提取有效的图像数据');
  }

  // 自动检测像素宽高
  if ((!width || !height) && buffer) {
    const dims = getImageDimensions(buffer);
    if (dims) {
      width = dims.width;
      height = dims.height;
    }
  }

  // 2. 获取 API 凭证
  const apiKey = resolveApiKey(options.apiKey);
  if (!apiKey) {
    throw new Error('未检测到 DeepSeek API Key，请在 .runtime/ai-reply/settings.json 或环境变量中配置');
  }

  const endpoint = (options.endpoint || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = options.model || 'deepseek-flash';
  const reasoningEffort = options.reasoningEffort || 'low';
  const timeoutMs = options.timeoutMs || 60000;

  // 3. 构建精准视觉提示词
  const prompt = `你是一个专业的图形验证码视觉识别引擎。当前图片是一张“按顺序依次点击”的图标点选类验证码。
【关键识别规范】：
1. 观察右上角/顶部提示栏中的参考图标，它们是严格按照“从左到右”的顺序排列的点击顺序（第1个、第2个、第3个...）。
   - 仔细识别每个参考图标的独特几何与语义特征（例如：声波人头、带水波纹的水盆/水槽、弯曲电话听筒、学士帽、餐具等）。
2. 在下方大图中按完全相同的顺序，逐一找到对应图标：
   - 【低对比度防漏判】：大图背景为复杂风景/城市像素画。彩色线框（如黄、绿、蓝、粉等）散落其中。某些暗色/蓝色线框可能绘制在深色建筑物或深色地面上，对比度偏低，请务必细致巡检整张大图，切勿遗漏！
   - 【排除干扰项】：大图中必然包含1个纯干扰项（例如只有内外双层菱形方框、内部没有水纹或特殊结构的线框）。请务必核对内部结构（如水盆内部必须有水波纹、听筒有弯曲握把），坚决排除纯几何干扰项！
3. 返回每个目标在整张输入图片中的归一化点击中心坐标 (x, y)，取值范围 0.0 ~ 1.0（图片左上角为 0,0，右下角为 1,1）。
4. 给出底部“确定”按钮的中心归一化坐标。

必须直接输出标准 JSON 对象，禁止包含 Markdown 标记或多余文字。根字段包含：
{
  "promptOrder": ["第1个图标名称", "第2个图标名称", "第3个图标名称"],
  "targets": [
    {
      "order": 1,
      "name": "图标名称",
      "feature": "视觉特征说明（颜色、位置、旋转等）",
      "x": 0.25,
      "y": 0.50
    }
  ],
  "confirmButton": {
    "x": 0.5,
    "y": 0.77
  }
}`;

  // 4. 调用 API
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resText = '';
  let usage = null;

  try {
    const response = await fetch(endpoint + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model,
        reasoning_effort: reasoningEffort,
        response_format: { type: 'json_object' },
        temperature: 0.1,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API 请求失败 (HTTP ${response.status}): ${await response.text()}`);
    }

    const payload = await response.json();
    resText = payload.choices?.[0]?.message?.content || '{}';
    usage = payload.usage || null;
  } finally {
    clearTimeout(timer);
  }

  // 5. 解析并换算坐标
  let parsed = {};
  try {
    parsed = JSON.parse(resText);
  } catch {
    const cleaned = resText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  }

  const rawTargets = Array.isArray(parsed.targets) ? parsed.targets : [];
  const targets = rawTargets.map((item, idx) => {
    const order = Number(item.order) || (idx + 1);
    const normX = Math.max(0, Math.min(1, Number(item.x) || 0));
    const normY = Math.max(0, Math.min(1, Number(item.y) || 0));
    return {
      order,
      name: String(item.name || `目标${order}`),
      feature: String(item.feature || ''),
      x: width ? Math.round(normX * width) : null,
      y: height ? Math.round(normY * height) : null,
      normalizedX: Math.round(normX * 10000) / 10000,
      normalizedY: Math.round(normY * 10000) / 10000
    };
  }).sort((a, b) => a.order - b.order);

  let confirmButton = null;
  if (parsed.confirmButton) {
    const cNormX = Math.max(0, Math.min(1, Number(parsed.confirmButton.x) || 0));
    const cNormY = Math.max(0, Math.min(1, Number(parsed.confirmButton.y) || 0));
    confirmButton = {
      x: width ? Math.round(cNormX * width) : null,
      y: height ? Math.round(cNormY * height) : null,
      normalizedX: Math.round(cNormX * 10000) / 10000,
      normalizedY: Math.round(cNormY * 10000) / 10000
    };
  }

  return {
    ok: targets.length > 0,
    durationMs: Date.now() - started,
    imageWidth: width,
    imageHeight: height,
    promptOrder: Array.isArray(parsed.promptOrder) ? parsed.promptOrder : targets.map(t => t.name),
    targets,
    confirmButton,
    usage
  };
}

// ----------------------------------------------------------------------------
// 命令行执行入口
// ----------------------------------------------------------------------------
if (require.main === module) {
  const targetPath = process.argv[2];
  if (!targetPath) {
    console.log('【点选验证码识别工具】');
    console.log('用法: node src/tools/captcha.js <图片路径>');
    console.log('示例: node src/tools/captcha.js "test.png"');
    process.exit(1);
  }
  solveCaptcha(targetPath)
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('识别失败:', err.message);
      process.exit(1);
    });
}

module.exports = {
  solveCaptcha,
  solveClickCaptcha: solveCaptcha // 兼容别名
};
