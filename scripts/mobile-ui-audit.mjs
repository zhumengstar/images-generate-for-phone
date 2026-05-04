import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const targetUrl = process.env.AUDIT_URL || "http://127.0.0.1:8000/image/";
const remotePort = Number(process.env.CDP_PORT || 9223);
const userDataDir = join(tmpdir(), `images-generate-mobile-audit-${Date.now()}`);
const viewport = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJsonVersion() {
  const url = `http://127.0.0.1:${remotePort}/json/version`;
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    } catch {
      // Chrome is still starting.
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

async function waitForPageWebSocket() {
  const url = `http://127.0.0.1:${remotePort}/json`;
  for (let i = 0; i < 80; i += 1) {
    const response = await fetch(url);
    if (response.ok) {
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) {
        return page.webSocketDebuggerUrl;
      }
    }
    await delay(100);
  }
  throw new Error("Chrome page target did not become ready");
}

class CdpClient {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`${message.error.message || "CDP error"} ${message.error.data || ""}`));
        } else {
          resolve(message.result);
        }
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

function js(strings, ...values) {
  return strings.reduce((acc, part, index) => acc + part + (values[index] ?? ""), "");
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime exception");
  }
  return result.result.value;
}

function rectOk(rect) {
  return rect && Number.isFinite(rect.top) && Number.isFinite(rect.bottom);
}

function assertCheck(checks, name, pass, details) {
  checks.push({ name, pass: Boolean(pass), details });
}

async function capture(client, filePath) {
  const result = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(filePath, Buffer.from(result.data, "base64"));
}

async function waitForAppReady(client) {
  for (let i = 0; i < 80; i += 1) {
    const state = await evaluate(client, js`
      (() => {
        const bodyText = document.body?.innerText || "";
        return {
          ready: document.readyState,
          hasChromeError: bodyText.includes("This page couldn") || bodyText.includes("Reload to try again"),
          hasTextarea: Boolean(document.querySelector("textarea")),
          hasTopInfo: Boolean(document.querySelector("section[aria-label='页面信息']")),
          hasComposer: Boolean(document.querySelector("section[aria-label='输入区域']")),
        };
      })()
    `);
    if (state.hasChromeError) {
      throw new Error(`Chrome failed to load ${targetUrl}`);
    }
    if (state.ready === "complete" && state.hasTextarea && state.hasTopInfo && state.hasComposer) {
      return state;
    }
    await delay(150);
  }
  throw new Error(`Image page did not become ready: ${targetUrl}`);
}

