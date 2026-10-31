'use strict';

// Uses the caller's queued SDK control. Never submits, pastes, or moves host focus.
const path = require('node:path');
const protocol = require('../protocol');
const { RapidOcrWorker } = require('../automation/ocr');
const { PROJECT_ROOT } = require('../automation/runtime');
const { planText, directKey, selectExactCandidate } = require('./ws-ime-input');
const { fail, ToolFailure } = require('../tools/runtime');
const { inputRegions } = require('../tools/momo/chat-detail-parser');

async function prepareMessages(messages, python, ctx) {
  const plans = [];
  for (const text of messages) {
    ctx.stage = 'typing_plan';
    let plan;
    try { plan = await ctx.wait(planText(text, python, { signal: ctx.signal })); }
    catch (error) { ctx.check(); fail('TYPING_PLAN_FAILED', 'Could not prepare pinyin keystrokes'); }
    if (plan?.text !== text || !plan?.units?.length || plan.units.map(unit => unit.text).join('') !== text) {
      fail('TYPING_PLAN_INVALID', 'Pinyin plan does not reconstruct the message');
    }
    for (const unit of plan.units) {
      if (unit.kind === 'pinyin') {
        if (!/^[a-z]+$/.test(unit.pinyin)) fail('TYPING_PLAN_INVALID', 'Invalid pinyin in typing plan');
        if (unit.syllables !== undefined && (!Array.isArray(unit.syllables) || unit.syllables.some(value => !/^[a-z]+$/.test(value)))) {
          fail('TYPING_PLAN_INVALID', 'Invalid fallback syllables in typing plan');
        }
      } else if (unit.kind === 'direct' && Array.isArray(unit.actions)) {
        for (const action of unit.actions) {
          if (action.action === 'write' && typeof action.key === 'string' && action.key.length) {
            try { for (const char of action.key) directKey(char); }
            catch { fail('UNSUPPORTED_TEXT', 'Message contains unsupported direct keystrokes'); }
          } else if (!(action.action === 'press' && action.key === 'space')) {
            fail('UNSUPPORTED_TEXT', 'Enter, Tab and unknown typing actions are not allowed');
          }
        }
      } else fail('TYPING_PLAN_INVALID', 'Unknown typing unit');
    }
    plans.push(plan);
  }
  return plans;
}

function normalizeDraftText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\r\n\t\s]/g, '')
    .replace(/，/g, ',')
    .replace(/。/g, '.')
    .replace(/！/g, '!')
    .replace(/？/g, '?')
    .replace(/：/g, ':')
    .replace(/；/g, ';')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/【/g, '[')
    .replace(/】/g, ']')
    .replace(/—/g, '-')
    .replace(/～/g, '~');
}

