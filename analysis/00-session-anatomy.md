# 00 会话上下文解剖（2026-10-25T04:46:57.591Z）

来源：`C:\Users\19091\.dsh\sessions\--G-DS-HARNESS--\session-53ece2c2...\session.v4.jsonl.zstd`（24.3 MB 压缩，解压 70.3 MB JSONL）

## 总览

- 事件 31,655 条，覆盖 7 天（2026-10-19, 2026-10-20, 2026-10-21, 2026-10-22, 2026-10-23, 2026-10-24, 2026-10-25）
- 回合 705，步 3736，assistant 消息 3734，工具调用 4117，工具结果 4173
- 压缩 7 次，prune 累计 shadowedToken 221,753
- 内容总字符 16,747,846（含输出侧 reasoning）

## 按类别（字符占比）

| 类别 | 字符 | 占比 |
|---|---:|---:|
| assistant:reasoning(输出侧) | 5,881,574 | 35.1% |
| request_header(固定开销) | 3,839,353 | 22.9% |
| tool_result:pwsh | 2,317,795 | 13.8% |
| tool_call:args | 1,704,993 | 10.2% |
| tool_result:read | 497,484 | 3.0% |
| assistant:text | 409,692 | 2.4% |
| tool_result:web_fetch | 337,371 | 2.0% |
| tool_result:grep | 296,945 | 1.8% |
| user:user | 293,813 | 1.8% |
| tool_result:cross_session_read | 217,535 | 1.3% |
| user:agent-instructions | 124,435 | 0.7% |
| user:runtime-context | 113,998 | 0.7% |
| system/message | 65,284 | 0.4% |
| tool_result:dsh_browser_content | 60,250 | 0.4% |
| tool_result:dsh_browser_a11y | 59,782 | 0.4% |
| user:compact-checkpoint | 52,063 | 0.3% |
| compaction:summary(输出侧) | 49,676 | 0.3% |
| tool_result:edit | 45,858 | 0.3% |
| user:time-context | 41,046 | 0.2% |
| tool_result:dsh_browser_open | 33,588 | 0.2% |
| tool_result:web_search | 28,355 | 0.2% |
| tool_result:history_search | 20,021 | 0.1% |
| tool_result:dsh_browser_execute | 18,748 | 0.1% |
| tool_result:schedule_update | 18,328 | 0.1% |
| tool_result:cross_session_list | 17,310 | 0.1% |
| tool_result:dsh_browser_snapshot | 16,161 | 0.1% |
| user:skill-catalog | 15,851 | 0.1% |
| tool_result:schedule_list | 15,051 | 0.1% |
| tool_result:write | 14,914 | 0.1% |
| tool_result:computer_screenshot | 12,412 | 0.1% |
| tool_result:read_image | 12,296 | 0.1% |
| tool_result:skill | 11,547 | 0.1% |
| user:session-reference | 10,513 | 0.1% |
| tool_result:screenshot_list_windows | 8,083 | 0.0% |
| tool_result:screenshot_capture | 7,264 | 0.0% |
| tool_result:cross_session_send | 7,169 | 0.0% |
| tool_result:history_read | 5,999 | 0.0% |
| tool_result:schedule_create | 5,881 | 0.0% |
| user:schedule | 4,939 | 0.0% |
| tool_result:glob | 4,680 | 0.0% |
| user:tool-jobs | 4,497 | 0.0% |
| tool_result:cross_session_broadcast | 3,997 | 0.0% |
| tool_result:cross_session_spawn | 3,968 | 0.0% |
| tool_result:computer_actions | 3,902 | 0.0% |
| tool_result:cross_session_archive | 3,221 | 0.0% |
| user:subagent-settled | 2,480 | 0.0% |
| tool_result:dsh_browser_get_value | 2,349 | 0.0% |
| tool_result:history_segments | 2,228 | 0.0% |
| tool_result:cross_session_status | 2,195 | 0.0% |
| user:agent-message | 2,148 | 0.0% |
| tool_result:job_output | 1,964 | 0.0% |
| tool_result:load_workspace_dependencies | 1,862 | 0.0% |
| tool_result:computer_windows | 1,696 | 0.0% |
| tool_result:dsh_browser_click | 1,620 | 0.0% |
| tool_result:dsh_browser_list_tabs | 1,396 | 0.0% |
| tool_result:ask_user_question | 1,303 | 0.0% |
| tool_result:cross_session_rename | 990 | 0.0% |
| tool_result:todo_write | 741 | 0.0% |
| tool_result:dsh_im_return_file | 663 | 0.0% |
| tool_result:app_launch | 617 | 0.0% |
| tool_result:dsh_browser_session | 615 | 0.0% |
| tool_result:dsh_browser_wait | 454 | 0.0% |
| tool_result:dsh_browser_screenshot | 424 | 0.0% |
| user:plugin:dsh-im | 421 | 0.0% |
| tool_result:app_env_audit | 346 | 0.0% |
| tool_result:dsh_browser_fill | 338 | 0.0% |
| tool_result:computer_launch | 315 | 0.0% |
| tool_result:? | 312 | 0.0% |
| tool_result:schedule_delete | 305 | 0.0% |
| user:plugin:context-zip | 249 | 0.0% |
| tool_result:dsh_browser_type | 247 | 0.0% |
| tool_result:dsh_browser_close_tab | 231 | 0.0% |
| tool_result:computer_ui | 229 | 0.0% |
| tool_result:computer_click | 216 | 0.0% |
| tool_result:job_list | 194 | 0.0% |
| tool_result:computer_key | 156 | 0.0% |
| tool_result:job_kill | 131 | 0.0% |
| tool_result:cross_session_reply | 120 | 0.0% |
| tool_result:subagent | 106 | 0.0% |
| tool_result:dsh_browser_key | 98 | 0.0% |
| tool_result:present | 85 | 0.0% |
| tool_result:dsh_im_group_history | 84 | 0.0% |
| user:user-approval | 72 | 0.0% |
| tool_result:dsh_browser_reset_session | 67 | 0.0% |
| tool_result:list_agents | 59 | 0.0% |
| tool_result:dsh_browser_set_value | 31 | 0.0% |
| tool_result:dsh_browser_scroll | 27 | 0.0% |
| tool_result:dsh_browser_check | 8 | 0.0% |
| tool_result:dsh_browser_clear | 8 | 0.0% |
| tool_result:notes_write | 4 | 0.0% |
| developer/message | 0 | 0.0% |
| compaction:prune标记 | 0 | 0.0% |