const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${remotePort}`,
  `--user-data-dir=${userDataDir}`,
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  `--window-size=${viewport.width},${viewport.height}`,
  targetUrl,
], { stdio: "ignore" });

let client;
try {
  await waitForJsonVersion();
  client = new CdpClient(await waitForPageWebSocket());
  await client.open();
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", viewport);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await client.send("Network.enable");
  await client.send("Page.navigate", { url: targetUrl });
  await waitForAppReady(client);

  const auditDir = join(process.cwd(), "tmp", "mobile-ui-audit");
  await mkdir(auditDir, { recursive: true });
  await capture(client, join(auditDir, "01-initial.png"));

  const initial = await evaluate(client, js`
    (() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      };
      const byText = (text) => Array.from(document.querySelectorAll("button")).find((el) => el.textContent.includes(text));
      const textarea = document.querySelector("textarea[placeholder='输入你想要生成的画面']");
      const composer = textarea?.closest("section[aria-label='输入区域']")?.querySelector(":scope > div");
      const topInfo = document.querySelector("section[aria-label='页面信息']");
      const results = document.querySelector("section[aria-label='图片生成区域']");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        topInfo: rect(topInfo),
        results: rect(results),
        composer: rect(composer),
        textarea: rect(textarea),
        composerText: composer?.innerText || "",
        bodyText: document.body?.innerText || "",
        collapseVisible: Boolean(byText("收起")),
        expandVisible: Boolean(byText("展开")),
        referencePreviewCount: composer ? composer.querySelectorAll("img").length : 0,
      };
    })()
  `);

  const checks = [];
  assertCheck(checks, "移动端视口宽度正确", initial.viewport.width === 390, initial.viewport);
  assertCheck(checks, "顶部信息区存在", rectOk(initial.topInfo) && initial.topInfo.height > 20, initial.topInfo);
  assertCheck(checks, "中间图片区域存在且独立占据高度", rectOk(initial.results) && initial.results.height > 200, initial.results);
  assertCheck(checks, "底部输入区域贴底", rectOk(initial.composer) && Math.abs(initial.composer.bottom - initial.viewport.height) <= 2, initial.composer);
  assertCheck(checks, "底部输入区不显示剩余额度", !initial.composerText.includes("剩余额度"), { composerText: initial.composerText });
  assertCheck(checks, "页面不显示公网 IP 和指纹", !initial.bodyText.includes("公网 IP") && !initial.bodyText.includes("指纹"), {
    hasPublicIp: initial.bodyText.includes("公网 IP"),
    hasFingerprint: initial.bodyText.includes("指纹"),
  });
  assertCheck(checks, "未上传图片时参考图区不出现", initial.referencePreviewCount === 0, { referencePreviewCount: initial.referencePreviewCount });
  assertCheck(checks, "顶部收起按钮可见", initial.collapseVisible || initial.expandVisible, { collapseVisible: initial.collapseVisible, expandVisible: initial.expandVisible });

  await evaluate(client, js`
    (() => {
      const button = Array.from(document.querySelectorAll("button")).find((el) => el.textContent.includes("收起"));
      button?.click();
    })()
  `);
  await delay(250);
  await capture(client, join(auditDir, "02-top-collapsed.png"));
  const collapsed = await evaluate(client, js`
    (() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const topInfo = document.querySelector("section[aria-label='页面信息']");
      const results = document.querySelector("section[aria-label='图片生成区域']");
      return {
        topInfo: rect(topInfo),
        results: rect(results),
        expandVisible: Array.from(document.querySelectorAll("button")).some((el) => el.textContent.includes("展开")),
      };
    })()
  `);
  assertCheck(checks, "顶部区域可收起", collapsed.expandVisible && collapsed.topInfo.height < initial.topInfo.height, { before: initial.topInfo.height, after: collapsed.topInfo.height });
  assertCheck(checks, "顶部收起后中间区域高度增加或保持", collapsed.results.height >= initial.results.height - 2, { before: initial.results.height, after: collapsed.results.height });

  await evaluate(client, js`
    (() => {
      const textarea = document.querySelector("textarea[placeholder='输入你想要生成的画面']");
      textarea?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      textarea?.focus({ preventScroll: true });
    })()
  `);
  await delay(180);
  await capture(client, join(auditDir, "03-input-focused.png"));
  const focused = await evaluate(client, js`
    (() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      };
      const textarea = document.querySelector("textarea[placeholder='输入你想要生成的画面']");
      const composer = textarea?.closest("section[aria-label='输入区域']")?.querySelector(":scope > div");
      const topInfo = document.querySelector("section[aria-label='页面信息']");
      const results = document.querySelector("section[aria-label='图片生成区域']");
      return {
        topInfo: rect(topInfo),
        results: rect(results),
        composer: rect(composer),
        textarea: rect(textarea),
        activeTag: document.activeElement?.tagName,
        bodyScroll: { x: scrollX, y: scrollY },
      };
    })()
  `);
  assertCheck(checks, "点击输入框后顶部区域保持固定", Math.abs(focused.topInfo.top - collapsed.topInfo.top) <= 1 && Math.abs(focused.topInfo.height - collapsed.topInfo.height) <= 1, { before: collapsed.topInfo, after: focused.topInfo });
  assertCheck(checks, "点击输入框后输入区域可见", rectOk(focused.composer) && focused.composer.bottom > focused.composer.top && focused.composer.top >= focused.topInfo.bottom - 1, { topInfo: focused.topInfo, composer: focused.composer });
  assertCheck(checks, "点击输入框后中间区域保持固定", Math.abs(focused.results.top - collapsed.results.top) <= 1 && Math.abs(focused.results.bottom - collapsed.results.bottom) <= 1, { before: collapsed.results, after: focused.results });
  assertCheck(checks, "点击输入框后输入区域不覆盖顶部", focused.composer.top >= focused.topInfo.bottom - 1, { topInfoBottom: focused.topInfo.bottom, composerTop: focused.composer.top });
  assertCheck(checks, "点击输入框不触发页面整体滚动", focused.bodyScroll.x === 0 && focused.bodyScroll.y === 0, focused.bodyScroll);

  await client.send("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    height: 520,
  });
  await delay(350);
  await capture(client, join(auditDir, "03b-input-focused-keyboard.png"));
  const focusedKeyboard = await evaluate(client, js`
    (() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      };
      const textarea = document.querySelector("textarea[placeholder='输入你想要生成的画面']");
      const composer = textarea?.closest("section[aria-label='输入区域']")?.querySelector(":scope > div");
      const topInfo = document.querySelector("section[aria-label='页面信息']");
      const results = document.querySelector("section[aria-label='图片生成区域']");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        visualViewport: window.visualViewport ? { width: visualViewport.width, height: visualViewport.height, offsetTop: visualViewport.offsetTop } : null,
        topInfo: rect(topInfo),
        results: rect(results),
        composer: rect(composer),
        textarea: rect(textarea),
        bodyScroll: { x: scrollX, y: scrollY },
      };
    })()
  `);
  const keyboardVisibleBottom = focusedKeyboard.visualViewport
    ? focusedKeyboard.visualViewport.offsetTop + focusedKeyboard.visualViewport.height
    : focusedKeyboard.viewport.height;
  assertCheck(checks, "输入法弹出后输入区域仍在可见区域内", rectOk(focusedKeyboard.composer) && focusedKeyboard.composer.bottom <= keyboardVisibleBottom + 1, { keyboardVisibleBottom, composer: focusedKeyboard.composer, visualViewport: focusedKeyboard.visualViewport });
  assertCheck(checks, "输入法弹出后输入框不被键盘遮挡", rectOk(focusedKeyboard.textarea) && focusedKeyboard.textarea.bottom <= keyboardVisibleBottom + 1, { keyboardVisibleBottom, textarea: focusedKeyboard.textarea, visualViewport: focusedKeyboard.visualViewport });
  assertCheck(checks, "输入法弹出后顶部仍固定", rectOk(focusedKeyboard.topInfo) && Math.abs(focusedKeyboard.topInfo.top - focused.topInfo.top) <= 1, { before: focused.topInfo, after: focusedKeyboard.topInfo });
  assertCheck(checks, "输入法弹出后中间区域仍固定", rectOk(focusedKeyboard.results) && Math.abs(focusedKeyboard.results.top - focused.results.top) <= 1 && Math.abs(focusedKeyboard.results.bottom - focused.results.bottom) <= 1, { before: focused.results, after: focusedKeyboard.results });

  await client.send("Emulation.setDeviceMetricsOverride", viewport);
  await delay(250);

  await evaluate(client, js`
    (() => {
      const input = document.querySelector("input[type='file']");
      const file = new File(["fake"], "ref.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()
  `);
  await delay(700);
  await capture(client, join(auditDir, "04-after-upload.png"));
  const uploaded = await evaluate(client, js`
    (() => {
      const textarea = document.querySelector("textarea[placeholder='输入你想要生成的画面']");
      const composer = textarea?.closest("section[aria-label='输入区域']")?.querySelector(":scope > div");
      const imgs = Array.from(composer?.querySelectorAll("img") || []);
      const polish = Array.from(composer?.querySelectorAll("button") || []).find((el) => el.textContent.includes("AI润色"));
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      };
      return {
        referencePreviewCount: imgs.length,
        polishRect: rect(polish),
        composerRect: rect(composer),
      };
    })()
  `);
  assertCheck(checks, "上传图片后参考图区出现", uploaded.referencePreviewCount > 0, uploaded);
  assertCheck(checks, "AI润色按钮仍在输入区域内", rectOk(uploaded.polishRect) && uploaded.polishRect.top >= uploaded.composerRect.top && uploaded.polishRect.bottom <= uploaded.composerRect.bottom, uploaded);

  await evaluate(client, js`
    (() => {
      document.querySelector("textarea[placeholder='输入你想要生成的画面']")?.blur();
      const button = Array.from(document.querySelectorAll("button")).find((el) => el.textContent.includes("展开"));
      button?.click();
    })()
  `);
  await delay(250);
  const expandedBeforeFocus = await evaluate(client, js`
    (() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        topInfo: rect(document.querySelector("section[aria-label='页面信息']")),
        results: rect(document.querySelector("section[aria-label='图片生成区域']")),
      };
    })()
  `);

  await evaluate(client, js`
    (() => {
      const textarea = document.querySelector("textarea[placeholder='输入你想要生成的画面']");
      textarea.value = "这是一段很长的测试提示词，用来验证输入框自动增高之后，顶部区域、中间图片区域和底部输入区域仍然互相独立，不会因为输入区域变高而覆盖顶部，也不会让中间区域产生异常滚动或闪动。";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      textarea.focus({ preventScroll: true });
    })()
  `);
  await delay(300);
  await capture(client, join(auditDir, "05-expanded-top-long-input-focused.png"));
  const expandedFocused = await evaluate(client, js`
    (() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const textarea = document.querySelector("textarea[placeholder='输入你想要生成的画面']");
      const composer = textarea?.closest("section[aria-label='输入区域']")?.querySelector(":scope > div");
      const topInfo = document.querySelector("section[aria-label='页面信息']");
      const results = document.querySelector("section[aria-label='图片生成区域']");
      return {
        topInfo: rect(topInfo),
        results: rect(results),
        composer: rect(composer),
        textarea: rect(textarea),
        bodyScroll: { x: scrollX, y: scrollY },
      };
    })()
  `);
  assertCheck(checks, "顶部展开状态聚焦后顶部仍固定", Math.abs(expandedFocused.topInfo.top - expandedBeforeFocus.topInfo.top) <= 1 && Math.abs(expandedFocused.topInfo.height - expandedBeforeFocus.topInfo.height) <= 1, { before: expandedBeforeFocus.topInfo, after: expandedFocused.topInfo });
  assertCheck(checks, "长文本聚焦后输入区仍在顶部信息区下方", expandedFocused.composer.top >= expandedFocused.topInfo.bottom - 1, { topInfo: expandedFocused.topInfo, composer: expandedFocused.composer });
  assertCheck(checks, "长文本输入区没有超出移动视口", expandedFocused.composer.bottom <= viewport.height + 1 && expandedFocused.composer.height < viewport.height - expandedFocused.topInfo.height, expandedFocused.composer);
  assertCheck(checks, "长文本聚焦不触发页面整体滚动", expandedFocused.bodyScroll.x === 0 && expandedFocused.bodyScroll.y === 0, expandedFocused.bodyScroll);

  await evaluate(client, js`
    (() => {
      const results = document.querySelector("section[aria-label='图片生成区域'] > div");
      results?.scrollBy({ top: 180, left: 0 });
    })()
  `);
  await delay(150);
  const afterMiddleScroll = await evaluate(client, js`
    (() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        topInfo: rect(document.querySelector("section[aria-label='页面信息']")),
        composer: rect(document.querySelector("textarea[placeholder='输入你想要生成的画面']")?.closest("section[aria-label='输入区域']")?.querySelector(":scope > div")),
        bodyScroll: { x: scrollX, y: scrollY },
      };
    })()
  `);
  assertCheck(checks, "滚动中间区域不移动顶部", Math.abs(afterMiddleScroll.topInfo.top - expandedFocused.topInfo.top) <= 1, { before: expandedFocused.topInfo, after: afterMiddleScroll.topInfo });
  assertCheck(checks, "滚动中间区域不移动输入区", Math.abs(afterMiddleScroll.composer.top - expandedFocused.composer.top) <= 1, { before: expandedFocused.composer, after: afterMiddleScroll.composer });
  assertCheck(checks, "中间区域滚动不触发页面整体滚动", afterMiddleScroll.bodyScroll.x === 0 && afterMiddleScroll.bodyScroll.y === 0, afterMiddleScroll.bodyScroll);

  await evaluate(client, js`
    (() => {
      document.querySelector("textarea[placeholder='输入你想要生成的画面']")?.blur();
    })()
  `);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 195, y: 520 }],
  });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await delay(250);
  await capture(client, join(auditDir, "06-restored-bottom.png"));
  const restoredBottom = await evaluate(client, js`
    (() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      };
      const textarea = document.querySelector("textarea[placeholder='输入你想要生成的画面']");
      const composer = textarea?.closest("section[aria-label='输入区域']")?.querySelector(":scope > div");
      const topInfo = document.querySelector("section[aria-label='页面信息']");
      const results = document.querySelector("section[aria-label='图片生成区域']");
      const sendButton = composer?.querySelector("button[aria-label='生成图片']");
      const polishButton = composer ? Array.from(composer.querySelectorAll("button")).find((el) => el.textContent.includes("AI润色")) : null;
      const sendStyle = sendButton ? getComputedStyle(sendButton) : null;
      const forbiddenEnglish = /\\b(network error|failed to fetch|error code|this device is already bound|already bound|unauthorized|forbidden)\\b/i;
      const visibleText = Array.from(document.querySelectorAll("body *"))
        .filter((el) => {
          const style = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && r.width > 0 && r.height > 0;
        })
        .map((el) => el.textContent || "")
        .join("\\n");
      const visibleElements = Array.from(document.querySelectorAll("body *"))
        .filter((el) => {
          const style = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && r.width > 0 && r.height > 0;
        })
        .map((el) => rect(el))
        .filter(Boolean);
      const overflowing = visibleElements.filter((r) => r.left < -2 || r.right > innerWidth + 2);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        topInfo: rect(topInfo),
        results: rect(results),
        composer: rect(composer),
        sendButton: rect(sendButton),
        polishButton: rect(polishButton),
        sendBorderRadius: sendStyle?.borderRadius || "",
        documentSize: {
          scrollWidth: document.scrollingElement?.scrollWidth || document.documentElement.scrollWidth,
          clientWidth: document.scrollingElement?.clientWidth || document.documentElement.clientWidth,
        },
        overflowingCount: overflowing.length,
        overflowingSample: overflowing.slice(0, 5),
        forbiddenEnglishFound: forbiddenEnglish.test(visibleText),
        bodyScroll: { x: scrollX, y: scrollY },
      };
    })()
  `);
  assertCheck(checks, "点击输入区外后底部区域回到底部", rectOk(restoredBottom.composer) && Math.abs(restoredBottom.composer.bottom - restoredBottom.viewport.height) <= 2, restoredBottom.composer);
  assertCheck(checks, "页面没有横向滚动宽度", restoredBottom.documentSize.scrollWidth <= restoredBottom.documentSize.clientWidth + 2, restoredBottom.documentSize);
  assertCheck(checks, "可见元素没有横向溢出", restoredBottom.overflowingCount === 0, { count: restoredBottom.overflowingCount, sample: restoredBottom.overflowingSample });
  assertCheck(checks, "发送按钮保持圆形", rectOk(restoredBottom.sendButton) && Math.abs(restoredBottom.sendButton.width - restoredBottom.sendButton.height) <= 1 && Number.parseFloat(restoredBottom.sendBorderRadius) >= restoredBottom.sendButton.height / 2 - 1, { rect: restoredBottom.sendButton, borderRadius: restoredBottom.sendBorderRadius });
  assertCheck(checks, "AI润色按钮固定在输入框右下角", rectOk(restoredBottom.polishButton) && restoredBottom.polishButton.right <= restoredBottom.composer.right - 8 && restoredBottom.polishButton.bottom <= restoredBottom.composer.bottom - 64 && restoredBottom.polishButton.left > restoredBottom.composer.left + restoredBottom.composer.width * 0.62, { polish: restoredBottom.polishButton, composer: restoredBottom.composer });
  assertCheck(checks, "页面没有出现常见英文错误文案", !restoredBottom.forbiddenEnglishFound, { forbiddenEnglishFound: restoredBottom.forbiddenEnglishFound });

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 195, y: Math.max(55, Math.min(120, restoredBottom.topInfo.top + 18)) }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 195, y: Math.max(220, Math.min(760, restoredBottom.topInfo.top + 360)) }],
  });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await delay(160);
  const afterTopDrag = await evaluate(client, js`
    (() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        topInfo: rect(document.querySelector("section[aria-label='页面信息']")),
        composer: rect(document.querySelector("textarea[placeholder='输入你想要生成的画面']")?.closest("section[aria-label='输入区域']")?.querySelector(":scope > div")),
        bodyScroll: { x: scrollX, y: scrollY },
      };
    })()
  `);
  assertCheck(checks, "拖动顶部固定区域不移动顶部", Math.abs(afterTopDrag.topInfo.top - restoredBottom.topInfo.top) <= 1, { before: restoredBottom.topInfo, after: afterTopDrag.topInfo });
  assertCheck(checks, "拖动顶部固定区域不影响底部", Math.abs(afterTopDrag.composer.bottom - restoredBottom.composer.bottom) <= 1, { before: restoredBottom.composer, after: afterTopDrag.composer });
  assertCheck(checks, "拖动顶部固定区域不触发页面滚动", afterTopDrag.bodyScroll.x === 0 && afterTopDrag.bodyScroll.y === 0, afterTopDrag.bodyScroll);

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 330, y: Math.max(720, restoredBottom.composer.bottom - 36) }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 40, y: Math.max(720, restoredBottom.composer.bottom - 36) }],
  });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await delay(160);
  const afterBottomDrag = await evaluate(client, js`
    (() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      };
      return {
        topInfo: rect(document.querySelector("section[aria-label='页面信息']")),
        composer: rect(document.querySelector("textarea[placeholder='输入你想要生成的画面']")?.closest("section[aria-label='输入区域']")?.querySelector(":scope > div")),
        bodyScroll: { x: scrollX, y: scrollY },
        documentSize: {
          scrollWidth: document.scrollingElement?.scrollWidth || document.documentElement.scrollWidth,
          clientWidth: document.scrollingElement?.clientWidth || document.documentElement.clientWidth,
        },
      };
    })()
  `);
  assertCheck(checks, "横向拖动底部区域不移动底部", Math.abs(afterBottomDrag.composer.left - restoredBottom.composer.left) <= 1 && Math.abs(afterBottomDrag.composer.right - restoredBottom.composer.right) <= 1, { before: restoredBottom.composer, after: afterBottomDrag.composer });
  assertCheck(checks, "横向拖动底部区域不触发页面偏移", afterBottomDrag.bodyScroll.x === 0 && afterBottomDrag.bodyScroll.y === 0 && afterBottomDrag.documentSize.scrollWidth <= afterBottomDrag.documentSize.clientWidth + 2, { bodyScroll: afterBottomDrag.bodyScroll, documentSize: afterBottomDrag.documentSize });

  const ratioMenu = await evaluate(client, js`
    (() => {
      const composer = document.querySelector("textarea[placeholder='输入你想要生成的画面']")?.closest("section[aria-label='输入区域']")?.querySelector(":scope > div");
      const ratioButton = composer ? Array.from(composer.querySelectorAll("button")).find((el) => /未指定|\\d+:\\d+/.test(el.textContent || "")) : null;
      ratioButton?.click();
      return Boolean(ratioButton);
    })()
  `);
  await delay(250);
  await capture(client, join(auditDir, "07-ratio-menu.png"));
  const ratioMenuState = await evaluate(client, js`
    (() => {
      const content = document.querySelector("[data-radix-popper-content-wrapper]");
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      };
      const optionButtons = Array.from(content?.querySelectorAll("button") || []).filter((button) => /未指定|\\d+:\\d+/.test(button.textContent || ""));
      const buttonsWithThumb = optionButtons.filter((button) => {
        const thumbBox = button.querySelector("span[aria-hidden='true']");
        const thumb = thumbBox?.querySelector("span");
        const thumbRect = thumb?.getBoundingClientRect();
        return thumbRect && thumbRect.width >= 8 && thumbRect.height >= 8;
      });
      return {
        triggerFound: ${ratioMenu ? "true" : "false"},
        content: rect(content),
        optionCount: optionButtons.length,
        thumbnailCount: buttonsWithThumb.length,
      };
    })()
  `);
  assertCheck(checks, "比例菜单可以打开", ratioMenuState.triggerFound && rectOk(ratioMenuState.content), ratioMenuState);
  assertCheck(checks, "每个比例选项都有右侧缩略图", ratioMenuState.optionCount >= 10 && ratioMenuState.thumbnailCount === ratioMenuState.optionCount, ratioMenuState);

  const failed = checks.filter((item) => !item.pass);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    failed,
    checks,
    screenshots: auditDir,
  }, null, 2));
} finally {
  client?.close();
  chrome.kill();
  await delay(500);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}
