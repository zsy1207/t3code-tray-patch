// Adds "close to tray" and "launch at login" to an installed T3 Code on Windows by editing
// apps/desktop/dist-electron/main.cjs inside resources\app.asar. Every other file in the
// archive keeps its exact bytes. Run it through apply-tray-patch.cmd or restore-original.cmd,
// which use T3 Code's own executable as Node (ELECTRON_RUN_AS_NODE=1).
"use strict";
process.noAsar = true;
let fs;
try {
  fs = require("original-fs");
} catch {
  fs = require("fs");
}
const crypto = require("crypto");

const MAIN = "apps/desktop/dist-electron/main.cjs";
const MARKER = "[tray-patch v6]";
const ANY_MARKER = "[tray-patch";

/** Text for the Settings rows and the tray menu, in the languages the patch supports. */
const STRINGS = {
  en: {
    closeToTray: [
      "Close to tray",
      "Closing the window keeps T3 Code running in the notification area. Quit from the tray icon's menu.",
    ],
    launchAtLogin: ["Launch at login", "Start T3 Code in the notification area when you sign in to Windows."],
    show: "Show {name}",
    quit: "Quit {name}",
  },
  zh: {
    closeToTray: [
      "关闭窗口时最小化到托盘",
      "点窗口的关闭按钮时收到系统托盘，T3 Code 继续在后台运行。要退出请用托盘图标的右键菜单。",
    ],
    launchAtLogin: ["开机自启", "登录 Windows 后自动启动 T3 Code，直接待在托盘里，不弹出窗口。"],
    show: "显示 {name}",
    quit: "退出 {name}",
  },
};

/**
 * Runs inside T3 Code's window (via webContents.executeJavaScript). Adds two switches to
 * Settings → General right after "Quit shortcut", built from the markup of T3 Code's own
 * "terminal close confirmation" row so they match the page. The text follows the app's
 * language (<html lang>) and changes with it. Switch changes and the language go back to
 * the main process as console messages that start with messagePrefix.
 */
