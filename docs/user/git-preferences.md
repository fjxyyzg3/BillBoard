> 本文件记录本项目跨会话生效的 Git 工作流偏好。

# Git Preferences

- 基线：使用 `master`，禁止任何删除基线分支的操作。
- Branch/Worktree：落 spec 时创建 feature branch，并绑定 `.worktrees/<branch-name>`；其余任务默认沿用当前工作区，需要隔离已有修改时可创建任务分支和 worktree。允许任务分支提交，修改已提交并满足合并条件后合回 `master`，最终推送和生产重启从 `master` 执行。
- Sync：prepare 时刷新并同步 `origin/master`；最终合并前再次刷新，将任务分支 rebase 到最新 `origin/master`。依据既有需求与代码证据可确定的冲突自动处理；只有无法确定正确语义时才暂停相关操作并询问。
- Commit：按 `AGENTS.md` 第 6 节分层验证。任务分支上的独立工作单元完成后，lint、受影响测试、安全审查及版本同步通过即可作开发检查点提交，记录尚未运行的全量检查；直接在 `master` 提交及最终合入／推送前须全量通过。spec 批准后的 checkpoint 不单独提交，spec 与实现代码归入同一个目标一致的 feature 提交；不为流程额外创建检查点提交。
- Merge：不创建 PR；本任务修改已提交、对应验证与安全审查通过并 rebase 到最新 `origin/master` 后，若可 fast-forward 且不覆盖或夹带已有修改，则自动合回本地 `master`。否则先诊断并尝试安全隔离；无法安全恢复时仅暂停合并及依赖它的推送、发布。
- Push：满足提交条件并合回后只自动推送 `master`，核对远端 SHA 后按 `AGENTS.md` 第 7 节判断是否重启生产；文档-only 不重启，不推送临时任务分支。
- Cleanup：`master` 推送并验证成功后，自动删除干净的任务 worktree 和本地任务分支；失败、未合并或存在未提交修改时全部保留；永不删除 `master`。
- 最后更新：2026-11-13。
