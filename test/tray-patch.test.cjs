"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const tool = require("../tray-patch.cjs");

// Values built inside the vm context have that realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const MAIN = "apps/desktop/dist-electron/main.cjs";

// The shape of the bundled main.cjs around the three places the patch touches.
const ORIGINAL_MAIN = [
  'let electron = require("electron");',
  "electron = __toESM(electron, 1);",
  'let node_fs = require("node:fs");',
  'const createWindow = fn("desktop.window.createWindow")(function* () {',
  "\tconst iconOption = getIconOption(yield* assets.iconPaths, environment.platform);",
  "\t\twindow.on(\"resize\", scheduleBoundsPersist);",
  '\t\twindow.on("close", () => {',
  "\t\t\trunFork(flushBoundsPersist);",
  "\t\t});",
  '\t\tif (environment.platform === "darwin") {}',
  "\t\tconst revealWhenReady = gen(function* () {",
  "\t\t\tif (persistedSettings.mainWindowMaximized) window.maximize();",
  "\t\t\tyield* electronWindow.reveal(window);",
  "\t\t\tyield* dismissConnectingSplash;",
  "\t\t});",
  "});",
  "",
].join("\n");

// What the first release of the patch produced.
const V1_MAIN = ORIGINAL_MAIN.replace(
  "electron = __toESM(electron, 1);\n",
  [
    "electron = __toESM(electron, 1);",
    "// [tray-patch] Close the main window to the Windows notification area instead of quitting.",
    "const __t3Tray = (() => {",
    '\tif (process.platform !== "win32") return { shouldHide: () => false, attach: () => {} };',
    "\tlet tray = null;",
    "\treturn { shouldHide: () => tray !== null, attach: () => {} };",
    "})();",
    "",
  ].join("\n"),
).replace(
  '\t\twindow.on("close", () => {\n\t\t\trunFork(flushBoundsPersist);\n\t\t});\n',
  [
    '\t\twindow.on("close", (event) => {',
    "\t\t\trunFork(flushBoundsPersist);",
    "\t\t\tif (__t3Tray.shouldHide(window)) {",
    "\t\t\t\tevent.preventDefault();",
    "\t\t\t\twindow.hide();",
    "\t\t\t}",
    "\t\t});",
    "\t\t__t3Tray.attach(window, iconOption, environment.displayName);",
    "",
  ].join("\n"),
);

function buildArchive(files) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [filePath, content] of Object.entries(files)) {
    const parts = filePath.split("/");
    let node = header;
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} };
      node = node.files[part];
    }
    const name = parts.at(-1);
    if (content === null) {
      node.files[name] = { size: 4, unpacked: true };
      continue;
    }
    const bytes = Buffer.from(content);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    node.files[name] = {
      size: bytes.length,
      offset: String(offset),
      integrity: { algorithm: "SHA256", hash, blockSize: 4194304, blocks: [hash] },
    };
    offset += bytes.length;
    chunks.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(header));
  const padded = (json.length + 3) & ~3;
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([size, pickle, ...chunks]);
}

function readFile(asarPath, inner) {
  const archive = tool.readArchive(asarPath);
  return tool.readEntry(archive, tool.findEntry(archive.header, inner)).toString("utf8");
}

function makeInstall(main) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tray-patch-"));
  const asarPath = path.join(dir, "app.asar");
  fs.writeFileSync(
    asarPath,
    buildArchive({
      "apps/desktop/dist-electron/boot.cjs": "require('./main.cjs');\n",
      [MAIN]: main,
      "apps/desktop/prod-resources/resource-monitor/monitor.exe": null,
      "package.json": JSON.stringify({ name: "t3code", version: "0.1.11" }),
      "zz-last.txt": "after main\n",
    }),
  );
  return asarPath;
}

function runTool(args) {
  const lines = [];
  const code = tool.run(args, (...parts) => lines.push(parts.join(" ")));
  return { code, output: lines.join("\n") };
}

test("patches all three places and reverses cleanly", () => {
  const patched = tool.patchSource(ORIGINAL_MAIN);
  assert.ok(patched.includes("[tray-patch v4]"));
  assert.ok(patched.includes("if (__t3Tray.shouldHide(window)) {"));
  assert.ok(patched.includes("__t3Tray.attach(window, iconOption, environment.displayName);"));
  assert.ok(patched.includes("if (!__t3Tray.deferFirstReveal(persistedSettings.mainWindowMaximized)) {"));
  assert.equal(tool.unpatchSource(patched), ORIGINAL_MAIN);
  assert.equal(tool.unpatchSource(V1_MAIN), ORIGINAL_MAIN);
});

