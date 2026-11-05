'use strict';

/**
 * 组合脚本长会话流水线执行器 (Bundle Session Runner)
 * 
 * 核心设计：
 * 1. 作为单次组合任务的独立 Worker 子进程运行，具备完整的进程故障与内存隔离；
 * 2. 对同一台云机，只建立一次 Client、一次 Control 和一次 RapidOcrWorker；
 * 3. 步骤与步骤之间在内存中无缝按序流转，0ms 握手等待，彻底消除 4005 会话抢占与冷启动税；
 * 4. 步骤间可无缝传递当前主屏画面 (lastObservation)，消除重复核验等待；
 * 5. 全流程结束后在 finally 中统一优雅断连释放。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { YunmomoClient } = require('../index');
const { RapidOcrWorker } = require('../automation/screen');
const { PROJECT_ROOT } = require('../automation/runtime');
const { acquireExclusiveLock } = require('../automation/concurrency');
const { scriptById } = require('./script-catalog');
const { STEPS: STEPS_V2 } = require('../../flows/v2/_common');
const { STEPS: STEPS_V3 } = require('../../flows/v3/_common');

function deviceIdOf(record) {
  return String(record?.deviceId ?? record?.id ?? '');
}

function resolveScriptSource(script) {
  if (!script) return null;
  // 1. 如果在 STEPS_V2 中有记录
  const v2Match = STEPS_V2.find(s => script.id === `flow-${Number.isInteger(s.order) ? String(s.order).padStart(2, '0') : String(s.order)}-v2`);
  if (v2Match?.source) return path.join(PROJECT_ROOT, v2Match.source);
  // 2. 如果在 STEPS_V3 中有记录
  const v3Match = STEPS_V3.find(s => script.id === `flow-${String(s.order).padStart(2, '0')}-v3`);
  if (v3Match?.source) return path.join(PROJECT_ROOT, v3Match.source);
  // 3. 特殊步骤映射
  if (script.id === 'flow-09-v2') return path.join(PROJECT_ROOT, 'src/workflows/v2/reset-data.js');
  if (script.id === 'flow-09-v3') return path.join(PROJECT_ROOT, 'src/workflows/v3/change-model-reset.js');
  // 4. 直接通过 script.file 查找
  if (script.file) return path.join(PROJECT_ROOT, script.file);
  return null;
}

async function main() {
  const token = process.env.YUNMOMO_TOKEN;
  if (!token) throw new Error('缺少 YUNMOMO_TOKEN 凭证');
  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || '').trim();
  if (!targetDeviceId) throw new Error('缺少 YUNMOMO_DEVICE_ID 目标设备');

  const specRaw = process.env.YUNMOMO_BUNDLE_SPEC;
  if (!specRaw) throw new Error('缺少 YUNMOMO_BUNDLE_SPEC 组合规格说明');
  let steps;
  try {
    steps = JSON.parse(specRaw);
  } catch (err) {
    throw new Error('YUNMOMO_BUNDLE_SPEC JSON 解析失败: ' + err.message);
  }
  if (!Array.isArray(steps) || !steps.length) {
    throw new Error('组合步骤为空');
  }

  const client = new YunmomoClient({ token, timeoutMs: 100000 });
  const listed = await client.listDevices({ size: 50000 });
  const target = listed.records.find(d => deviceIdOf(d) === targetDeviceId);
  if (!target) throw new Error('目标设备不在当前账号列表中: ' + targetDeviceId);

  const deviceName = target.deviceName ?? target.name ?? 'SF';
  console.log(`[组合流水线] 目标设备: ${deviceName} (${targetDeviceId}) | 共 ${steps.length} 个步骤`);

  const phone = client.device(targetDeviceId);
  let control = null;
  let worker = null;
  const state = { counter: 0, lastObservation: null };

  const ensureControl = async () => {
    if (!control) {
      console.log(`[组合流水线] 正在建立设备控制通道与 /stream 输入流...`);
      control = await phone.openControl({ udid: target.udid });
      await control.connect();
      console.log(`[组合流水线] 设备控制通道已就绪 (画面: ${control.screenWidth}x${control.screenHeight})`);
    }
    return control;
  };

  const ensureWorker = () => {
    if (!worker) {
      worker = new RapidOcrWorker();
    }
    return worker;
  };

  const bundleRunId = String(process.env.YUNMOMO_SCRIPT_RUN_ID || ('bundle-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)));
  const sessionDirectory = path.join(PROJECT_ROOT, 'logs', 'screenshots', bundleRunId);
  await fs.mkdir(sessionDirectory, { recursive: true });

  const context = {
    deviceId: targetDeviceId,
    deviceName,
    target,
    client,
    phone,
    directory: sessionDirectory,
    runId: bundleRunId,
    ensureControl,
    get control() { return control; },
    get worker() { return ensureWorker(); },
    state,
    options: {},
  };

  let allOk = true;

  try {
    const startStepIndex = Number.parseInt(process.env.YUNMOMO_START_STEP_INDEX || '0', 10) || 0;
    if (startStepIndex > 0) {
      console.log(`[组合流水线] 命中断点续传指令，前 ${startStepIndex} 个已完成步骤直接跳过，从第 ${startStepIndex + 1} 步开始接力执行。`);
    }

    for (let index = 0; index < steps.length; index++) {
      const stepDef = steps[index];
      const script = scriptById(stepDef.scriptId);
      if (!script) throw new Error(`未找到步骤编号对应的定义: ${stepDef.scriptId}`);

      const title = script.title || stepDef.scriptId;
      if (index < startStepIndex) {
        console.log(`[步骤 ${index + 1}/${steps.length}] ⏩ [断点跳过已完成] ${title}`);
        continue;
      }

      console.log(`\n================================================================================`);
      console.log(`::step-start:${index}:${stepDef.scriptId}::`);
      console.log(`[步骤 ${index + 1}/${steps.length}] 开始执行: ${title}`);
      console.log(`================================================================================`);

      const startTime = Date.now();
      const stepOptions = stepDef.options || {};
      context.options = stepOptions;

      // 解析底层业务脚本文件
      const sourceFile = resolveScriptSource(script);
      let stepResult = null;

      const isExclusive = Boolean(script.exclusive);
      let exclusiveLock = null;

      try {
        if (isExclusive) {
          const lockKey = script.exclusiveKey || script.id;
          console.log(`[步骤调度] 步骤 [${title}] 声明为全局独占排他属性 (exclusive)，正在申请排他执行锁...`);
          exclusiveLock = await acquireExclusiveLock(lockKey, {
            deviceId: targetDeviceId,
            onWaiting: (sec) => {
              if (sec % 9 === 0) {
                console.log(`[步骤调度] 正在排队等待前序设备释放云端全局通道 (${sec}s)...`);
              }
            }
          });
          console.log(`[步骤调度] ✅ 成功获取全局排他锁，独占执行步骤 [${title}]`);
        }

        let mod = null;
        if (sourceFile) {
          try {
            mod = require(sourceFile);
          } catch (e) {
            // 模块加载失败时记录并 fallback
          }
        }

        if (mod && typeof mod.runStep === 'function') {
          // 🚀 核心优化：直接内存执行，复用已就绪会话！
          console.log(`[流水线调度] 检测到原生会话接口 runStep，采用长连接内存执行...`);
          // 确保 control 连接可用（对于不需要 control 的纯 API 步骤，传入后也不会报错）
          await ensureControl();
          stepResult = await mod.runStep(context);
        } else {
          // ⚠️ 降级处理：若该脚本尚未适配 runStep，通过独立子进程执行该单步
          console.log(`[流水线调度] 步骤未导出 runStep，采用进程级隔离执行...`);
          stepResult = await runLegacyScriptProcess(script, targetDeviceId, stepOptions, token);
        }

        const durationMs = Date.now() - startTime;
        const ok = stepResult === undefined || stepResult === true || (stepResult && stepResult.ok !== false);
        if (!ok) {
          throw new Error(stepResult?.message || `步骤 ${index + 1} (${title}) 返回失败`);
        }

        console.log(`::step-end:${index}:${stepDef.scriptId}:ok::`);
        console.log(`[步骤 ${index + 1}/${steps.length}] ✅ ${title} 执行完成 (耗时: ${durationMs}ms)`);
      } catch (stepErr) {
        allOk = false;
        console.error(`::step-end:${index}:${stepDef.scriptId}:fail::`);
        console.error(`[步骤 ${index + 1}/${steps.length}] ❌ ${title} 执行失败:`, stepErr.message);
        throw stepErr;
      } finally {
        if (exclusiveLock) {
          await exclusiveLock.release();
          console.log(`[步骤调度] 独占步骤 [${title}] 执行结束，已安全释放全局排他锁。`);
        }
      }
    }

    console.log(`\n================================================================================`);
    console.log(`[组合流水线] ✅ 全流程 ${steps.length} 个步骤全部圆满完成！`);
    console.log(`================================================================================`);
  } finally {
    console.log(`[组合流水线] 正在释放会话资源与控制通道...`);
    if (worker) {
      try { await worker.close(); } catch {}
    }
    if (control) {
      try { await control.close(); } catch {}
    }
    console.log(`[组合流水线] 控制权与连接已全部安全释放。`);
  }
}

function runLegacyScriptProcess(script, deviceId, options, token) {
  return new Promise((resolve, reject) => {
    const file = path.join(PROJECT_ROOT, script.file);
    const env = {
      ...process.env,
      YUNMOMO_DEVICE_ID: deviceId,
      YUNMOMO_TOKEN: token,
      ...(options || {}),
    };
    const child = spawn(process.execPath, [file, ...(script.args ?? [])], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`子进程退出代码异常: ${code}`));
    });
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error('[组合流水线致命错误]', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
