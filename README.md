# 小日账

面向 iPhone 的本地个人账本，支持手动记账、两级分类、JPY/CNY 汇总、CSV 和 Excel 导入、离线使用及 JSON 备份。

## 本地预览

在项目目录运行 `python -m http.server 8765 --bind 127.0.0.1 --directory dist`，打开 [本机预览](http://127.0.0.1:8765/)。

## iPhone 使用

在 Safari 打开私有部署链接并登录。选择「分享」→「添加到主屏幕」，开启「作为 Web App 打开」，再从主屏幕打开一次并等待离线应用就绪。正式流水从主屏幕录入，账本和导入文件都在浏览器内处理。「设置与备份」可以导出完整账本到「文件」，或从 JSON 恢复。

### 轻点背面记账

1. 在 iPhone 上打开[屏幕记账快捷指令](https://www.icloud.com/shortcuts/a3f25a035d3344d0b328a22d3a278ace)，按提示添加。
2. 在「设置」→「辅助功能」→「触控」→「轻点背面」→「轻点两下」选择这个快捷指令。
3. 在付款或收款详情页轻点背面两下，再打开小日账。点底部的「粘贴屏幕账单」或右上角扫描图标读取剪贴板。如果 iPhone 弹出系统粘贴确认，点「粘贴」。读取失败时，可在「屏幕记账」的文字框长按粘贴，再点「识别并预填」。
4. 快捷指令可以复制原始截屏文字，也可以复制按「时间：」「金额：」「备注：」分行整理的内容。程序会预填识别出的字段，按历史记录和关键词建议分类，并提示可能重复。金额未注明币种时，请先选择币种，再核对保存。

截屏与文字识别在 iPhone 上进行。小日账在本机解析粘贴的文字，只保存确认时填写的流水字段。

### 导入账单

从右上角导入 CSV、XLSX 或 XLS。预览优先显示表格中能匹配到的分类，其余流水会根据同一商户的历史分类和备注关键词预填。可在确认导入前查看每笔分类。PayPay 的付款和退款分别判重，点预览中的「重复」可以查看匹配的流水。

### 预算、固定账单和商户规则

在「设置 → 常用设置」可以添加总预算、分类预算、固定账单和商户规则。首页显示所选月份的总预算，点开「分类预算」可看各分类的使用情况。到期的固定账单可从首页一键进入核对。固定账单可以按周、月或年重复，每期在核对后入账。也可以从账本点开已有的支出，选择「设为固定账单」。商户规则用于 CSV/Excel 导入和截屏记账，可统一别名并预填分类。

### 备份与清理

在「设置 → 数据与备份」可以导出完整备份、按日期导出或恢复备份。按日期导出可以选择 JSON 备份或 Excel 可打开的 CSV 流水表。CSV 包含原币金额、分类、备注和日元、人民币换算金额。恢复前的预览按日期显示新增、替换和跳过的流水数。恢复时只替换备份中有流水的东京日期。若会与其他日期的现有流水冲突，则跳过受影响的日期。恢复到已有账本时沿用本机的分类和设置，并补入所需的分类。

在「设置 → 数据管理」可以按日期删除流水或清除所有数据。按日期操作可快捷选择整月，也可手动指定起止日，包含东京时间的起止两天。清除所有数据会恢复预设分类和默认设置。

## 开发

应用源码直接放在 `dist/`，可作为静态站点部署，不需要额外构建。推送到 `main` 后，GitHub Actions 会把 `dist/` 发布到 [GitHub Pages](https://silverbullet522.github.io/xiaorizhang/)。发布静态资源变更时同步更新 `dist/sw.js` 的缓存版本和资源清单。汇率使用 Frankfurter v2，Excel 由随应用分发的 SheetJS 解析，分类图标来自 Lucide（ISC，见 `dist/vendor/LICENSE.lucide.txt`）。运行 `node --test` 验证日期、金额、换算、导入和统计逻辑。

### iPhone 原生试用版

试用版支持 iOS 16 及以上，安装包内置应用页面，首次打开即可离线记账。App 和主屏幕 Web App 使用各自的本地账本。迁移时在原版本的「设置 → 数据与备份」导出完整 JSON，再在试用版恢复。

- **Mac**。安装 Node.js 24、pnpm 和 Xcode 26 或更新版本，在仓库根目录执行 `pnpm install --frozen-lockfile`、`pnpm ios:sync`、`pnpm ios:open`。在 Xcode 的「Signing & Capabilities」选自己的 Team，连接并选择 iPhone，然后点运行。iPhone 如有提示，在「设置 → 隐私与安全性」开启开发者模式。免费 Apple 账户用 Personal Team 签名，安装资格每七天到期，可用同一账号和 App 标识重新运行续签。[Apple 真机调试说明](https://help.apple.com/xcode/mac/current/en.lproj/dev5a825a1ca.html)
- **Windows**。从 [Build iPhone trial](https://github.com/silverbullet522/xiaorizhang/actions/workflows/ios-trial.yml) 成功的构建中下载 `Xiaorizhang-iPhone-trial`，解压得到待签名的 `Xiaorizhang-trial.ipa`。可在 Windows 配置 AltStore Classic，将 IPA 传到 iPhone 的「文件」，再从 AltStore 的「My Apps」点 `+` 选择 IPA。免费账户每七天需要续签。[AltStore Windows 安装指南](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)

更新原生试用版时，Mac 上重新执行 `pnpm ios:sync` 后安装。Windows 可在 GitHub Actions 手动运行试用版工作流，下载新 IPA 后用同一个账号覆盖安装。
