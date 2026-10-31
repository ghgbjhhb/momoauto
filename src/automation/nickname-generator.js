'use strict';

/**
 * 女生网名随机生成桥 (调用 python_workers/nickname/girl_username_generator.py)
 *
 * Python 脚本仅用标准库离线生成；Node 侧每次运行一次性子进程消费（-I 隔离 + -X utf8），
 * 输出每行一个网名。
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(ROOT, 'python_workers', 'nickname', 'girl_username_generator.py');

// 与 typing 计划器一致的解释器选择约定：环境变量 > 项目 venv > PATH 上的 python
function resolvePython() {
  if (process.env.YUNMOMO_NICKNAME_PYTHON) return process.env.YUNMOMO_NICKNAME_PYTHON;
  const venvPython = path.join(ROOT, '.venv-zhtyping', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python';
}

function buildChildEnv() {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|COOKIE|API_KEY|AUTHORIZATION/i.test(key)) delete env[key];
  }
  return env;
}

/**
 * 随机生成一批女生网名。
 * @param {object} [options]
 * @param {number} [options.count=1] 生成数量
 * @param {string} [options.style='混合'] 风格: 日常/甜美/温柔/文艺/混合
 * @param {number} [options.seed] 随机种子（可复现）
 * @param {number} [options.timeoutMs=8000] 子进程超时
 * @returns {Promise<string[]>} 去重后的网名列表
 */
async function generateGirlNicknames({ count = 1, style = '混合', seed = null, timeoutMs = 8000 } = {}) {
  const args = ['-I', '-X', 'utf8', SCRIPT_PATH, '-n', String(count), '-s', String(style)];
  if (seed !== null && seed !== undefined) args.push('--seed', String(seed));
  return new Promise((resolve, reject) => {
    execFile(resolvePython(), args, {
      cwd: ROOT,
      env: buildChildEnv(),
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        return reject(Object.assign(new Error(`女生网名生成失败: ${err.message}`), { code: 'NICKNAME_GEN_FAIL' }));
      }
      const names = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!names.length) {
        return reject(Object.assign(new Error('女生网名生成失败: 未返回任何结果'), { code: 'NICKNAME_GEN_EMPTY' }));
      }
      resolve(names);
    });
  });
}

/** 随机生成一个女生网名。 */
async function generateGirlNickname(options = {}) {
  const [name] = await generateGirlNicknames({ ...options, count: 1 });
  return name;
}

/**
 * 网名取值：留空即离线随机生成，显式指定则原样使用。
 * @param {string} [setting] 命令行 / 环境变量传入的网名
 * @param {string} [style='混合'] 生成风格: 日常/甜美/温柔/文艺/混合
 * @returns {Promise<string>} 最终网名
 */
async function resolveGirlNickname(setting, style = '混合') {
  const raw = String(setting ?? '').trim();
  return raw || await generateGirlNickname({ style });
}

module.exports = { generateGirlNickname, generateGirlNicknames, resolveGirlNickname };