test("refuses a build whose code no longer matches", () => {
  const changed = ORIGINAL_MAIN.replace("runFork(flushBoundsPersist);", "flush();");
  assert.equal(tool.patchSource(changed), null);
});

test("applies to an install, keeps a backup, and leaves other files untouched", () => {
  const asarPath = makeInstall(ORIGINAL_MAIN);
  const before = fs.readFileSync(asarPath);
  const first = runTool([asarPath]);
  assert.equal(first.code, 0, first.output);
  assert.deepEqual(fs.readFileSync(`${asarPath}.bak`), before);
  assert.ok(readFile(asarPath, MAIN).includes("[tray-patch v4]"));
  assert.equal(readFile(asarPath, "zz-last.txt"), "after main\n");
  assert.equal(readFile(asarPath, "package.json"), readFile(`${asarPath}.bak`, "package.json"));
  const unpacked = tool.findEntry(tool.readArchive(asarPath).header, "apps/desktop/prod-resources/resource-monitor/monitor.exe");
  assert.deepEqual(unpacked, { size: 4, unpacked: true });

  const again = runTool([asarPath]);
  assert.equal(again.code, 0);
  assert.match(again.output, /已经是最新的托盘补丁/);
});

test("upgrades an install patched by v1 without replacing the original backup", () => {
  const asarPath = makeInstall(V1_MAIN);
  fs.writeFileSync(`${asarPath}.bak`, "original");
  const result = runTool([asarPath]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /升级到 v4/);
  assert.equal(readFile(asarPath, MAIN), tool.patchSource(ORIGINAL_MAIN));
  assert.equal(fs.readFileSync(`${asarPath}.bak`, "utf8"), "original");
});

test("restores the original main.cjs", () => {
  const asarPath = makeInstall(ORIGINAL_MAIN);
  const original = fs.readFileSync(asarPath);
  runTool([asarPath]);
  const restored = runTool([asarPath, "--restore"]);
  assert.equal(restored.code, 0, restored.output);
  assert.deepEqual(fs.readFileSync(asarPath), original);
});

test("dry runs and unsupported builds write nothing", () => {
  const asarPath = makeInstall(ORIGINAL_MAIN);
  const before = fs.readFileSync(asarPath);
  assert.equal(runTool([asarPath, "--dry-run"]).code, 0);
  assert.deepEqual(fs.readFileSync(asarPath), before);

  const changedPath = makeInstall(ORIGINAL_MAIN.replace("yield* electronWindow.reveal(window);", "show();"));
  const changedBefore = fs.readFileSync(changedPath);
  const result = runTool([changedPath]);
  assert.equal(result.code, 1);
  assert.match(result.output, /补丁对不上/);
  assert.deepEqual(fs.readFileSync(changedPath), changedBefore);
  assert.equal(fs.existsSync(`${changedPath}.bak`), false);
});

function loadTray({ argv = [], locale = "zh-CN", userData }) {
  const app = new EventEmitter();
  app.getLocale = () => locale;
  app.getPath = (name) => (name === "userData" ? userData : os.tmpdir());
  app.loginItems = [];
  app.setLoginItemSettings = (settings) => app.loginItems.push(settings);
  app.getLoginItemSettings = () => {
    const last = app.loginItems.at(-1);
    const on = last ? last.openAtLogin : false;
    return { openAtLogin: on, executableWillLaunchAtLogin: on };
  };
  app.quit = () => app.emit("before-quit");
  const trays = [];
  class Tray extends EventEmitter {
    constructor(image) {
      super();
      this.image = image;
      this.destroyed = false;
      trays.push(this);
    }
    setToolTip(tip) {
      this.tip = tip;
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const electron = {
    app,
    Tray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: (iconPath) => ({ iconPath, isEmpty: () => false }) },
  };
  const context = { electron, require, console, process: { platform: "win32", argv } };
  vm.runInNewContext(`${tool.TRAY_SNIPPET}\nthis.tray = __t3Tray;`, context);
  return { tray: context.tray, app, trays };
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.visible = false;
    this.maximized = false;
    this.webContents = new EventEmitter();
    this.webContents.scripts = [];
    this.webContents.executeJavaScript = (code) => {
      this.webContents.scripts.push(code);
      return Promise.resolve();
    };
  }
  isDestroyed() {
    return false;
  }
  isMinimized() {
    return false;
  }
  show() {
    this.visible = true;
    this.emit("show");
  }
  hide() {
    this.visible = false;
  }
  focus() {}
  maximize() {
    this.maximized = true;
  }
}