function settingsPage(initialState, messagePrefix, strings) {
  if (window.__t3TrayPatch) {
    window.__t3TrayPatch.setState(initialState);
    return;
  }
  let state = initialState;
  const rows = [
    { key: "closeToTray", id: "tray-patch-close-to-tray" },
    { key: "launchAtLogin", id: "tray-patch-launch-at-login" },
  ];
  const language = () => document.documentElement.lang || navigator.language || "";
  const text = () => (language().toLowerCase().startsWith("zh") ? strings.zh : strings.en);
  const send = (message) => console.info(messagePrefix + JSON.stringify(message));
  const paint = (row, on) => {
    const control = row.querySelector('[role="switch"]');
    if (!control) return;
    control.setAttribute("aria-checked", on ? "true" : "false");
    for (const node of [control, ...control.querySelectorAll("*")]) {
      node.toggleAttribute("data-checked", on);
      node.toggleAttribute("data-unchecked", !on);
    }
  };
  const label = (row, spec) => {
    const [title, description] = text()[spec.key];
    const heading = row.querySelector("h3");
    if (heading) heading.textContent = title;
    const paragraph = row.querySelector("p");
    if (paragraph) paragraph.textContent = description;
    const control = row.querySelector('[role="switch"]');
    if (control) control.setAttribute("aria-label", title);
  };
  const build = (template, spec) => {
    const row = template.cloneNode(true);
    for (const node of row.querySelectorAll("input")) node.remove();
    for (const node of [row, ...row.querySelectorAll("[id], [for], [aria-labelledby], [aria-describedby]")]) {
      for (const name of ["id", "for", "aria-labelledby", "aria-describedby"]) node.removeAttribute(name);
    }
    row.id = spec.id;
    const heading = row.querySelector("h3");
    if (heading) {
      for (const slot of heading.parentElement.querySelectorAll(":scope > span")) slot.replaceChildren();
    }
    label(row, spec);
    const control = row.querySelector('[role="switch"]');
    const toggle = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = !state[spec.key];
      state = { ...state, [spec.key]: next };
      paint(row, next);
      send({ [spec.key]: next });
    };
    control.addEventListener("click", toggle);
    control.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") toggle(event);
    });
    paint(row, state[spec.key]);
    return row;
  };
  const inject = () => {
    if (document.getElementById(rows[0].id)) return;
    const template = document.getElementById("terminal-close-confirmation");
    if (!template || !template.querySelector('[role="switch"]')) return;
    let after = document.getElementById("quit-confirmation") || template;
    for (const spec of rows) {
      const row = build(template, spec);
      after.after(row);
      after = row;
    }
  };
  // The desktop app routes by the URL hash, so look for the page's rows instead of the path.
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled || document.getElementById(rows[0].id) || !document.getElementById("terminal-close-confirmation")) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      inject();
    });
  }).observe(document.body, { childList: true, subtree: true });
  new MutationObserver(() => {
    for (const spec of rows) {
      const row = document.getElementById(spec.id);
      if (row) label(row, spec);
    }
    send({ language: language() });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  window.__t3TrayPatch = {
    setState(next) {
      state = next;
      for (const spec of rows) {
        const row = document.getElementById(spec.id);
        if (row) paint(row, state[spec.key]);
      }
    },
  };
  send({ language: language() });
  inject();
}

const TRAY_SNIPPET = `// [tray-patch v6] Close to tray and launch at login. https://github.com/zsy1207/t3code-tray-patch
const __t3Tray = (() => {
	if (process.platform !== "win32") return { shouldHide: () => false, attach: () => {}, deferFirstReveal: () => false };
	const trayFs = require("node:fs");
	const trayPath = require("node:path");
	const HIDDEN_ARG = "--tray-patch-hidden";
	const loginItem = { args: [HIDDEN_ARG] };
	let tray = null;
	let mainWindow = null;
	let displayName = "T3 Code";
	let quitting = false;
	let sessionEnding = false;
	let startHidden = process.argv.includes(HIDDEN_ARG);
	let maximizeOnShow = false;
	let settings = null;
	const STRINGS = ${JSON.stringify(STRINGS)};
	// Follows T3 Code's own language once the page reports it; the system language until then.
	let uiLanguage = null;
	const text = (key) => {
		const language = (uiLanguage || electron.app.getLocale()).toLowerCase();
		return (language.startsWith("zh") ? STRINGS.zh : STRINGS.en)[key].replace("{name}", displayName);
	};
	const settingsFile = () => trayPath.join(electron.app.getPath("userData"), "tray-patch.json");
	const readSettings = () => {
		if (settings === null) {
			settings = { closeToTray: true };
			try {
				Object.assign(settings, JSON.parse(trayFs.readFileSync(settingsFile(), "utf8")));
			} catch {}
		}
		return settings;
	};
	const writeSettings = () => {
		try {
			trayFs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
		} catch (error) {
			console.error("[tray-patch] could not save settings", error);
		}
	};
	const launchesAtLogin = () => {
		const state = electron.app.getLoginItemSettings(loginItem);
		return state.executableWillLaunchAtLogin ?? state.openAtLogin;
	};
	const SETTINGS_PAGE = ${JSON.stringify(String(settingsPage))};
	const SETTINGS_MESSAGE = "__t3_tray_patch__";
	const currentState = () => ({ closeToTray: readSettings().closeToTray, launchAtLogin: launchesAtLogin() });
	const runInPage = (window, code) => {
		if (window === null || window.isDestroyed()) return;
		window.webContents.executeJavaScript(code).catch(() => {});
	};
	const pushState = () => runInPage(mainWindow, "window.__t3TrayPatch && window.__t3TrayPatch.setState(" + JSON.stringify(currentState()) + ")");
	const setCloseToTray = (value) => {
		readSettings().closeToTray = value;
		writeSettings();
		pushState();
	};
	const setLaunchAtLogin = (value) => {
		electron.app.setLoginItemSettings({ ...loginItem, openAtLogin: value });
		pushState();
	};
	electron.app.on("before-quit", () => {
		quitting = true;
	});
	electron.app.on("will-quit", () => {
		if (tray !== null && !tray.isDestroyed()) tray.destroy();
		tray = null;
	});
	const show = () => {
		const window = mainWindow;
		if (window === null || window.isDestroyed()) {
			electron.app.emit("activate");
			return;
		}
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	};
	const buildMenu = () => electron.Menu.buildFromTemplate([
		{ label: text("show"), click: show },
		{ type: "separator" },
		{ label: text("quit"), click: () => electron.app.quit() }
	]);
	const loadIcon = (iconPath) => {
		const image = electron.nativeImage.createFromPath(iconPath);
		if (!image.isEmpty()) return image;
		// Win32 icon loading cannot read inside app.asar; copy the icon out once.
		const copied = trayPath.join(electron.app.getPath("temp"), "t3code-tray.ico");
		trayFs.writeFileSync(copied, trayFs.readFileSync(iconPath));
		return electron.nativeImage.createFromPath(copied);
	};
	return {
		shouldHide: (window) => tray !== null && readSettings().closeToTray && !quitting && !sessionEnding && !window.isDestroyed(),
		attach: (window, iconOption, name) => {
			mainWindow = window;
			displayName = name;
			window.on("session-end", () => {
				sessionEnding = true;
			});
			window.once("show", () => {
				if (!maximizeOnShow) return;
				maximizeOnShow = false;
				window.maximize();
			});
			window.webContents.on("dom-ready", () => {
				runInPage(window, "(" + SETTINGS_PAGE + ")(" + JSON.stringify(currentState()) + "," + JSON.stringify(SETTINGS_MESSAGE) + "," + JSON.stringify(STRINGS) + ")");
			});
			window.webContents.on("console-message", (event, _level, legacyMessage) => {
				const message = typeof legacyMessage === "string" ? legacyMessage : event && event.message;
				if (typeof message !== "string" || !message.startsWith(SETTINGS_MESSAGE)) return;
				try {
					const change = JSON.parse(message.slice(SETTINGS_MESSAGE.length));
					if (typeof change.closeToTray === "boolean") setCloseToTray(change.closeToTray);
					if (typeof change.launchAtLogin === "boolean") setLaunchAtLogin(change.launchAtLogin);
					if (typeof change.language === "string" && change.language !== uiLanguage) {
						uiLanguage = change.language;
						if (tray !== null) tray.setContextMenu(buildMenu());
					}
				} catch {}
			});
			if (tray !== null || typeof iconOption.icon !== "string") return;
			try {
				tray = new electron.Tray(loadIcon(iconOption.icon));
				tray.setToolTip(displayName);
				tray.setContextMenu(buildMenu());
				tray.on("click", show);
			} catch (error) {
				tray = null;
				console.error("[tray-patch] could not create the tray icon", error);
			}
		},
		deferFirstReveal: (maximized) => {
			if (!startHidden || tray === null) return false;
			startHidden = false;
			maximizeOnShow = maximized;
			return true;
		}
	};
})();
`;

const IMPORT_ANCHOR = "electron = __toESM(electron, 1);\n";
const ICON_ANCHOR = "const iconOption = getIconOption(";
const CLOSE_ORIGINAL =
  /\n(\t+)window\.on\("close", \(\) => \{\n\t+runFork\(flushBoundsPersist\);\n\t+\}\);\n/g;
const CLOSE_PATCHED =
  /\n(\t+)window\.on\("close", \(event\) => \{\n\t+runFork\(flushBoundsPersist\);\n\t+if \(__t3Tray\.shouldHide\(window\)\) \{\n\t+event\.preventDefault\(\);\n\t+window\.hide\(\);\n\t+\}\n\t+\}\);\n\t+__t3Tray\.attach\(window, iconOption, environment\.displayName\);\n/g;
const REVEAL_ORIGINAL =
  /\n(\t+)if \(persistedSettings\.mainWindowMaximized\) window\.maximize\(\);\n\t+yield\* electronWindow\.reveal\(window\);\n/g;
const REVEAL_PATCHED =
  /\n(\t+)if \(!__t3Tray\.deferFirstReveal\(persistedSettings\.mainWindowMaximized\)\) \{\n\t+if \(persistedSettings\.mainWindowMaximized\) window\.maximize\(\);\n\t+yield\* electronWindow\.reveal\(window\);\n\t+\}\n/g;
const SNIPPET_BLOCK = /\/\/ \[tray-patch[^\n]*\n[\s\S]*?\n\}\)\(\);\n/;