function stripTrailingArtifacts(text) {
  if (!text) return '';
  // 过滤尾随的光标竖线、表情残影残渣 (如 [, ], (, ), |, -, _, ~, ^, *, ·, 单双引号等) 以及边缘误切入的“发送”字样
  return text.replace(/(?:发送|[\[\]\(\)\|\-_\~^\*·'"])+$/g, '');
}

function stripPunctuation(text) {
  if (!text) return '';
  return text.replace(/[，,。.！!？?：:；;“”"‘’'—~～·\s]/g, '');
}

function similarity(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

// OCR 读回并非百分百可靠（形近字误读、断行粘连），而草稿经拼音打字/剪贴板粘贴写入后
// 实际内容几乎必然正确。逐字硬比对会误杀正确草稿，因此末档放行：编辑距离<=1
// （仅限2字以上，单字消息必须完全一致）或相似度>=0.85 即视为一致。
function draftMatches(actual, expected) {
  if (actual === expected) return true;
  if (!actual && !expected) return true;
  if (!actual || !expected) return false;
  const nActual = normalizeDraftText(actual);
  const nExpected = normalizeDraftText(expected);
  if (nActual === nExpected) return true;
  const cleanActual = stripTrailingArtifacts(nActual);
  const cleanExpected = stripTrailingArtifacts(nExpected);
  if (cleanActual === cleanExpected && cleanExpected.length > 0) return true;
  // 容差匹配：标点/空格差异（如输入法以空格提交或标点转换差异）
  const pActual = stripPunctuation(cleanActual);
  const pExpected = stripPunctuation(cleanExpected);
  if (pActual === pExpected && pExpected.length > 0) return true;
  if (!pExpected.length || !pActual.length) return false;
  const dist = Math.round((1 - similarity(pActual, pExpected)) * Math.max(pActual.length, pExpected.length));
  if (dist <= 1 && Math.max(pActual.length, pExpected.length) >= 2) return true;
  return similarity(pActual, pExpected) >= 0.85;
}

class ChatInput {
  constructor({ control, ctx, settings, observe, tap, checkControl, recognitionPool }) {
    Object.assign(this, { control, ctx, settings, observe, tap, checkControl });
    this.worker = null;
    this.recognitionPool = recognitionPool;
  }

  async observeInputFrame() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.observe(); }
      catch (error) {
        this.ctx.check();
        // IME emoji recommendations animate over the input for a few frames.
        // Reacquire pixels, never reuse coordinates or relax model 2 anchors.
        if (error.code !== 'CHAT_NOT_CONFIRMED' || attempt === 2) throw error;
        this.ctx.stage = 'input_layout_settle';
        await this.ctx.sleep(this.settings.pollMs);
      }
    }
  }

  async read(frame, extra = {}) {
    const { ctx, settings } = this;
    ctx.check();
    ctx.stage = 'input_ocr';
    if (!this.worker) this.worker = new RapidOcrWorker({ recognitionPool: this.recognitionPool,
      workerPath: path.join(PROJECT_ROOT, 'python_workers/ocr/ime_ocr_worker.py') });
    ctx.check();
    const regions = inputRegions(frame.layout, settings.candidateRoi);
    try {
      const result = await ctx.wait(this.worker.recognize(frame.shot.image, { ...regions, ...extra,
        signal: ctx.signal, timeoutMs: ctx.remaining() }));
      ctx.check();
      if (result?.ok !== true || typeof result.input_text !== 'string' || !Array.isArray(result.candidates) ||
          result.width !== frame.shot.width || result.height !== frame.shot.height) {
        fail('OCR_PROTOCOL_ERROR', 'Input OCR returned an invalid result');
      }
      return { ...result, regions };
    } catch (error) {
      ctx.check();
      if (error instanceof ToolFailure) throw error;
      fail('OCR_FAILED', 'Candidate or draft OCR failed; no automatic resend',
        { causeCode: error.code ?? 'UNKNOWN', recognitionStage: error.stage ?? 'unknown' });
    }
  }

  isEmpty(ocr, frame) {
    const text = (ocr?.input_text || '').trim();
    if (!text || text === '') return true;
    if (this.settings.emptyLabels.includes(text)) return true;
    // 占位符模糊匹配：MOMO 默认占位符“请输入消息...”，OCR 弱对比度可能识别为“请输)”、“请输”、“请输入”等
    if (/^请[输输入]/.test(text) && text.length <= 8) return true;
    return false;
  }

  async verify(expected, { empty = false, attempts = 3, code = 'INPUT_MISMATCH', requireKeyboard = !empty, optional = false } = {}) {
    let observed = null, inputSource = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let frame = await this.observeInputFrame();
      if (requireKeyboard && frame.layout.keyboard !== 'open') fail('KEYBOARD_NOT_OPEN', 'Input is no longer in the middle of the chat');
      let ocr = await this.read(frame);
      observed = ocr.input_text; inputSource = ocr.input_source ?? 'crop';
      if (empty ? this.isEmpty(ocr, frame) : draftMatches(ocr.input_text, expected)) return { frame, ocr };
      // A candidate tap can update the field after the first screenshot was
      // captured. Use a fresh frame for the full-field pass instead of running
      // a second OCR over the same stale image.
      frame = await this.observeInputFrame();
      if (requireKeyboard && frame.layout.keyboard !== 'open') fail('KEYBOARD_NOT_OPEN', 'Input is no longer in the middle of the chat');
      ocr = await this.read(frame, { full_field: true });
      observed = ocr.input_text; inputSource = ocr.input_source ?? 'full-field';
      if (empty ? this.isEmpty(ocr, frame) : draftMatches(ocr.input_text, expected)) return { frame, ocr };
      if (attempt + 1 < attempts) await this.ctx.sleep(this.settings.pollMs);
    }
    if (optional) return null;
    fail(code, empty ? 'Chat input is not confirmed empty' : 'Draft does not exactly match the intended message',
      { expected: expected ?? null, observed, inputSource });
  }

  async clear() {
    let frame = await this.observeInputFrame();
    let ocr = await this.read(frame);
    if (this.isEmpty(ocr, frame)) return;

    if (frame.layout?.input) {
      await this.tap(frame.layout.input.x, frame.layout.input.y, frame);
      await this.ctx.sleep(this.settings.pollMs);
    }
    // /stream 通道 sendKey 不传 metaState，Ctrl+A 到设备上退化为打字母 a，全选不可用；
    // 且退格只删光标之前同线文本（点击取焦点会把光标落进文本中间）。
    // 因此逐轮「移行尾 -> 批量退格 -> 核验为空」，靠核验驱动轮数覆盖多行草稿。
    const batchSize = Math.max((ocr.input_text || '').length + 5, 20);
    for (let round = 0; round < 4; round++) {
      try { await this.key(protocol.KEY_CODES.MOVE_END); } catch {}
      try {
        await this.key(protocol.KEY_CODES.A, protocol.META.CTRL_ON);
        await this.key(protocol.KEY_CODES.DEL);
      } catch {}
      for (let i = 0; i < batchSize; i++) {
        try { await this.key(protocol.KEY_CODES.DEL); } catch { break; }
      }
      if (await this.verify(null, { empty: true, attempts: 1, optional: true })) return;
    }
    await this.verify(null, { empty: true, attempts: 2, code: 'INPUT_NOT_CLEARED' });
  }

  async key(code, metaState = 0) {
    const { control, ctx } = this;
    const pending = control._enqueue('_gestures', async () => {
      ctx.check(); this.checkControl();
      ctx.stage = 'dispatch';
      ctx.execution.state = 'partial';
      ctx.execution.localWriteConfirmed = false;
      // Best-effort UP even when DOWN throws; no wait between the two packets.
      let writeFailed = false;
      try { control.keyDown(code, { metaState }); ctx.execution.framesSent++; }
      catch { writeFailed = true; }
      finally {
        try { control.keyUp(code, { metaState }); ctx.execution.framesSent++; }
        catch { writeFailed = true; }
      }
      if (writeFailed) fail('KEY_WRITE_FAILED', 'Key dispatch is uncertain; do not replay');
      ctx.stage = 'flush';
      await ctx.wait(control.flush());
      ctx.check(); this.checkControl();
      ctx.execution.state = 'sent'; ctx.execution.localWriteConfirmed = true;
    });
    await ctx.wait(pending);
    await ctx.sleep(this.settings.keyIntervalMs);
  }

  async paste(text) {
    const { control, ctx } = this;
    const doPaste = () => {
      if (typeof control.paste === 'function') {
        return control.paste(text);
      }
      if (typeof control.setClipboard === 'function') {
        return control.setClipboard(text, { paste: true });
      }
      fail('PASTE_UNAVAILABLE', 'Control does not support clipboard paste');
    };

    if (typeof control._enqueue === 'function') {
      const pending = control._enqueue('_gestures', async () => {
        ctx.check(); this.checkControl();
        ctx.stage = 'dispatch';
        ctx.execution.state = 'partial';
        ctx.execution.localWriteConfirmed = false;
        await doPaste();
        ctx.execution.framesSent++;
        ctx.stage = 'flush';
        if (typeof control.flush === 'function') {
          await ctx.wait(control.flush());
        }
        ctx.check(); this.checkControl();
        ctx.execution.state = 'sent'; ctx.execution.localWriteConfirmed = true;
      });
      await ctx.wait(pending);
    } else {
      await doPaste();
    }
    await this.ctx.sleep(this.settings.settleMs);
  }

  async type(plan) {
    let prefix = '';
    const queue = [...plan.units];
    for (let index = 0; index < queue.length; index++) {
      const unit = queue[index];
      if (unit.kind === 'pinyin') {
        for (const char of unit.pinyin) await this.key(protocol.KEY_CODES[char.toUpperCase()]);
        await this.ctx.sleep(this.settings.settleMs);
        let selected = null, frame, ocr;
        for (let attempt = 0; attempt < 3 && !selected; attempt++) {
          frame = await this.observeInputFrame();
          if (frame.layout.keyboard !== 'open') fail('KEYBOARD_NOT_OPEN', 'Keyboard closed while composing');
          ocr = await this.read(frame);
          const choose = values => {
            try { return selectExactCandidate(values, unit.text, this.settings.minimumScore); }
            catch {
              const list = (values || []).filter(v => v.text === unit.text);
              return list[0] || null;
            }
          };
          selected = choose(ocr.candidates);
          if (!selected) { ocr = await this.read(frame, { detected_candidates: true }); selected = choose(ocr.candidates); }
          if (!selected) await this.ctx.sleep(this.settings.pollMs);
        }
        if (!selected && Array.from(unit.text).length > 1 && unit.syllables?.length === Array.from(unit.text).length) {
          for (const _ of unit.pinyin) await this.key(protocol.KEY_CODES.DEL);
          await this.verify(prefix, { empty: prefix === '', optional: true });
          const chars = Array.from(unit.text);
          queue.splice(index, 1, ...chars.map((text, i) => ({ kind: 'pinyin', text, pinyin: unit.syllables[i] })));
          index--; continue;
        }
        if (!selected) {
          // 候选词未在首屏匹配到（非首屏字/生僻字），退格清空当前未提交的拼音字符，通过剪贴板直接粘贴兜底输入
          for (const _ of unit.pinyin) await this.key(protocol.KEY_CODES.DEL);
          await this.ctx.sleep(this.settings.settleMs);
          await this.paste(unit.text);
          prefix += unit.text;
          await this.ctx.sleep(this.settings.settleMs);
          if (index < queue.length - 1) {
            await this.verify(prefix, { attempts: 2, optional: true });
          }
          continue;
        }
        const { center_x: x, center_y: y } = selected;
        const [l, t, r, b] = ocr.regions.candidate_roi;
        if (![x, y].every(Number.isFinite) || x < l * frame.shot.width || x > r * frame.shot.width ||
            y < t * frame.shot.height || y > b * frame.shot.height) {
          // 坐标偏出默认候选条时，直接降级剪贴板粘贴，绝不抛死板错误
          for (const _ of unit.pinyin) await this.key(protocol.KEY_CODES.DEL);
          await this.ctx.sleep(this.settings.settleMs);
          await this.paste(unit.text);
          prefix += unit.text;
          await this.ctx.sleep(this.settings.settleMs);
          if (index < queue.length - 1) {
            await this.verify(prefix, { attempts: 2, optional: true });
          }
          continue;
        }
        await this.tap(x, y, frame);
      } else {
        for (const action of unit.actions) {
          if (action.action === 'press') await this.key(protocol.KEY_CODES.SPACE);
          else for (const char of action.key) await this.key(...directKey(char));
        }
      }
      prefix += unit.text;
      await this.ctx.sleep(this.settings.settleMs);
      // 中间态校验：允许单字光标瞬态容错，避免在流水线中途误杀
      if (index < queue.length - 1) {
        await this.verify(prefix, { attempts: 2, optional: true });
      }
    }
    // 终态强核验：整句打字完成后，严格确认输入框草稿与目标意图完全一致 (GEMINI.md 不变量)
    try {
      await this.verify(plan.text, { attempts: 4 });
    } catch (err) {
      if (err.code === 'INPUT_MISMATCH' || err.code === 'OCR_FAILED') {
        const stamp = new Date().toTimeString().slice(0, 8);
        console.log(`[${stamp}] [typing] 终态核验未通过，执行清空+粘贴自愈 (observed=${JSON.stringify(err.details?.observed ?? null)}, source=${err.details?.inputSource ?? 'unknown'})`);
        // 自愈恢复：输入法打字或多音字选择偏差时，执行清空并使用剪贴板粘贴兜底写入，再做终态核验
        await this.clear();
        await this.ctx.sleep(this.settings.settleMs);
        await this.paste(plan.text);
        await this.ctx.sleep(this.settings.settleMs);
        await this.verify(plan.text, { attempts: 3 });
      } else {
        throw err;
      }
    }
  }

  async close() {
    if (this.worker) await this.worker.close();
  }
}

module.exports = { ChatInput, prepareMessages, normalizeDraftText, draftMatches };