const fromPage = (window, change) =>
  window.webContents.emit("console-message", { message: "__t3_tray_patch__" + JSON.stringify(change) });

test("tray: hides on close, menu has only Show and Quit, and Quit closes for real", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "tray-user-"));
  const { tray, app, trays } = loadTray({ userData });
  const window = new FakeWindow();
  tray.attach(window, {}, "T3 Code (Beta)");
  assert.equal(trays.length, 0, "no icon, no tray");
  assert.equal(tray.shouldHide(window), false);

  tray.attach(window, { icon: "C:/T3/icon.ico" }, "T3 Code (Beta)");
  assert.equal(trays.length, 1);
  assert.equal(tray.shouldHide(window), true, "close to tray is on by default");
  assert.deepEqual(plain(trays[0].menu.map((item) => item.label ?? item.type)), [
    "显示 T3 Code (Beta)",
    "separator",
    "退出 T3 Code (Beta)",
  ]);

  trays[0].emit("click");
  assert.equal(window.visible, true, "clicking the icon shows the window");
  window.hide();
  trays[0].menu[0].click();
  assert.equal(window.visible, true, "Show shows the window");

  trays[0].menu[2].click();
  assert.equal(tray.shouldHide(window), false, "closing after Quit really closes");
  app.emit("will-quit");
  assert.equal(trays[0].isDestroyed(), true);
});

test("settings page: injected on load; its switches change behavior and persist", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "tray-user-"));
  const { tray, app } = loadTray({ userData });
  const window = new FakeWindow();
  tray.attach(window, { icon: "C:/T3/icon.ico" }, "T3 Code");

  window.webContents.emit("dom-ready");
  const [injected] = window.webContents.scripts;
  assert.ok(injected.startsWith("(function settingsPage("));
  assert.ok(injected.endsWith(')({"closeToTray":true,"launchAtLogin":false},"__t3_tray_patch__")'));

  fromPage(window, { closeToTray: false });
  assert.equal(tray.shouldHide(window), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, "tray-patch.json"), "utf8")), {
    closeToTray: false,
  });
  window.webContents.emit("console-message", {}, 1, "__t3_tray_patch__" + JSON.stringify({ launchAtLogin: true }));
  assert.deepEqual(plain(app.loginItems), [{ args: ["--tray-patch-hidden"], openAtLogin: true }]);
  assert.match(window.webContents.scripts.at(-1), /setState\(\{"closeToTray":false,"launchAtLogin":true\}\)/, "the page shows the saved state");

  fromPage(window, { closeToTray: "yes" });
  window.webContents.emit("console-message", { message: "unrelated log line" });
  assert.equal(tray.shouldHide(window), false, "ignores malformed and unrelated messages");

  const reloaded = loadTray({ userData });
  const otherWindow = new FakeWindow();
  reloaded.tray.attach(otherWindow, { icon: "C:/T3/icon.ico" }, "T3 Code");
  assert.equal(reloaded.tray.shouldHide(otherWindow), false, "the choice survives a restart");
});

test("launch at login: a hidden start skips the first reveal and restores maximized later", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "tray-user-"));
  const normal = loadTray({ userData });
  const normalWindow = new FakeWindow();
  normal.tray.attach(normalWindow, { icon: "C:/T3/icon.ico" }, "T3 Code");
  assert.equal(normal.tray.deferFirstReveal(true), false, "a normal launch shows the window");

  const atLogin = loadTray({ userData, argv: ["T3 Code.exe", "--tray-patch-hidden"] });
  const window = new FakeWindow();
  assert.equal(atLogin.tray.deferFirstReveal(true), false, "never hides without a tray icon");
  atLogin.tray.attach(window, { icon: "C:/T3/icon.ico" }, "T3 Code");
  assert.equal(atLogin.tray.deferFirstReveal(true), true);
  assert.equal(atLogin.tray.deferFirstReveal(true), false, "only the first reveal is skipped");
  assert.equal(window.visible, false);
  atLogin.trays[0].emit("click");
  assert.equal(window.visible, true);
  assert.equal(window.maximized, true, "restores the saved maximized state");
});