const count = (source, pattern) =>
  typeof pattern === "string" ? source.split(pattern).length - 1 : (source.match(pattern) || []).length;

/** Returns the patched source, or null when this T3 Code build does not have the expected code. */
function patchSource(source) {
  if (
    count(source, IMPORT_ANCHOR) !== 1 ||
    count(source, ICON_ANCHOR) !== 1 ||
    count(source, CLOSE_ORIGINAL) !== 1 ||
    count(source, REVEAL_ORIGINAL) !== 1
  ) {
    return null;
  }
  return source
    .replace(IMPORT_ANCHOR, IMPORT_ANCHOR + TRAY_SNIPPET)
    .replace(CLOSE_ORIGINAL, (_match, indent) =>
      [
        "",
        `${indent}window.on("close", (event) => {`,
        `${indent}\trunFork(flushBoundsPersist);`,
        `${indent}\tif (__t3Tray.shouldHide(window)) {`,
        `${indent}\t\tevent.preventDefault();`,
        `${indent}\t\twindow.hide();`,
        `${indent}\t}`,
        `${indent}});`,
        `${indent}__t3Tray.attach(window, iconOption, environment.displayName);`,
        "",
      ].join("\n"),
    )
    .replace(REVEAL_ORIGINAL, (_match, indent) =>
      [
        "",
        `${indent}if (!__t3Tray.deferFirstReveal(persistedSettings.mainWindowMaximized)) {`,
        `${indent}\tif (persistedSettings.mainWindowMaximized) window.maximize();`,
        `${indent}\tyield* electronWindow.reveal(window);`,
        `${indent}}`,
        "",
      ].join("\n"),
    );
}