输入侧合计 10,816,596 字符（不含 reasoning 与压缩摘要输出）

## 用户/注入消息来源

| 来源 kind | 条数 | 字符 |
|---|---:|---:|
| user | 905 | 293,813 |
| agent-instructions | 65 | 124,435 |
| runtime-context | 139 | 113,998 |
| compact-checkpoint | 7 | 52,063 |
| time-context | 159 | 41,046 |
| skill-catalog | 9 | 15,851 |
| session-reference | 1 | 10,513 |
| schedule | 9 | 4,939 |
| tool-jobs | 11 | 4,497 |
| subagent-settled | 2 | 2,480 |
| agent-message | 2 | 2,148 |
| plugin:dsh-im | 1 | 421 |
| plugin:context-zip | 1 | 249 |
| user-approval | 1 | 72 |

## 工具结果 Top

| 工具 | 次数 | 字符 | 平均 | 单次最大 |
|---|---:|---:|---:|---:|
| pwsh | 1690 | 2,317,795 | 1,371 | 49,932 |
| read | 383 | 497,484 | 1,299 | 25,845 |
| web_fetch | 79 | 337,371 | 4,271 | 49,932 |
| grep | 43 | 296,945 | 6,906 | 49,932 |
| cross_session_read | 139 | 217,535 | 1,565 | 7,661 |
| dsh_browser_content | 34 | 60,250 | 1,772 | 13,765 |
| dsh_browser_a11y | 50 | 59,782 | 1,196 | 4,456 |
| edit | 591 | 45,858 | 78 | 164 |
| dsh_browser_open | 51 | 33,588 | 659 | 2,801 |
| web_search | 21 | 28,355 | 1,350 | 1,908 |
| history_search | 7 | 20,021 | 2,860 | 4,179 |
| dsh_browser_execute | 61 | 18,748 | 307 | 2,938 |
| schedule_update | 25 | 18,328 | 733 | 1,608 |
| cross_session_list | 24 | 17,310 | 721 | 1,042 |
| dsh_browser_snapshot | 17 | 16,161 | 951 | 1,743 |
| schedule_list | 12 | 15,051 | 1,254 | 3,193 |
| write | 143 | 14,914 | 104 | 133 |
| computer_screenshot | 9 | 12,412 | 1,379 | 1,471 |
| read_image | 74 | 12,296 | 166 | 172 |
| skill | 2 | 11,547 | 5,774 | 6,725 |

## 每日内容增量（字符）

