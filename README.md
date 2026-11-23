# t3code-tray-patch

给 Windows 版 [T3 Code](https://github.com/pingdotgg/t3code) 桌面应用加上两个功能：

- **关闭窗口时最小化到托盘**：点 × 或按 Alt+F4 只隐藏窗口，T3 Code 和正在跑的会话继续在后台运行。单击托盘图标恢复窗口。
- **开机自启**：登录 Windows 后自动启动，直接待在托盘里，不弹窗口。

两个开关在 T3 Code 的 **设置 → 通用**，「退出快捷键」下面：

| 设置 | 默认 |
| --- | --- |
| 关闭窗口时最小化到托盘 | 开 |
| 开机自启 | 关 |

托盘图标单击显示窗口，右键菜单里有「显示」和「退出」。

设置页的两行和托盘菜单支持中文和英文，跟随 T3 Code 里选的界面语言，切换语言后立即生效。打补丁脚本的提示在中文系统上显示中文，其他系统显示英文。

这是非官方补丁，和 T3 Tools 没有关系。官方目前不接受外部功能 PR，所以用补丁的方式先用上。

## 用法

1. 下载本仓库（Code → Download ZIP），解压到 **T3 Code 安装目录以外** 的地方，例如 `C:\Users\<你>\scripts\t3code-tray-patch`。
2. 完全退出 T3 Code（Ctrl+Q，或 文件 → 退出）。
3. 双击 `apply-tray-patch.cmd`，看到“已打上托盘补丁”即可。
4. 重新打开 T3 Code，到 设置 → 通用 按需打开“开机自启”。

**T3 Code 每次自动更新后补丁会被覆盖**，重复第 2、3 步即可。脚本会识别已经打过补丁的版本，重复运行没有副作用。

要还原成原版，退出 T3 Code 后双击 `restore-original.cmd`。如果开过“开机自启”，先在设置里关掉，或者到任务管理器的“启动应用”里关掉。

## 它做了什么

T3 Code 默认装在 `%LOCALAPPDATA%\Programs\t3code`。补丁只改 `resources\app.asar` 里的主进程文件 `apps/desktop/dist-electron/main.cjs`，其他文件逐字节保持不变：

- 在 `main.cjs` 开头加入托盘逻辑（标记为 `[tray-patch v6]`）。
- 设置页面本身没有改。窗口加载后，补丁往页面里插入两行设置，外观复制自 T3 Code 自己的「终端关闭确认」那一行，切换结果通过一条带固定前缀的控制台消息传回主进程。
- 主窗口的 `close` 事件里，托盘图标存在且开着“最小化到托盘”时，改成隐藏窗口。退出、更新和 Windows 注销关机时照常关闭。
- 开机自启用 Electron 的 `app.setLoginItemSettings` 写入当前用户的启动项，带 `--tray-patch-hidden` 参数；带这个参数启动时跳过第一次显示窗口。
- “最小化到托盘”的开关保存在 T3 Code 数据目录下的 `tray-patch.json`，“开机自启”直接读写 Windows 的启动项。

第一次打补丁时原文件备份为 `resources\app.asar.bak`。脚本用 T3 Code 自己的可执行文件当 Node 运行（`ELECTRON_RUN_AS_NODE=1`），不需要另装 Node。

如果新版 T3 Code 改了补丁依赖的代码，脚本会提示“补丁对不上”并且不做任何修改。

## 开发

```
node --test
```

测试用一个合成的 asar 覆盖打补丁、从旧版补丁升级、还原、拒绝不认识的版本，并用假的 Electron 对象测试托盘逻辑和设置页通道。

---

## English

An unofficial patch for the Windows build of the T3 Code desktop app. It adds **close to tray** and **launch at login (start in tray)**, as two switches in Settings → General, below "Quit shortcut". The tray icon shows the window on click; its menu has Show and Quit. The new text follows T3 Code's interface language (Chinese or English for now). Quit T3 Code, run `apply-tray-patch.cmd`, and reopen it. Re-run after every T3 Code update; `restore-original.cmd` undoes it. Only `main.cjs` inside `resources\app.asar` changes, and the original is kept as `app.asar.bak`.

MIT License.

## 友情链接

- [LINUX DO](https://linux.do)：新的理想型社区
