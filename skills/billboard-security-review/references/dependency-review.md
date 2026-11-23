# BillBoard npm 依赖安全审查

执行[通用 npm 依赖安全审查](../../security-review/references/dependency-review.md)，并应用以下 BillBoard 规则。

- 根项目和 `desktop` 各有独立的 `package-lock.json`。覆盖受影响的安装入口，包括发布或 CI 实际使用的锁文件。
- 正式交付按 [AGENTS.md](../../../AGENTS.md) 第 6 节执行全量验证，保留原始失败及补跑证据。