| 日期 | 合计 | 最大类目 |
|---|---:|---|
| 2026-10-19 | 914,805 | assistant:reasoning(输出侧) 408,814 |
| 2026-10-20 | 405,174 | assistant:reasoning(输出侧) 206,905 |
| 2026-10-21 | 1,651,841 | assistant:reasoning(输出侧) 650,525 |
| 2026-10-22 | 3,569,121 | assistant:reasoning(输出侧) 1,436,695 |
| 2026-10-23 | 3,780,963 | assistant:reasoning(输出侧) 1,081,192 |
| 2026-10-24 | 4,239,255 | assistant:reasoning(输出侧) 1,428,575 |
| 2026-10-25 | 2,186,687 | assistant:reasoning(输出侧) 668,868 |

## 单条最大事件 Top20

| 类别 | 字符 | 时间 | 预览 |
|---|---:|---|---|
| request_header(固定开销) | 129,551 | 2026-10-25 00:37 |  |
| request_header(固定开销) | 129,551 | 2026-10-25 01:31 |  |
| request_header(固定开销) | 69,872 | 2026-10-25 00:36 |  |
| request_header(固定开销) | 69,872 | 2026-10-25 11:57 |  |
| request_header(固定开销) | 69,872 | 2026-10-25 12:00 |  |
| request_header(固定开销) | 69,446 | 2026-10-24 02:21 |  |
| request_header(固定开销) | 69,446 | 2026-10-24 02:25 |  |
| request_header(固定开销) | 68,058 | 2026-10-24 23:43 |  |
| request_header(固定开销) | 68,058 | 2026-10-25 00:22 |  |
| request_header(固定开销) | 68,057 | 2026-10-24 23:40 |  |
| request_header(固定开销) | 67,494 | 2026-10-24 02:23 |  |
| request_header(固定开销) | 67,494 | 2026-10-24 02:28 |  |
| request_header(固定开销) | 67,494 | 2026-10-24 02:29 |  |
| request_header(固定开销) | 67,494 | 2026-10-24 02:32 |  |
| request_header(固定开销) | 67,494 | 2026-10-24 02:41 |  |
| request_header(固定开销) | 67,494 | 2026-10-24 12:34 |  |
| request_header(固定开销) | 67,494 | 2026-10-24 15:13 |  |
| request_header(固定开销) | 67,493 | 2026-10-24 19:53 |  |
| request_header(固定开销) | 67,493 | 2026-10-24 21:38 |  |
| request_header(固定开销) | 67,493 | 2026-10-24 21:40 |  |

## 今日（10-25）新增内容

输入侧字符 1,512,801

| 类别 | 字符 |
|---|---:|
| assistant:reasoning(输出侧) | 668,868 |
| request_header(固定开销) | 536,776 |
| tool_call:args | 373,094 |
| tool_result:pwsh | 231,294 |
| tool_result:grep | 128,349 |
| assistant:text | 61,169 |
| tool_result:read | 55,540 |
| user:user | 26,198 |
| tool_result:dsh_browser_open | 17,859 |
| tool_result:computer_screenshot | 12,412 |
| user:runtime-context | 6,650 |
| user:time-context | 5,405 |
| user:compact-checkpoint | 5,359 |
| tool_result:edit | 5,105 |
| compaction:summary(输出侧) | 5,018 |

## 压缩事件

| 时间 | summary 字符 | prune tokens |
|---|---:|---:|
| 2026-10-21 23:31 | 9,570 | 73,666 |
| 2026-10-22 22:27 | 7,483 | 11,642 |
| 2026-10-23 00:42 | 8,646 | 21,509 |
| 2026-10-23 15:17 | 11,640 | 62,022 |
| 2026-10-24 02:39 | 3,413 | 52,914 |
| 2026-10-24 21:40 | 3,906 | 0 |
| 2026-10-25 01:31 | 5,018 | 0 |

## 固定开销与真实 token（对照）

- request/header 最近一次：JSON 69,872 字符，工具 91 个（每次调用都随请求发送）
- 今日（10-25，cost-meter）：678 次调用 / 非缓存输入 934,058 / 缓存读 176,561,407 / 输出 409,037 / 费用 ¥6.10
- **平均每次调用 prompt ≈ (176,561,407+934,058)/678 ≈ 261,793 tokens**
- 今日新增唯一内容 1,512,801 字符 ≈ 840,445 tokens（按 1.8 字符/token 粗估）
- 结论：成本 ≈ 每次调用读一遍上下文 × 调用次数；"新增内容"只占很小一部分。