/** Undoes any version of this patch; returns null when the result is not clean. */
function unpatchSource(source) {
  const restored = source
    .replace(SNIPPET_BLOCK, "")
    .replace(
      CLOSE_PATCHED,
      (_match, indent) =>
        `\n${indent}window.on("close", () => {\n${indent}\trunFork(flushBoundsPersist);\n${indent}});\n`,
    )
    .replace(
      REVEAL_PATCHED,
      (_match, indent) =>
        `\n${indent}if (persistedSettings.mainWindowMaximized) window.maximize();\n${indent}yield* electronWindow.reveal(window);\n`,
    );
  return restored.includes("__t3Tray") || restored.includes(ANY_MARKER) ? null : restored;
}

function readArchive(file) {
  const buf = fs.readFileSync(file);
  const headerSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString("utf8"));
  return { buf, header, base: 8 + headerSize };
}

function findEntry(header, inner) {
  let node = header;
  for (const part of inner.split("/")) {
    node = node && node.files ? node.files[part] : undefined;
  }
  return node;
}

function readEntry(archive, entry) {
  const start = archive.base + Number(entry.offset);
  return archive.buf.subarray(start, start + entry.size);
}

/** Rewrites the archive with one file replaced; every other file keeps its bytes and order. */
function writeArchive(archive, inner, data) {
  const entries = [];
  (function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files)) {
      const filePath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, filePath);
      else if (!entry.unpacked && !entry.link) entries.push([filePath, entry]);
    }
  })(archive.header, "");
  entries.sort((a, b) => Number(a[1].offset) - Number(b[1].offset));
  const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  const chunks = [];
  let offset = 0;
  for (const [filePath, entry] of entries) {
    let bytes = readEntry(archive, entry);
    if (filePath === inner) {
      bytes = data;
      entry.size = bytes.length;
      if (entry.integrity) {
        const blockSize = entry.integrity.blockSize;
        const blocks = [];
        for (let i = 0; i < bytes.length; i += blockSize) {
          blocks.push(sha(bytes.subarray(i, i + blockSize)));
        }
        entry.integrity = { ...entry.integrity, hash: sha(bytes), blocks };
      }
    }
    entry.offset = String(offset);
    offset += bytes.length;
    chunks.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(archive.header), "utf8");
  const padded = (json.length + 3) & ~3;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, ...chunks]);
}

/** Writes next to the archive, then swaps it in; refuses while T3 Code holds the file open. */
function replaceArchive(asarPath, bytes, backup) {
  const next = `${asarPath}.new`;
  fs.writeFileSync(next, bytes);
  try {
    if (backup) fs.renameSync(asarPath, `${asarPath}.bak`);
    fs.renameSync(next, asarPath);
    return null;
  } catch (error) {
    if (fs.existsSync(next)) fs.unlinkSync(next);
    return error;
  }
}

const PATCH_VERSION = MARKER.match(/v\d+/)[0];

