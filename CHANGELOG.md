# Changelog

## 0.9.0

- 公开名改为 `dsh-chat-history-sync`，界面改为「聊天历史同步」
- 覆盖 DeepSeek 账号的网页端 + 手机 App 聊天历史
- profile dependency/bundles/patch/node_modules/设置 section id 全部迁移
- 内部数据目录暂时保留 `.dsh-memory-sync`，账号/token/报告不迁移

## 0.8.76

- 新增「导出诊断（不含 token）」，输出脱敏账号/日志/计数 JSON
- 同名不同内容复查入口显示在设置页与报告正文
- `package.json` 明确 `os: ["win32"]`，避免非 Windows 误装

## 0.8.75

- 同名不同内容不再互相覆盖：会话位置文件名带月份和会话 ID 短码
- 新增 `同名不同内容.md` 与设置页复查计数
- 新增 catalog 回归测试（同名分组/唯一链接）

## 0.8.74

- 同步批次间加 350ms / 账号间 600ms 限速，降低网页端风控概率
- 清理 2026-11 月份会话中的 4 条 runtime 用户消息，避免界面显示成代码段
- 报告/会话健康检查保持 144/144 首 surface

## 0.8.73

- 账号行补「显示名」可见标签
- 删除账号改为行内二次确认，移除浏览器 `window.confirm`
- 待安装时状态行简化为「同步完成 · 待确认安装」，避免与卡片重复
- 报告预览按分类标题/条目/摘要分层显示，去掉原始 Markdown 符号
- 窄屏换行、focus-visible、空状态三步引导

## 0.8.72

- 设置页报告预览去掉 Markdown 标记，改为易读的分组文本
- 窄屏（≤560px）账号行自动换行，输入框全宽
- 同步状态加 `role=status/aria-live`，失败状态显示红色
- 保留「取消」按钮和原生设置风格

## 0.8.71

- 插件详情页补齐 locale `meta.detail` + `docs/preview.svg` 单图，供 DSH 市场展示

## 0.8.70

- 同步请求网络失败自动重试 3 次（指数退避）
- 同步中可点「取消」，结束引擎进程树；不会写半份数据集
- 新增 `npm run check:sessions`：首 surface / seq / 引用范围健康检查

## 0.8.65–0.8.69

- 所有导入会话补 `system/message` 首 surface（144/144），修正 title/sourceEventSeqs/delivery 引用；DSH `sessionPersistence` 实际加载验证通过
- 报告按分类小标题分组（23 类），每条链接下 50–100 字多轮摘要（首问 + 追问 + 助手首句）
- 设置页去掉账号行重复的“待安装”，只保留顶部确认卡
- 打包补 LICENSE、locale/en+zh、icon、docs、files；`npm test` 包级回归 + GitHub Actions
- 历史 config 备份里的明文 token 全部 DPAPI 加密


## 0.8.48

- 账号简称/显示名输入改为失焦或回车提交，支持键盘焦点
- 附件策略/可编辑输入增加 aria-label
- 删除账号二次确认；首次使用空状态说明

## 0.8.47

- 附件预估：设置页显示「预计 N 个附件 · X MB」
- 每日汇总开关；通知分级（普通 Toast 自动消失，失败/待确认才 reminder）

## 0.8.46

- 每日汇总：autoSync 有变化时写 `digest.json`，9:00 后只发一条摘要
- 通知紧急度参数（普通/reminder）

## 0.8.45

- 删除账号二次确认、登录取消、首启空状态

## 0.8.44

- token 使用 Windows DPAPI 加密为 `tokenEnc`，config 不再保存明文
- run-config 用完即删；登录去重只存 SHA-256；登录结果读取后删除

## 0.8.43

- 登录等待时可取消（结束临时 Edge 与保存进程）
- 清理诊断探针

## 0.8.42

- 状态卡显示上次同步/结果；账号行显示健康状态
- 报告默认折叠预览

## 0.8.41

- 通知分级：成功静默、失败/待确认才弹、autoSync 静默
- 通知开关

## 0.8.40

- 8b0f 校验探针（已移除）

## 0.8.39

- 简称/显示名输入改为失焦提交，修复无法输入

## 0.8.38

- 重建 projcache，修复侧栏未命名
- 昵称每 5 秒合并进 config

## 0.8.37

- 回滚 system-head 批量补丁；8b0f 单会话修复

## 0.8.36

- 续聊日志问题定位（system/message 首 surface）