/** What the script prints, in Chinese on a Chinese system and in English elsewhere. */
const MESSAGES = {
  zh: {
    missing: (file) => `找不到 app.asar：${file}`,
    unknownVersion: "未知版本",
    noMain: (v) => `T3 Code ${v}：没找到 ${MAIN}，没有做任何修改。`,
    notPatched: (v) => `T3 Code ${v} 没有打过托盘补丁，不需要还原。`,
    unpatchFailed: (v) => `T3 Code ${v}：没能干净地移除补丁，没有做任何修改。重新安装 T3 Code 可以得到原版。`,
    restoreDryRun: (v) => `T3 Code ${v} 可以还原（--dry-run，未写入）。`,
    restored: (v) =>
      `T3 Code ${v} 已还原为原版。如果开过「开机自启」，T3 Code 仍会开机启动，可在任务管理器的「启动应用」里关掉。`,
    upToDate: (v) => `T3 Code ${v} 已经是最新的托盘补丁，不需要再打。`,
    mismatch: (v) => `T3 Code ${v} 的代码结构变了，补丁对不上（可能官方已经改了这部分），没有做任何修改。`,
    dryRun: (v) => `T3 Code ${v} 可以打补丁（--dry-run，未写入）。`,
    busy: "T3 Code 正在运行，文件被占用。请先从托盘菜单「退出」或按 Ctrl+Q 完全退出 T3 Code，再运行一次。",
    upgraded: (v) => `T3 Code ${v} 的托盘补丁已升级到 ${PATCH_VERSION}。重新打开 T3 Code 即可生效。`,
    applied: (v) => `T3 Code ${v} 已打上托盘补丁，原文件备份为 app.asar.bak。重新打开 T3 Code 即可生效。`,
    where: "两个开关在 设置 → 通用，「退出快捷键」下面。",
  },
  en: {
    missing: (file) => `Can't find app.asar: ${file}`,
    unknownVersion: "(unknown version)",
    noMain: (v) => `T3 Code ${v}: ${MAIN} not found. Nothing was changed.`,
    notPatched: (v) => `T3 Code ${v} isn't patched. Nothing to restore.`,
    unpatchFailed: (v) =>
      `T3 Code ${v}: couldn't remove the patch cleanly. Nothing was changed. Reinstalling T3 Code gives you the original.`,
    restoreDryRun: (v) => `T3 Code ${v} can be restored (--dry-run, nothing written).`,
    restored: (v) =>
      `T3 Code ${v} is back to the original. If you turned on Launch at login, it still starts when you sign in; turn that off under Startup apps in Task Manager.`,
    upToDate: (v) => `T3 Code ${v} already has the latest tray patch.`,
    mismatch: (v) =>
      `T3 Code ${v} changed the code this patch relies on (the feature may be official now). Nothing was changed.`,
    dryRun: (v) => `T3 Code ${v} can be patched (--dry-run, nothing written).`,
    busy: "T3 Code is running and holds the file open. Quit it fully (tray menu → Quit, or Ctrl+Q) and run this again.",
    upgraded: (v) => `T3 Code ${v}: tray patch updated to ${PATCH_VERSION}. Reopen T3 Code to use it.`,
    applied: (v) => `T3 Code ${v} is patched. The original is saved as app.asar.bak. Reopen T3 Code to use it.`,
    where: "The two switches are in Settings → General, below Quit shortcut.",
  },
};

function systemLanguage() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "en";
  }
}

function run(args, log = console.log, language = systemLanguage()) {
  const say = MESSAGES[language] || MESSAGES.en;
  const asarPath = args[0];
  const restore = args.includes("--restore");
  const dryRun = args.includes("--dry-run");
  if (!asarPath || !fs.existsSync(asarPath)) {
    log(say.missing(asarPath));
    return 1;
  }
  const archive = readArchive(asarPath);
  const pkgEntry = findEntry(archive.header, "package.json");
  const version = pkgEntry
    ? JSON.parse(readEntry(archive, pkgEntry).toString("utf8")).version
    : say.unknownVersion;
  const mainEntry = findEntry(archive.header, MAIN);
  if (!mainEntry || mainEntry.unpacked) {
    log(say.noMain(version));
    return 1;
  }
  const source = readEntry(archive, mainEntry).toString("utf8");
  const patchedBefore = source.includes(ANY_MARKER);

  if (restore) {
    if (!patchedBefore) {
      log(say.notPatched(version));
      return 0;
    }
    const original = unpatchSource(source);
    if (original === null) {
      log(say.unpatchFailed(version));
      return 1;
    }
    if (dryRun) {
      log(say.restoreDryRun(version));
      return 0;
    }
    const error = replaceArchive(asarPath, writeArchive(archive, MAIN, Buffer.from(original, "utf8")), false);
    if (error) {
      log(say.busy, `(${error.code || error.message})`);
      return 1;
    }
    log(say.restored(version));
    return 0;
  }

  if (source.includes(MARKER)) {
    log(say.upToDate(version));
    return 0;
  }
  const base = patchedBefore ? unpatchSource(source) : source;
  const patched = base === null ? null : patchSource(base);
  if (patched === null) {
    log(say.mismatch(version));
    return 1;
  }
  if (dryRun) {
    log(say.dryRun(version));
    return 0;
  }
  const error = replaceArchive(asarPath, writeArchive(archive, MAIN, Buffer.from(patched, "utf8")), !patchedBefore);
  if (error) {
    log(say.busy, `(${error.code || error.message})`);
    return 1;
  }
  log(patchedBefore ? say.upgraded(version) : say.applied(version));
  log(say.where);
  return 0;
}

module.exports = { TRAY_SNIPPET, STRINGS, settingsPage, patchSource, unpatchSource, readArchive, writeArchive, findEntry, readEntry, run };

if (require.main === module) process.exitCode = run(process.argv.slice(2));
